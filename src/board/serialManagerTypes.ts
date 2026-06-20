export const MANAGER_READY_MARKER = "__MPY_MANAGER_READY__";

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
  host?: string;
  token?: string;
  startupTimeoutMs?: number;
};

export type SerialManagerRuntime = {
  device: string;
  endpoint: SerialManagerEndpoint;
};
