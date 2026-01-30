/**
 * IPC Message Types for mpy_backend communication.
 *
 * This file defines all message types used for JSON-RPC style communication
 * between the TypeScript extension and the Python backend.
 *
 * These types must be kept in sync with the Python types in:
 * src/python/mpy_backend/messages/types.py
 */

// ============================================================================
// Enums
// ============================================================================

/** Message types for IPC communication */
export enum MessageType {
    Command = "command",
    Response = "response",
    Event = "event",
}

/** Command types that can be sent to the backend */
export enum CommandType {
    Connect = "connect",
    Disconnect = "disconnect",
    Execute = "execute",
    Interrupt = "interrupt",
    SoftReboot = "soft_reboot",
    ReadFile = "read_file",
    WriteFile = "write_file",
    ListDir = "list_dir",
    ListSessions = "list_sessions",
    Shutdown = "shutdown",
}

/** Event types that can be received from the backend */
export enum EventType {
    Output = "output",
    StateChanged = "state_changed",
    DeviceConnected = "device_connected",
    DeviceDisconnected = "device_disconnected",
    Error = "error",
}

/** Session states */
export enum SessionState {
    Disconnected = "disconnected",
    Connecting = "connecting",
    Connected = "connected",
    Executing = "executing",
    Error = "error",
}

// ============================================================================
// Command Parameter Types
// ============================================================================

/** Parameters for connect command */
export interface ConnectParams {
    port: string;
    baudrate?: number;
    session_id?: string;
}

/** Parameters for disconnect command */
export interface DisconnectParams {
    session_id: string;
}

/** Parameters for execute command */
export interface ExecuteParams {
    session_id: string;
    code: string;
}

/** Parameters for interrupt command */
export interface InterruptParams {
    session_id: string;
}

/** Parameters for soft reboot command */
export interface SoftRebootParams {
    session_id: string;
}

/** Parameters for read file command */
export interface ReadFileParams {
    session_id: string;
    path: string;
}

/** Parameters for write file command */
export interface WriteFileParams {
    session_id: string;
    path: string;
    content: string;
    encoding?: "utf-8" | "base64";
}

/** Parameters for list directory command */
export interface ListDirParams {
    session_id: string;
    path?: string;
}

/** Parameters for list sessions command */
export interface ListSessionsParams {
    // No parameters needed
}

/** Union type for all command parameters */
export type CommandParams =
    | ConnectParams
    | DisconnectParams
    | ExecuteParams
    | InterruptParams
    | SoftRebootParams
    | ReadFileParams
    | WriteFileParams
    | ListDirParams
    | ListSessionsParams
    | Record<string, unknown>;

// ============================================================================
// Command Message
// ============================================================================

/**
 * Command message sent from TypeScript to Python backend.
 */
export interface CommandMessage {
    type: MessageType.Command;
    id: string;
    command: CommandType;
    params: CommandParams;
}

// ============================================================================
// Response Data Types
// ============================================================================

/** Device information */
export interface DeviceInfo {
    port: string;
    baudrate: number;
    firmware_version?: string;
    device_name?: string;
}

/** Connect response data */
export interface ConnectResponseData {
    session_id: string;
    port: string;
    baudrate: number;
}

/** Disconnect response data */
export interface DisconnectResponseData {
    session_id: string;
    message: string;
}

/** Execute response data */
export interface ExecuteResponseData {
    stdout: string;
    stderr: string;
    success: boolean;
}

/** Interrupt response data */
export interface InterruptResponseData {
    message: string;
}

/** Soft reboot response data */
export interface SoftRebootResponseData {
    message: string;
}

/** File entry in directory listing */
export interface FileEntry {
    name: string;
    type: "file" | "dir";
}

/** Read file response data */
export interface ReadFileResponseData {
    path: string;
    content: string;
    encoding: "utf-8" | "base64";
    size: number;
}

/** Write file response data */
export interface WriteFileResponseData {
    path: string;
    size: number;
    message: string;
}

/** List directory response data */
export interface ListDirResponseData {
    path: string;
    entries: FileEntry[];
}

/** Session info in list sessions response */
export interface SessionInfo {
    session_id: string;
    state: SessionState;
    device_info: DeviceInfo | null;
}

/** List sessions response data */
export interface ListSessionsResponseData {
    sessions: SessionInfo[];
}

/** Error information */
export interface ErrorInfo {
    code: string;
    message: string;
    details?: Record<string, unknown>;
}

/** Generic response data */
export type ResponseData =
    | ConnectResponseData
    | DisconnectResponseData
    | ExecuteResponseData
    | InterruptResponseData
    | SoftRebootResponseData
    | ReadFileResponseData
    | WriteFileResponseData
    | ListDirResponseData
    | ListSessionsResponseData
    | Record<string, unknown>;

// ============================================================================
// Response Message
// ============================================================================

/**
 * Response message from Python backend to TypeScript.
 */
export interface ResponseMessage {
    type: MessageType.Response;
    id: string;
    success: boolean;
    data?: ResponseData;
    error?: ErrorInfo;
}

// ============================================================================
// Event Data Types
// ============================================================================

/** Output event data */
export interface OutputEventData {
    session_id: string;
    data: string;
    stream: "stdout" | "stderr";
}

/** State changed event data */
export interface StateChangedEventData {
    session_id: string;
    old_state: string;
    new_state: string;
}

/** Device connected event data */
export interface DeviceConnectedEventData {
    session_id: string;
    port: string;
    device_info: DeviceInfo;
}

/** Device disconnected event data */
export interface DeviceDisconnectedEventData {
    session_id: string;
    port: string;
    reason: string;
}

/** Error event data */
export interface ErrorEventData {
    session_id: string;
    error: ErrorInfo;
}

/** Union type for all event data */
export type EventData =
    | OutputEventData
    | StateChangedEventData
    | DeviceConnectedEventData
    | DeviceDisconnectedEventData
    | ErrorEventData;

// ============================================================================
// Event Message
// ============================================================================

/**
 * Event message from Python backend to TypeScript (asynchronous).
 */
export interface EventMessage {
    type: MessageType.Event;
    event: EventType;
    data: EventData;
}

// ============================================================================
// Union Types
// ============================================================================

/** Any message that can be received from the backend */
export type BackendMessage = ResponseMessage | EventMessage;

/** Any message that can be sent to the backend */
export type FrontendMessage = CommandMessage;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a message is a response message.
 */
export function isResponseMessage(msg: BackendMessage): msg is ResponseMessage {
    return msg.type === MessageType.Response;
}

/**
 * Check if a message is an event message.
 */
export function isEventMessage(msg: BackendMessage): msg is EventMessage {
    return msg.type === MessageType.Event;
}

/**
 * Check if an event is an output event.
 */
export function isOutputEvent(
    msg: EventMessage
): msg is EventMessage & { data: OutputEventData } {
    return msg.event === EventType.Output;
}

/**
 * Check if an event is a state changed event.
 */
export function isStateChangedEvent(
    msg: EventMessage
): msg is EventMessage & { data: StateChangedEventData } {
    return msg.event === EventType.StateChanged;
}

/**
 * Check if an event is a device connected event.
 */
export function isDeviceConnectedEvent(
    msg: EventMessage
): msg is EventMessage & { data: DeviceConnectedEventData } {
    return msg.event === EventType.DeviceConnected;
}

/**
 * Check if an event is a device disconnected event.
 */
export function isDeviceDisconnectedEvent(
    msg: EventMessage
): msg is EventMessage & { data: DeviceDisconnectedEventData } {
    return msg.event === EventType.DeviceDisconnected;
}

// ============================================================================
// Message Factory
// ============================================================================

let messageIdCounter = 0;

/**
 * Generate a unique message ID.
 */
function generateMessageId(): string {
    return `msg_${Date.now()}_${++messageIdCounter}`;
}

/**
 * Factory for creating command messages.
 */
export const MessageFactory = {
    /**
     * Create a generic command.
     */
    createCommand(command: string, params: Record<string, unknown>): CommandMessage {
        return {
            type: MessageType.Command,
            id: generateMessageId(),
            command: command as CommandType,
            params,
        };
    },

    /**
     * Create a connect command.
     */
    createConnect(params: ConnectParams): CommandMessage {
        return {
            type: MessageType.Command,
            id: generateMessageId(),
            command: CommandType.Connect,
            params,
        };
    },

    /**
     * Create a disconnect command.
     */
    createDisconnect(sessionId: string): CommandMessage {
        return {
            type: MessageType.Command,
            id: generateMessageId(),
            command: CommandType.Disconnect,
            params: { session_id: sessionId },
        };
    },

    /**
     * Create an execute command.
     */
    createExecute(sessionId: string, code: string): CommandMessage {
        return {
            type: MessageType.Command,
            id: generateMessageId(),
            command: CommandType.Execute,
            params: { session_id: sessionId, code },
        };
    },

    /**
     * Create an interrupt command.
     */
    createInterrupt(sessionId: string): CommandMessage {
        return {
            type: MessageType.Command,
            id: generateMessageId(),
            command: CommandType.Interrupt,
            params: { session_id: sessionId },
        };
    },

    /**
     * Create a soft reboot command.
     */
    createSoftReboot(sessionId: string): CommandMessage {
        return {
            type: MessageType.Command,
            id: generateMessageId(),
            command: CommandType.SoftReboot,
            params: { session_id: sessionId },
        };
    },

    /**
     * Create a read file command.
     */
    createReadFile(sessionId: string, path: string): CommandMessage {
        return {
            type: MessageType.Command,
            id: generateMessageId(),
            command: CommandType.ReadFile,
            params: { session_id: sessionId, path },
        };
    },

    /**
     * Create a write file command.
     */
    createWriteFile(
        sessionId: string,
        path: string,
        content: string,
        encoding: "utf-8" | "base64" = "utf-8"
    ): CommandMessage {
        return {
            type: MessageType.Command,
            id: generateMessageId(),
            command: CommandType.WriteFile,
            params: { session_id: sessionId, path, content, encoding },
        };
    },

    /**
     * Create a list directory command.
     */
    createListDir(sessionId: string, path = "/"): CommandMessage {
        return {
            type: MessageType.Command,
            id: generateMessageId(),
            command: CommandType.ListDir,
            params: { session_id: sessionId, path },
        };
    },

    /**
     * Create a list sessions command.
     */
    createListSessions(): CommandMessage {
        return {
            type: MessageType.Command,
            id: generateMessageId(),
            command: CommandType.ListSessions,
            params: {},
        };
    },

    /**
     * Create a shutdown command.
     */
    createShutdown(): CommandMessage {
        return {
            type: MessageType.Command,
            id: generateMessageId(),
            command: CommandType.Shutdown,
            params: {},
        };
    },
};

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize a command message to JSON string.
 */
export function serializeCommand(command: CommandMessage): string {
    return JSON.stringify(command);
}

/**
 * Parse a message from the backend.
 *
 * @param json - JSON string to parse
 * @returns Parsed message
 * @throws Error if JSON is invalid or message type is unknown
 */
export function parseBackendMessage(json: string): BackendMessage {
    const obj = JSON.parse(json);

    if (!obj.type) {
        throw new Error("Missing message type");
    }

    if (obj.type === MessageType.Response) {
        return obj as ResponseMessage;
    }

    if (obj.type === MessageType.Event) {
        return obj as EventMessage;
    }

    throw new Error(`Unknown message type: ${obj.type}`);
}
