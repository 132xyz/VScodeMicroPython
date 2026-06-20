import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { MpRemoteManager } from "./MpRemoteManager";
import {
  cancelManagerOperation,
  ensureManagerStarted,
  getActiveManagerRuntime,
  getManagerClient,
  interruptManager,
  softResetManager,
} from "./serialManager";

type HelperResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
};

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

function managerMethodForFsOp(op: string): string | undefined {
  switch (op) {
    case "stat": return "fs.stat";
    case "listdir": return "fs.listdir";
    case "tree": return "fs.tree";
    case "mkdir": return "fs.mkdir";
    case "remove": return "fs.remove";
    case "rename": return "fs.rename";
    case "write_file": return "fs.writeFile";
    case "read_file": return "fs.readFile";
    case "exec": return "fs.exec";
    default: return undefined;
  }
}

function managerParamsForFsPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const params = { ...payload };
  if (typeof payload.local_path === "string") params.localPath = payload.local_path;
  if (typeof payload.path === "string") params.devicePath = payload.path;
  return params;
}

async function managerCallWithCancellation<T>(
  manager: NonNullable<ReturnType<typeof getManagerClient>>,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  token?: vscode.CancellationToken,
): Promise<T> {
  if (token?.isCancellationRequested) {
    await cancelManagerOperation().catch(() => undefined);
    throw createCancelledError();
  }
  if (!token) {
    return await manager.call<T>(method, params, timeoutMs);
  }

  let cancellation: vscode.Disposable | undefined;
  let cancelled = false;
  const transfer = manager.call<T>(method, params, timeoutMs);
  const cancellationSignal = new Promise<never>((_, reject) => {
    cancellation = token.onCancellationRequested(() => {
      cancelled = true;
      cancelManagerOperation().catch(() => undefined);
      reject(createCancelledError());
    });
  });

  try {
    return await Promise.race([transfer, cancellationSignal]);
  } catch (error) {
    if (cancelled || token.isCancellationRequested) {
      await Promise.race([transfer.catch(() => undefined), sleep(5000)]);
    }
    throw error;
  } finally {
    cancellation?.dispose();
  }
}

async function getFsManager(
  device: string,
  method: string | undefined,
): Promise<NonNullable<ReturnType<typeof getManagerClient>> | undefined> {
  if (!method) return undefined;
  return await getStartedManager(device);
}

async function getStartedManager(
  device: string,
): Promise<NonNullable<ReturnType<typeof getManagerClient>> | undefined> {
  const existing = getManagerClient();
  const runtime = getActiveManagerRuntime();
  if (existing?.connected && runtime?.device === device) return existing;
  await ensureManagerStarted(device);
  const started = getManagerClient();
  return started?.connected ? started : undefined;
}

async function runFs<T>(
  device: string,
  payload: Record<string, unknown>,
  timeoutMs = 30000,
  token?: vscode.CancellationToken,
): Promise<T> {
  if (token?.isCancellationRequested) throw createCancelledError();
  const managerMethod = managerMethodForFsOp(String(payload.op || ""));
  const manager = await getFsManager(device, managerMethod);
  if (manager && managerMethod) {
    return await managerCallWithCancellation<T>(
      manager,
      managerMethod,
      managerParamsForFsPayload(payload),
      timeoutMs,
      token,
    );
  }
  throw new Error(`serial manager is not available for filesystem operation: ${String(payload.op || "")}`);
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
  const manager = await getFsManager(device, "fs.writeFile");
  if (manager) {
    const total = fs.statSync(localPath).size;
    const onManagerProgress = (progress: Record<string, unknown>) => {
      if (progress.path && progress.path !== devicePath) return;
      if (progress.local_path && progress.local_path !== localPath) return;
      onProgress(progressPayloadToEvent(progress));
    };
    onProgress({ localPath, devicePath, bytes: 0, total });
    manager.on("progress", onManagerProgress);
    try {
      await managerCallWithCancellation<void>(
        manager,
        "fs.writeFile",
        managerParamsForFsPayload(payload),
        30 * 60 * 1000,
        token,
      );
      onProgress({ localPath, devicePath, bytes: total, total, done: true });
      return;
    } finally {
      manager.off("progress", onManagerProgress);
    }
  }
  throw new Error("serial manager is not available for filesystem upload");
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
  await ensureManagerStarted(device);
  if (!(await softResetManager())) {
    throw new Error("serial manager is not available for soft reset");
  }
}

export async function interrupt(device: string): Promise<void> {
  await ensureManagerStarted(device);
  if (!(await interruptManager())) {
    throw new Error("serial manager is not available for interrupt");
  }
}
