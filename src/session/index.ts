/**
 * Session module exports.
 */

export {
    DeviceSession,
    DeviceSessionOptions,
    ExecutionResult,
    ReadFileResult,
} from "./DeviceSession";

export {
    SessionManager,
    SessionManagerOptions,
    getSessionManager,
    disposeSessionManager,
} from "./SessionManager";

// Re-export SessionState from backend for convenience
export { SessionState } from "../backend";