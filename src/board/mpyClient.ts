import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { MpRemoteManager } from "./MpRemoteManager";
import {
  clearCustomReplControlFile,
  customReplControlFileExists,
  requestCustomReplRpc,
  sendCustomReplControl,
} from "./customReplControl";

type HelperResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
};

const FS_PROGRESS_MARKER = "__MPYFS_PROGRESS__";
const FS_BUSY_RETRY_DELAY_MS = 150;
const FS_BUSY_RETRY_ATTEMPTS = 20;

export type FileTransferProgress = {
  localPath: string;
  devicePath: string;
  bytes: number;
  total: number;
  done?: boolean;
};

export type DeviceEntry = {
  name: string;
  is_dir?: boolean;
  isDir?: boolean;
  size?: number;
  mtime?: number;
  mode?: number;
};

export type DeviceStat = {
  exists?: boolean;
  mode: number;
  size: number;
  mtime?: number;
  is_dir?: boolean;
  isDir?: boolean;
  is_readonly?: boolean;
  isReadonly?: boolean;
};

export type TreeStat = {
  path: string;
  is_dir?: boolean;
  isDir?: boolean;
  size: number;
  mtime: number;
  mode?: number;
};

function splitCommand(cmd: string): { exe: string; args: string[] } {
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

function getExtensionRoot(): string | null {
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

function getMpyReplScriptPath(): string {
  const extensionRoot = getExtensionRoot();
  if (!extensionRoot) throw new Error("Extension root not found");
  const candidate = path.join(extensionRoot, "scripts", "mpyrepl", "__main__.py");
  if (!fs.existsSync(candidate)) {
    throw new Error(`mpyrepl helper not found: ${candidate}`);
  }
  return candidate;
}

function getBaudRate(): number {
  return vscode.workspace.getConfiguration("microPythonWorkBench").get<number>("baudRate", 115200);
}

async function getPythonCommand(): Promise<{ exe: string; args: string[] }> {
  const pythonPath = await MpRemoteManager.detectPythonPath();
  if (!pythonPath) throw new Error("Python interpreter not found");
  return splitCommand(pythonPath);
}

function parseHelperJson<T>(stdout: string): T {
  const lines = String(stdout || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const jsonLine = [...lines].reverse().find(line => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) {
    throw new Error(`mpyrepl helper did not return JSON: ${stdout}`);
  }
  const parsed = JSON.parse(jsonLine) as HelperResponse<T>;
  if (!parsed.ok) {
    const error = new Error(parsed.error || "mpyrepl helper failed") as Error & { code?: string };
    error.code = parsed.code;
    throw error;
  }
  return parsed.data as T;
}

function progressPayloadToEvent(payload: {
    local_path?: unknown;
    path?: unknown;
    bytes?: unknown;
    total?: unknown;
    done?: unknown;
  }): FileTransferProgress {
  return {
    localPath: String(payload.local_path || ""),
    devicePath: String(payload.path || ""),
    bytes: Number(payload.bytes || 0),
    total: Number(payload.total || 0),
    done: Boolean(payload.done),
  };
}

function parseProgressLine(line: string): FileTransferProgress | null {
  if (!line.startsWith(FS_PROGRESS_MARKER)) return null;
  return progressPayloadToEvent(JSON.parse(line.slice(FS_PROGRESS_MARKER.length)));
}

function createCancelledError(): Error & { code?: string } {
  const error = new Error("Upload cancelled") as Error & { code?: string };
  error.code = "cancelled";
  return error;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runHelper<T>(
  args: string[],
  timeoutMs = 30000,
  token?: vscode.CancellationToken,
): Promise<T> {
  if (token?.isCancellationRequested) throw createCancelledError();
  const python = await getPythonCommand();
  const script = getMpyReplScriptPath();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancellation: vscode.Disposable | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cancellation?.dispose();
      callback();
    };

    const child = execFile(
      python.exe,
      python.args.concat([script]).concat(args),
      { env, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          const stdoutText = String(stdout || "");
          if (stdoutText.split(/\r?\n/).some(line => line.trim().startsWith("{"))) {
            try {
              parseHelperJson<T>(stdoutText);
            } catch (parseError) {
              finish(() => reject(parseError));
              return;
            }
          }
          finish(() => reject(new Error(String(stderr || error.message || error))));
          return;
        }
        try {
          const result = parseHelperJson<T>(String(stdout || ""));
          finish(() => resolve(result));
        } catch (parseError) {
          finish(() => reject(parseError));
        }
      },
    );

    const cancel = () => {
      try {
        child.kill();
      } catch {
        // ignore process termination errors
      }
      finish(() => reject(createCancelledError()));
    };

    if (token) {
      if (token.isCancellationRequested) {
        cancel();
        return;
      }
      cancellation = token.onCancellationRequested(cancel);
    }
  });
}

async function runHelperWithProgress<T>(
  args: string[],
  onProgress: (event: FileTransferProgress) => void,
  idleTimeoutMs = 120000,
  token?: vscode.CancellationToken,
): Promise<T> {
  if (token?.isCancellationRequested) throw createCancelledError();
  const python = await getPythonCommand();
  const script = getMpyReplScriptPath();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  const childArgs = python.args.concat([script]).concat(args);

  return await new Promise<T>((resolve, reject) => {
    const child = spawn(python.exe, childArgs, { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let stdoutRemainder = "";
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let cancellation: vscode.Disposable | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      cancellation?.dispose();
      callback();
    };

    const resetIdleTimer = () => {
      if (idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error(`mpyrepl helper timed out after ${Math.round(idleTimeoutMs / 1000)}s without transfer progress`)));
      }, idleTimeoutMs);
    };

    const cancel = () => {
      try {
        child.kill();
      } catch {
        // ignore process termination errors
      }
      finish(() => reject(createCancelledError()));
    };

    if (token) {
      if (token.isCancellationRequested) {
        cancel();
        return;
      }
      cancellation = token.onCancellationRequested(cancel);
    }

    const handleStdoutLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;
      try {
        const progress = parseProgressLine(line);
        if (progress) {
          onProgress(progress);
          resetIdleTimer();
          return;
        }
      } catch {
        // Keep malformed progress lines in stdout so the final error includes context.
      }
      stdout += rawLine + "\n";
    };

    resetIdleTimer();
    child.stdout?.on("data", chunk => {
      stdoutRemainder += String(chunk);
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) handleStdoutLine(line);
    });
    child.stderr?.on("data", chunk => {
      stderr += String(chunk);
      resetIdleTimer();
    });
    child.on("error", error => {
      finish(() => reject(error));
    });
    child.on("close", code => {
      if (stdoutRemainder) handleStdoutLine(stdoutRemainder);
      finish(() => {
        if (code !== 0) {
          if (stdout.split(/\r?\n/).some(line => line.trim().startsWith("{"))) {
            try {
              parseHelperJson<T>(stdout);
            } catch (parseError) {
              reject(parseError);
              return;
            }
          }
          reject(new Error(String(stderr || stdout || `mpyrepl helper exited with code ${code}`)));
          return;
        }
        try {
          resolve(parseHelperJson<T>(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      });
    });
  });
}

async function runFsHelper<T>(
  device: string,
  payload: Record<string, unknown>,
  timeoutMs = 30000,
  token?: vscode.CancellationToken,
): Promise<T> {
  return runHelper<T>(buildFsArgs(device, payload), timeoutMs, token);
}

function buildFsArgs(device: string, payload: Record<string, unknown>): string[] {
  const op = String(payload.op || "");
  const args = [
    "--port", device,
    "--baudrate", String(getBaudRate()),
    "fs",
    "--op", op,
  ];

  const append = (flag: string, value: unknown) => {
    if (typeof value === "string" && value.length > 0) args.push(flag, value);
  };
  append("--path", payload.path);
  append("--src", payload.src);
  append("--dst", payload.dst);
  append("--local-path", payload.local_path);
  append("--source", payload.source);
  if (payload.recursive === false) args.push("--no-recursive");
  return args;
}

async function runFs<T>(
  device: string,
  payload: Record<string, unknown>,
  timeoutMs = 30000,
  token?: vscode.CancellationToken,
): Promise<T> {
  if (token?.isCancellationRequested) throw createCancelledError();
  for (let attempt = 0; attempt <= FS_BUSY_RETRY_ATTEMPTS; attempt++) {
    if (customReplControlFileExists(device)) {
      try {
        return await requestCustomReplRpc<T>(device, "fs", payload, {
          timeoutMs,
          token,
          onCancel: () => sendCustomReplControl(device, "interrupt"),
        });
      } catch (error: any) {
        if (error?.code === "busy") {
          if (attempt >= FS_BUSY_RETRY_ATTEMPTS) throw error;
          await sleep(FS_BUSY_RETRY_DELAY_MS);
          continue;
        }
        await clearCustomReplControlFile(device);
      }
    }
    return runFsHelper<T>(device, payload, timeoutMs, token);
  }
  throw new Error("filesystem operation did not complete");
}

export async function listSerialPorts(): Promise<{ port: string; name: string }[]> {
  return runHelper<{ port: string; name: string }[]>(["ports"], 10000);
}

export async function stat(device: string, devicePath: string): Promise<DeviceStat | null> {
  return runFs<DeviceStat | null>(device, { op: "stat", path: devicePath });
}

export async function listdir(device: string, devicePath: string): Promise<DeviceEntry[]> {
  return runFs<DeviceEntry[]>(device, { op: "listdir", path: devicePath });
}

export async function tree(device: string, root: string): Promise<TreeStat[]> {
  return runFs<TreeStat[]>(device, { op: "tree", path: root }, 60000);
}

export async function mkdir(device: string, devicePath: string): Promise<void> {
  await runFs(device, { op: "mkdir", path: devicePath, parents: true });
}

export async function remove(device: string, devicePath: string, recursive = true): Promise<void> {
  await runFs(device, { op: "remove", path: devicePath, recursive }, 60000);
}

export async function rename(device: string, src: string, dst: string): Promise<void> {
  await runFs(device, { op: "rename", src, dst });
}

export async function writeFile(device: string, localPath: string, devicePath: string): Promise<void> {
  await runFs(device, { op: "write_file", local_path: localPath, path: devicePath }, 120000);
}

export async function writeFileWithProgress(
  device: string,
  localPath: string,
  devicePath: string,
  onProgress: (event: FileTransferProgress) => void,
  token?: vscode.CancellationToken,
): Promise<void> {
  const payload = { op: "write_file", local_path: localPath, path: devicePath };
  if (customReplControlFileExists(device)) {
    const total = fs.statSync(localPath).size;
    onProgress({ localPath, devicePath, bytes: 0, total });
    await requestCustomReplRpc<void>(device, "fs", payload, {
      timeoutMs: 30 * 60 * 1000,
      token,
      onCancel: () => sendCustomReplControl(device, "interrupt"),
      onProgress: progress => onProgress(progressPayloadToEvent(progress)),
    });
    onProgress({ localPath, devicePath, bytes: total, total, done: true });
    return;
  }

  const args = buildFsArgs(device, payload);
  args.push("--progress");
  await runHelperWithProgress<void>(args, onProgress, 120000, token);
}

export async function readFile(
  device: string,
  devicePath: string,
  localPath: string,
  token?: vscode.CancellationToken,
): Promise<void> {
  await runFs(device, { op: "read_file", path: devicePath, local_path: localPath }, 120000, token);
}

export async function exec(device: string, source: string): Promise<{ stdout: string; stderr: string }> {
  return runFs<{ stdout: string; stderr: string }>(device, { op: "exec", source }, 30000);
}

export async function softReset(device: string): Promise<void> {
  await runHelper([
    "--port", device,
    "--baudrate", String(getBaudRate()),
    "soft-reset",
  ], 30000);
}

export async function interrupt(device: string): Promise<void> {
  await runHelper([
    "--port", device,
    "--baudrate", String(getBaudRate()),
    "interrupt",
  ], 10000);
}
