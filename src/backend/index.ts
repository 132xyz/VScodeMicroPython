/**
 * Backend module exports.
 *
 * This module provides the interface for communicating with the
 * Python mpy_backend process.
 */

// Message types
export {
    MessageType,
    CommandType,
    EventType,
    SessionState,
    // Command params
    ConnectParams,
    DisconnectParams,
    ExecuteParams,
    InterruptParams,
    SoftRebootParams,
    ReadFileParams,
    WriteFileParams,
    ListDirParams,
    ListSessionsParams,
    CommandParams,
    // Messages
    CommandMessage,
    ResponseMessage,
    EventMessage,
    BackendMessage,
    FrontendMessage,
    // Response data
    DeviceInfo,
    FileEntry,
    ConnectResponseData,
    DisconnectResponseData,
    ExecuteResponseData,
    ReadFileResponseData,
    WriteFileResponseData,
    ListDirResponseData,
    ListSessionsResponseData,
    SessionInfo,
    ErrorInfo,
    ResponseData,
    // Event data
    OutputEventData,
    StateChangedEventData,
    DeviceConnectedEventData,
    DeviceDisconnectedEventData,
    ErrorEventData,
    EventData,
    // Type guards
    isResponseMessage,
    isEventMessage,
    isOutputEvent,
    isStateChangedEvent,
    isDeviceConnectedEvent,
    isDeviceDisconnectedEvent,
    // Factory and utilities
    MessageFactory,
    serializeCommand,
    parseBackendMessage,
} from "./messages";

// IPC Client
export { IPCClient, IPCClientOptions } from "./IPCClient";

// Backend Process
export {
    BackendProcess,
    BackendProcessOptions,
    BackendState,
    getBackendProcess,
    disposeBackendProcess,
} from "./BackendProcess";
