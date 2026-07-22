import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { MpRemoteManager } from "./MpRemoteManager";
import {
  MANAGER_READY_MARKER,
  SerialManagerEndpoint,
  SerialManagerStartOptions,
} from "./serialManagerTypes";

const DEFAULT_STARTUP_RETRY_DELAYS_MS = [250, 750, 1500];

export function splitCommand(cmd: string): { exe: string; args: string[] } {
  if (!cmd.includes('"') && (cmd.includes("\\") || cmd.includes("/")) && cmd.includes(" ")) {
    return { exe: cmd, args: [] };
  }

  const parts: string[] = [];
  const re = /[^\s"]+|"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cmd)) !== null) {
    parts.push(match[1] !== undefined ? match[1] : match[0]);
  }
  if (parts.length === 0) return { exe: cmd, args: [] };
  return { exe: parts[0], args: parts.slice(1) };
}

export function getExtensionRoot(): string | null {
  try {
    const ext = vscode.extensions.getExtension("WebForks.mpy")
      || vscode.extensions.all.find(e => e.id.toLowerCase().endsWith(".mpy"))
      || null;
    if (ext?.extensionPath) return ext.extensionPath;
  } catch {
    // ignore
  }

  try {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return null;
    const candidate = path.join(ws, "VScodeMicroPython");
    return fs.existsSync(path.join(candidate, "scripts", "mpyrepl", "__main__.py")) ? candidate : ws;
  } catch {
    return null;
  }
}

export function getExtensionVersion(): string {
  try {
    const ext = vscode.extensions.getExtension("WebForks.mpy")
      || vscode.extensions.all.find(e => e.id.toLowerCase().endsWith(".mpy"))
      || null;
    const version = ext?.packageJSON?.version;
    if (typeof version === "string" && version.trim()) return version.trim();
  } catch {
    // ignore
  }
  return "unknown";
}

export function getMpyReplScriptPath(): string {
  const extensionRoot = getExtensionRoot();
  if (!extensionRoot) throw new Error("Extension root not found");
  const candidate = path.join(extensionRoot, "scripts", "mpyrepl", "__main__.py");
  if (!fs.existsSync(candidate)) throw new Error(`mpyrepl helper not found: ${candidate}`);
  return candidate;
}

export function quoteShellArg(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function isTransientSerialOpenError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || error || "");
  return /could not open port|PermissionError\(13|Access is denied|拒绝访问|WinError 5|Error 5|device or resource busy|resource busy/i.test(message);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class SerialManagerProcess {
  private child?: ChildProcessWithoutNullStreams;
  private endpoint?: SerialManagerEndpoint;
  private stderr = "";

  get running(): boolean {
    return !!this.child && !this.child.killed;
  }

  get currentEndpoint(): SerialManagerEndpoint | undefined {
    return this.endpoint;
  }

  get currentPid(): number | undefined {
    return this.child?.pid;
  }

  async start(options: SerialManagerStartOptions): Promise<SerialManagerEndpoint> {
    if (this.child && this.endpoint && this.child.exitCode === null && !this.child.killed) {
      return this.endpoint;
    }
    this.child = undefined;
    this.endpoint = undefined;
    const pythonPath = options.pythonPath || await MpRemoteManager.detectPythonPath();
    if (!pythonPath) throw new Error("Python interpreter not found");

    const parsed = splitCommand(pythonPath);
    const scriptPath = options.scriptPath || getMpyReplScriptPath();
    const token = options.token || crypto.randomBytes(24).toString("hex");
    const retryDelays = options.startupRetryDelaysMs ?? DEFAULT_STARTUP_RETRY_DELAYS_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        return await this.startOnce(options, parsed, scriptPath, token);
      } catch (error) {
        lastError = error;
        this.child = undefined;
        this.endpoint = undefined;
        if (attempt >= retryDelays.length || !isTransientSerialOpenError(error)) {
          throw error;
        }
        await sleep(retryDelays[attempt]);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async startOnce(
    options: SerialManagerStartOptions,
    parsed: { exe: string; args: string[] },
    scriptPath: string,
    token: string,
  ): Promise<SerialManagerEndpoint> {
    const args = parsed.args.concat([
      scriptPath,
      "--port",
      options.device,
      "--baudrate",
      String(options.baudRate),
      "manager",
      "--host",
      options.host || "127.0.0.1",
      "--manager-port",
      "0",
      "--token",
      token,
    ]);
    if (options.stubRoot) args.push("--stub-root", options.stubRoot);
    for (const completionRoot of options.completionRoots || []) {
      if (completionRoot) args.push("--completion-root", completionRoot);
    }
    args.push("--helper-version", options.helperVersion || getExtensionVersion());

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    };
    const child = spawn(parsed.exe, args, { env, windowsHide: true });
    this.child = child;
    this.stderr = "";

    return await this.waitForReady(child, token, options.startupTimeoutMs ?? 15000);
  }

  async stop(timeoutMs = 3000, options: { gracefulWaitMs?: number } = {}): Promise<void> {
    const child = this.child;
    this.endpoint = undefined;
    this.child = undefined;
    if (!child) return;
    if (child.exitCode !== null || child.killed) return;
    const gracefulWaitMs = options.gracefulWaitMs ?? timeoutMs;
    if (gracefulWaitMs > 0) {
      try {
        await waitForExit(child, gracefulWaitMs);
        return;
      } catch {
        // Kill below when the manager did not exit after graceful shutdown.
      }
    }
    child.kill();
    if (child.exitCode !== null) return;
    await waitForExit(child, timeoutMs).catch(() => undefined);
  }

  private waitForReady(
    child: ChildProcessWithoutNullStreams,
    token: string,
    timeoutMs: number,
  ): Promise<SerialManagerEndpoint> {
    return new Promise((resolve, reject) => {
      let stdoutBuffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        finish(() => {
          child.kill();
          reject(new Error(`serial manager did not become ready after ${timeoutMs}ms${this.stderr ? `: ${this.stderr}` : ""}`));
        });
      }, timeoutMs);

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.off("error", onError);
        child.off("exit", onExit);
        callback();
      };

      const onStdout = (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const endpoint = parseReadyLine(line, token);
          if (!endpoint) continue;
          this.endpoint = endpoint;
          child.once("exit", () => {
            if (this.child === child) {
              this.child = undefined;
              this.endpoint = undefined;
            }
          });
          finish(() => resolve(endpoint));
          return;
        }
      };
      const onStderr = (chunk: Buffer) => {
        this.stderr += chunk.toString("utf8");
      };
      const onError = (error: Error) => finish(() => reject(error));
      const onExit = (code: number | null) => finish(() => {
        reject(new Error(`serial manager exited before ready with code ${code}${this.stderr ? `: ${this.stderr}` : ""}`));
      });

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.on("error", onError);
      child.on("exit", onExit);
    });
  }
}

export function parseReadyLine(line: string, expectedToken?: string): SerialManagerEndpoint | undefined {
  if (!line.startsWith(MANAGER_READY_MARKER)) return undefined;
  const raw = line.slice(MANAGER_READY_MARKER.length);
  const payload = JSON.parse(raw);
  const host = payload.host;
  const port = payload.port;
  const token = payload.token;
  if (typeof host !== "string" || typeof port !== "number" || typeof token !== "string") {
    throw new Error("serial manager returned an invalid ready payload");
  }
  if (expectedToken && token !== expectedToken) {
    throw new Error("serial manager returned an unexpected token");
  }
  return { host, port, token };
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serial manager did not exit before timeout")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
