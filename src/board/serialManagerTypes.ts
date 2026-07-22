export const MANAGER_READY_MARKER = "__MPY_MANAGER_READY__";
export const SERIAL_MANAGER_PROTOCOL_VERSION = 1;
export const SERIAL_MANAGER_DESCRIPTOR_SCHEMA_VERSION = 1;

export type SerialManagerState =
  | "stopped"
  | "starting"
  | "ready"
  | "busy"
  | "cancelling"
  | "closing"
  | "failed";

export type SerialManagerEndpoint = {
  host: string;
  port: number;
  token: string;
};

export type SerialManagerStatus = {
  state: SerialManagerState | string;
  port?: string;
  baudrate?: number;
  busy?: boolean;
  operation?: string;
  clientCount?: number;
  extensionClientCount?: number;
  replClientCount?: number;
  agentClientCount?: number;
  queuedOperationCount?: number;
  protocolVersion?: number;
};

export type SerialManagerHello = {
  protocolVersion: number;
  managerInstanceId: string;
  role: "extension" | "repl" | "agent";
  capabilities: string[];
  status: SerialManagerStatus;
};

export type SerialManagerDescriptor = {
  schemaVersion: number;
  protocolVersion: number;
  managerInstanceId: string;
  extensionVersion: string;
  device: string;
  host: string;
  port: number;
  token: string;
  managerPid?: number;
  scriptPath: string;
  createdAt: string;
};

export type SerialManagerRpcError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type SerialManagerEvent = {
  event: string;
  payload: Record<string, unknown>;
};

export type SerialManagerStartOptions = {
  device: string;
  baudRate: number;
  pythonPath?: string;
  scriptPath?: string;
  stubRoot?: string;
  completionRoots?: string[];
  helperVersion?: string;
  host?: string;
  token?: string;
  startupTimeoutMs?: number;
  startupRetryDelaysMs?: number[];
};

export type SerialManagerRuntime = {
  device: string;
  endpoint: SerialManagerEndpoint;
  descriptorPath?: string;
};
