import * as vscode from "vscode";
import { SerialManagerClient } from "./serialManagerClient";
import {
  getSerialManagerDescriptorPath,
  readSerialManagerDescriptor,
  removeSerialManagerDescriptor,
  writeSerialManagerDescriptor,
} from "./serialManagerDescriptor";
import { SerialManagerProcess, getExtensionVersion, getMpyReplScriptPath, quoteShellArg, splitCommand } from "./serialManagerProcess";
import {
  SERIAL_MANAGER_DESCRIPTOR_SCHEMA_VERSION,
  SERIAL_MANAGER_PROTOCOL_VERSION,
  SerialManagerDescriptor,
  SerialManagerEndpoint,
  SerialManagerHello,
  SerialManagerRuntime,
  SerialManagerStatus,
} from "./serialManagerTypes";

let activeProcess: SerialManagerProcess | undefined;
let activeClient: SerialManagerClient | undefined;
let activeRuntime: SerialManagerRuntime | undefined;
let activeTransportConnected = false;

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

function publishSerialState(open: boolean, force = false): void {
  if (!force && activeTransportConnected === open) return;
  activeTransportConnected = open;
  setSerialContext(open);
  try {
    void vscode.commands.executeCommand("microPythonWorkBench._serialStateChanged", open);
  } catch {
    // The internal UI command is unavailable during extension shutdown.
  }
}

export function isConnectedManagerState(state: string): boolean {
  return state === "ready" || state === "busy" || state === "cancelling";
}

export function runtimeWithManagerStatus(
  runtime: SerialManagerRuntime | undefined,
  status: SerialManagerStatus,
): SerialManagerRuntime | undefined {
  const nextDevice = typeof status.port === "string" ? status.port.trim() : "";
  if (!runtime || !nextDevice || runtime.device === nextDevice) return runtime;
  return { ...runtime, device: nextDevice };
}

function bindManagerState(
  client: SerialManagerClient,
  descriptorPath: string | undefined,
  token: string,
): void {
  client.on("status", (status: SerialManagerStatus) => {
    if (client !== activeClient) return;
    const previousRuntime = activeRuntime;
    const updatedRuntime = previousRuntime?.endpoint.token === token
      ? runtimeWithManagerStatus(previousRuntime, status)
      : previousRuntime;
    const deviceChanged = updatedRuntime !== previousRuntime;
    if (updatedRuntime) activeRuntime = updatedRuntime;
    if (deviceChanged && updatedRuntime) {
      void import("./mpremote")
        .then(({ setSelectedConnect }) => setSelectedConnect(updatedRuntime.device))
        .catch(() => undefined);
    }
    publishSerialState(isConnectedManagerState(String(status.state || "")), deviceChanged);
  });
  client.on("close", () => {
    if (client !== activeClient) return;
    publishSerialState(false);
    void removeSerialManagerDescriptor(descriptorPath, token);
  });
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
  return !!activeRuntime && !!activeClient?.connected && activeTransportConnected;
}

export function isRecoverableSerialManagerError(error: unknown): boolean {
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError?.code === "transport_lost") return true;
  const message = String(anyError?.message || error || "");
  return /ReadFile failed|WriteFile failed|GetOverlappedResult failed|PortNotOpen|serial connection lost/i.test(message);
}

export async function ensureManagerStarted(device: string): Promise<SerialManagerRuntime> {
  if (activeRuntime?.device === device && activeClient?.connected && activeTransportConnected) {
    return activeRuntime;
  }
  if (activeRuntime || activeClient || activeProcess) {
    await closeManager();
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const descriptorPath = workspaceRoot ? getSerialManagerDescriptorPath(workspaceRoot) : undefined;
  const attached = await attachExistingManager(device, descriptorPath);
  if (attached) return attached;

  const managerProcess = activeProcess || new SerialManagerProcess();
  activeProcess = managerProcess;
  const stubRoot = await getActiveStubPath();
  const endpoint = await managerProcess.start({
    device,
    baudRate: getBaudRate(),
    stubRoot,
    completionRoots: await getActiveCompletionRoots(),
    helperVersion: getExtensionVersion(),
    descriptorPath,
  });
  const client = new SerialManagerClient(endpoint);
  activeClient = client;
  activeRuntime = { device, endpoint, descriptorPath };
  bindManagerState(client, descriptorPath, endpoint.token);
  try {
    await client.connect();
    const hello = await client.call<SerialManagerHello>("manager.hello", { role: "extension" }, 5000);
    if (hello.protocolVersion !== SERIAL_MANAGER_PROTOCOL_VERSION) {
      throw new Error(`Unsupported serial manager protocol: ${hello.protocolVersion}`);
    }
    const status = hello.status;
    publishSerialState(isConnectedManagerState(String(status.state || "")));
    if (descriptorPath) {
      const descriptor: SerialManagerDescriptor = {
        schemaVersion: SERIAL_MANAGER_DESCRIPTOR_SCHEMA_VERSION,
        protocolVersion: SERIAL_MANAGER_PROTOCOL_VERSION,
        managerInstanceId: hello.managerInstanceId,
        extensionVersion: getExtensionVersion(),
        device,
        host: endpoint.host,
        port: endpoint.port,
        token: endpoint.token,
        managerPid: managerProcess.currentPid,
        scriptPath: getMpyReplScriptPath(),
        createdAt: new Date().toISOString(),
      };
      try {
        await writeSerialManagerDescriptor(descriptorPath, descriptor);
      } catch (error) {
        console.warn("[mpy] Failed to publish the serial manager descriptor", error);
      }
    }
    return activeRuntime;
  } catch (error) {
    if (activeClient === client) {
      activeClient = undefined;
      activeRuntime = undefined;
      activeProcess = undefined;
      publishSerialState(false);
    }
    await removeSerialManagerDescriptor(descriptorPath, endpoint.token);
    client.dispose();
    await managerProcess.stop(3000, { gracefulWaitMs: 0 });
    throw error;
  }
}

export function getManagerClient(): SerialManagerClient | undefined {
  return activeClient;
}

export async function getManagerStatus(): Promise<SerialManagerStatus | undefined> {
  if (!activeClient) return undefined;
  const status = await activeClient.call<SerialManagerStatus>("manager.status", {}, 5000);
  publishSerialState(isConnectedManagerState(String(status.state || "")));
  return status;
}

async function attachExistingManager(
  device: string,
  descriptorPath: string | undefined,
): Promise<SerialManagerRuntime | undefined> {
  if (!descriptorPath) return undefined;
  const descriptor = await readSerialManagerDescriptor(descriptorPath);
  if (!descriptor?.token || !descriptor.host || !descriptor.port) return undefined;
  const endpoint: SerialManagerEndpoint = {
    host: descriptor.host,
    port: descriptor.port,
    token: descriptor.token,
  };
  const client = new SerialManagerClient(endpoint);
  try {
    await client.connect();
    const hello = await client.call<SerialManagerHello>("manager.hello", { role: "extension" }, 5000);
    const matches = hello.protocolVersion === SERIAL_MANAGER_PROTOCOL_VERSION
      && hello.managerInstanceId === descriptor.managerInstanceId
      && descriptor.device === device;
    if (!matches) {
      await client.call("manager.shutdown", {}, 3000).catch(() => undefined);
      client.dispose();
      await removeSerialManagerDescriptor(descriptorPath, descriptor.token);
      return undefined;
    }
    activeClient = client;
    activeRuntime = { device, endpoint, descriptorPath };
    activeProcess = undefined;
    bindManagerState(client, descriptorPath, endpoint.token);
    publishSerialState(isConnectedManagerState(String(hello.status?.state || "")));
    return activeRuntime;
  } catch {
    client.dispose();
    await removeSerialManagerDescriptor(descriptorPath, descriptor.token);
    return undefined;
  }
}

export async function closeManager(): Promise<void> {
  const client = activeClient;
  const managerProcess = activeProcess;
  const runtime = activeRuntime;
  let shutdownRequested = false;
  let releaseConfirmed = false;
  activeClient = undefined;
  activeRuntime = undefined;
  activeProcess = undefined;
  publishSerialState(false);
  if (runtime?.endpoint) {
    try {
      await callEndpoint(runtime.endpoint, "manager.shutdown", {}, 3000);
      shutdownRequested = true;
      releaseConfirmed = true;
    } catch {
      // Fall back to process termination below.
    }
  } else if (client?.connected) {
    try {
      await client.call("manager.shutdown", {}, 3000);
      shutdownRequested = true;
      releaseConfirmed = true;
    } catch {
      // Fall back to process termination below.
    }
  }
  if (client?.connected) {
    client.dispose();
  }
  if (managerProcess) {
    await managerProcess.stop(3000, { gracefulWaitMs: shutdownRequested ? 3000 : 0 });
    releaseConfirmed = true;
  }
  if (runtime && releaseConfirmed) {
    await removeSerialManagerDescriptor(runtime.descriptorPath, runtime.endpoint.token);
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
