import * as vscode from "vscode";
import { SerialManagerClient } from "./serialManagerClient";
import { SerialManagerProcess, getMpyReplScriptPath, quoteShellArg, splitCommand } from "./serialManagerProcess";
import {
  SerialManagerEndpoint,
  SerialManagerRuntime,
  SerialManagerStatus,
} from "./serialManagerTypes";

let activeProcess: SerialManagerProcess | undefined;
let activeClient: SerialManagerClient | undefined;
let activeRuntime: SerialManagerRuntime | undefined;

function getBaudRate(): number {
  return vscode.workspace.getConfiguration("microPythonWorkBench").get<number>("baudRate", 115200);
}

function setSerialContext(open: boolean): void {
  try {
    vscode.commands.executeCommand("setContext", "microPythonWorkBench.serialOpen", open);
  } catch {
    // Context updates are best-effort outside the extension host.
  }
}

async function getPythonCommand(): Promise<string> {
  const { MpRemoteManager } = await import("./MpRemoteManager");
  const pythonPath = await MpRemoteManager.detectPythonPath();
  if (!pythonPath) throw new Error("Python interpreter not found");
  return pythonPath;
}

async function getActiveStubPath(): Promise<string | undefined> {
  try {
    const { codeCompletionManager } = await import("../completion/codeCompletion");
    return codeCompletionManager.getActiveStubPath();
  } catch {
    return undefined;
  }
}

async function getActiveCompletionRoots(): Promise<string[]> {
  try {
    const { codeCompletionManager } = await import("../completion/codeCompletion");
    return codeCompletionManager.getActiveCompletionRoots();
  } catch {
    return [];
  }
}

export function getActiveManagerRuntime(): SerialManagerRuntime | undefined {
  return activeRuntime;
}

export function isSerialManagerActive(): boolean {
  return !!activeRuntime && !!activeClient?.connected;
}

export function isRecoverableSerialManagerError(error: unknown): boolean {
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError?.code === "transport_lost") return true;
  const message = String(anyError?.message || error || "");
  return /ReadFile failed|WriteFile failed|GetOverlappedResult failed|PortNotOpen|serial connection lost/i.test(message);
}

export async function ensureManagerStarted(device: string): Promise<SerialManagerRuntime> {
  if (activeRuntime?.device === device && activeClient?.connected) {
    return activeRuntime;
  }
  if (activeRuntime && activeRuntime.device !== device) {
    await closeManager();
  }

  const managerProcess = activeProcess || new SerialManagerProcess();
  activeProcess = managerProcess;
  const stubRoot = await getActiveStubPath();
  const endpoint = await managerProcess.start({
    device,
    baudRate: getBaudRate(),
    stubRoot,
    completionRoots: await getActiveCompletionRoots(),
  });
  const client = new SerialManagerClient(endpoint);
  await client.connect();
  activeClient = client;
  activeRuntime = { device, endpoint };
  setSerialContext(true);
  return activeRuntime;
}

export function getManagerClient(): SerialManagerClient | undefined {
  return activeClient;
}

export async function getManagerStatus(): Promise<SerialManagerStatus | undefined> {
  if (!activeClient) return undefined;
  return await activeClient.call<SerialManagerStatus>("manager.status", {}, 5000);
}

export async function closeManager(): Promise<void> {
  const client = activeClient;
  const managerProcess = activeProcess;
  const runtime = activeRuntime;
  activeClient = undefined;
  activeRuntime = undefined;
  activeProcess = undefined;
  setSerialContext(false);
  if (runtime?.endpoint) {
    try {
      await callEndpoint(runtime.endpoint, "manager.shutdown", {}, 3000);
    } catch {
      // Fall back to process termination below.
    }
  } else if (client?.connected) {
    try {
      await client.call("manager.shutdown", {}, 3000);
    } catch {
      // Fall back to process termination below.
    }
  }
  if (client?.connected) {
    client.dispose();
  }
  if (managerProcess) {
    await managerProcess.stop();
  }
}

export async function buildReplClientCommand(endpoint: SerialManagerEndpoint): Promise<string> {
  const pythonPath = await getPythonCommand();
  const scriptPath = getMpyReplScriptPath();
  const python = splitCommand(pythonPath);
  const args = [
    quoteShellArg(scriptPath),
    "repl-client",
    "--endpoint",
    quoteShellArg(`${endpoint.host}:${endpoint.port}`),
    "--token",
    quoteShellArg(endpoint.token),
  ];
  const base = [quoteShellArg(python.exe), ...python.args.map(quoteShellArg), ...args].join(" ");
  return wrapReplClientCommand(base);
}

export function wrapReplClientCommand(base: string): string {
  if (process.platform === "win32") {
    return `& ${base}; if ($LASTEXITCODE -eq 0) { exit } else { Write-Host ""; Write-Host "[mpyrepl] REPL client exited with code $LASTEXITCODE. Terminal kept open for diagnostics."; }`;
  }
  return `${base}; code=$?; if [ $code -eq 0 ]; then exit; else printf '\\n[mpyrepl] REPL client exited with code %s. Terminal kept open for diagnostics.\\n' "$code"; fi`;
}

export async function executeInManager(source: string): Promise<{ stdout: string; stderr: string }> {
  if (!activeClient) throw new Error("serial manager is not active");
  const runtime = activeRuntime;
  try {
    return await activeClient.call<{ stdout: string; stderr: string }>("repl.exec", { source }, 0);
  } catch (error) {
    if (!runtime || !isRecoverableSerialManagerError(error)) throw error;
    await closeManager();
    await ensureManagerStarted(runtime.device);
    if (!activeClient) throw error;
    return await activeClient.call<{ stdout: string; stderr: string }>("repl.exec", { source }, 0);
  }
}

export async function interruptManager(): Promise<boolean> {
  if (!activeRuntime) return false;
  await callEndpoint(activeRuntime.endpoint, "device.interrupt", {}, 5000);
  return true;
}

export async function softResetManager(): Promise<boolean> {
  if (!activeRuntime) return false;
  await callEndpoint(activeRuntime.endpoint, "device.softReset", {}, 30000);
  return true;
}

export async function cancelManagerOperation(): Promise<boolean> {
  if (!activeRuntime) return false;
  await callEndpoint(activeRuntime.endpoint, "manager.cancel", {}, 5000);
  return true;
}

async function callEndpoint<T = unknown>(
  endpoint: SerialManagerEndpoint,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const client = new SerialManagerClient(endpoint);
  try {
    return await client.call<T>(method, params, timeoutMs);
  } finally {
    client.dispose();
  }
}
