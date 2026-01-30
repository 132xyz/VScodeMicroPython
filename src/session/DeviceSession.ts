/**
 * Device Session for MicroPython devices.
 *
 * Represents a connection to a single MicroPython device,
 * providing high-level APIs for device interaction.
 */

import { EventEmitter } from "events";
import {
    BackendProcess,
    MessageFactory,
    ResponseMessage,
    EventMessage,
    SessionState,
    DeviceInfo,
    ExecuteResponseData,
    ReadFileResponseData,
    WriteFileResponseData,
    ListDirResponseData,
    FileEntry,
    isOutputEvent,
    isStateChangedEvent,
} from "../backend";

/**
 * Options for DeviceSession.
 */
export interface DeviceSessionOptions {
    /** Session ID (auto-generated if not provided) */
    sessionId?: string;
    /** Serial port */
    port: string;
    /** Baud rate */
    baudrate?: number;
}

/**
 * Execution result.
 */
export interface ExecutionResult {
    stdout: string;
    stderr: string;
    success: boolean;
}

/**
 * Read file result.
 */
export interface ReadFileResult {
    content: string;
    encoding: "utf-8" | "base64";
    size: number;
}

/**
 * A session representing a connection to a MicroPython device.
 *
 * Events:
 * - 'output': Device output (stdout/stderr)
 * - 'stateChange': Session state changed
 * - 'error': An error occurred
 * - 'closed': Session was closed
 */
export class DeviceSession extends EventEmitter {
    private backend: BackendProcess;
    private _sessionId: string;
    private _port: string;
    private _baudrate: number;
    private _state: SessionState = SessionState.Disconnected;
    private _deviceInfo: DeviceInfo | null = null;
    private eventHandler: ((event: EventMessage) => void) | null = null;

    /**
     * Create a new device session.
     *
     * @param backend - The backend process to use
     * @param options - Session options
     */
    constructor(backend: BackendProcess, options: DeviceSessionOptions) {
        super();
        this.backend = backend;
        this._sessionId = options.sessionId ?? `session_${Date.now()}`;
        this._port = options.port;
        this._baudrate = options.baudrate ?? 115200;

        this.setupEventHandler();
    }

    /**
     * Get the session ID.
     */
    get sessionId(): string {
        return this._sessionId;
    }

    /**
     * Get the serial port.
     */
    get port(): string {
        return this._port;
    }

    /**
     * Get the baud rate.
     */
    get baudrate(): number {
        return this._baudrate;
    }

    /**
     * Get the current state.
     */
    get state(): SessionState {
        return this._state;
    }

    /**
     * Get device info (available after connect).
     */
    get deviceInfo(): DeviceInfo | null {
        return this._deviceInfo;
    }

    /**
     * Check if the session is connected.
     */
    get isConnected(): boolean {
        return this._state === SessionState.Connected;
    }

    /**
     * Connect to the device.
     *
     * @returns Promise that resolves when connected
     * @throws Error if connection fails
     */
    async connect(): Promise<void> {
        if (this._state !== SessionState.Disconnected) {
            throw new Error(`Cannot connect in state: ${this._state}`);
        }

        this.setState(SessionState.Connecting);

        try {
            const response = await this.backend.sendCommand(
                MessageFactory.createConnect({
                    port: this._port,
                    baudrate: this._baudrate,
                    session_id: this._sessionId,
                })
            );

            if (!response.success) {
                throw new Error(
                    response.error?.message ?? "Connection failed"
                );
            }

            this.setState(SessionState.Connected);
        } catch (error) {
            this.setState(SessionState.Error);
            throw error;
        }
    }

    /**
     * Disconnect from the device.
     */
    async disconnect(): Promise<void> {
        if (this._state === SessionState.Disconnected) {
            return;
        }

        try {
            await this.backend.sendCommand(
                MessageFactory.createDisconnect(this._sessionId)
            );
        } catch {
            // Ignore errors during disconnect
        }

        this.cleanup();
        this.setState(SessionState.Disconnected);
    }

    /**
     * Execute code on the device.
     *
     * @param code - Python code to execute
     * @returns Execution result
     */
    async execute(code: string): Promise<ExecutionResult> {
        this.ensureConnected();

        const response = await this.backend.sendCommand(
            MessageFactory.createExecute(this._sessionId, code)
        );

        if (!response.success) {
            throw new Error(response.error?.message ?? "Execution failed");
        }

        const data = response.data as ExecuteResponseData;
        return {
            stdout: data.stdout,
            stderr: data.stderr,
            success: data.success,
        };
    }

    /**
     * Send an interrupt (Ctrl+C) to the device.
     */
    async interrupt(): Promise<void> {
        this.ensureConnected();

        const response = await this.backend.sendCommand(
            MessageFactory.createInterrupt(this._sessionId)
        );

        if (!response.success) {
            throw new Error(response.error?.message ?? "Interrupt failed");
        }
    }

    /**
     * Perform a soft reboot (Ctrl+D).
     */
    async softReboot(): Promise<void> {
        this.ensureConnected();

        const response = await this.backend.sendCommand(
            MessageFactory.createSoftReboot(this._sessionId)
        );

        if (!response.success) {
            throw new Error(response.error?.message ?? "Soft reboot failed");
        }
    }

    /**
     * Read a file from the device.
     *
     * @param path - File path on device
     * @returns File content and metadata
     */
    async readFile(path: string): Promise<ReadFileResult> {
        this.ensureConnected();

        const response = await this.backend.sendCommand(
            MessageFactory.createReadFile(this._sessionId, path)
        );

        if (!response.success) {
            throw new Error(response.error?.message ?? "Read file failed");
        }

        const data = response.data as ReadFileResponseData;
        return {
            content: data.content,
            encoding: data.encoding,
            size: data.size,
        };
    }

    /**
     * Write a file to the device.
     *
     * @param path - File path on device
     * @param content - File content
     * @param encoding - Content encoding
     */
    async writeFile(
        path: string,
        content: string,
        encoding: "utf-8" | "base64" = "utf-8"
    ): Promise<void> {
        this.ensureConnected();

        const response = await this.backend.sendCommand(
            MessageFactory.createWriteFile(this._sessionId, path, content, encoding)
        );

        if (!response.success) {
            throw new Error(response.error?.message ?? "Write file failed");
        }
    }

    /**
     * List a directory on the device.
     *
     * @param path - Directory path on device
     * @returns List of file entries
     */
    async listDir(path = "/"): Promise<FileEntry[]> {
        this.ensureConnected();

        const response = await this.backend.sendCommand(
            MessageFactory.createListDir(this._sessionId, path)
        );

        if (!response.success) {
            throw new Error(response.error?.message ?? "List directory failed");
        }

        const data = response.data as ListDirResponseData;
        return data.entries;
    }

    /**
     * Dispose of the session.
     */
    dispose(): void {
        this.cleanup();
        this.removeAllListeners();
    }

    /**
     * Set up event handler for backend events.
     */
    private setupEventHandler(): void {
        this.eventHandler = (event: EventMessage) => {
            this.handleBackendEvent(event);
        };
        this.backend.on("event", this.eventHandler);
    }

    /**
     * Handle events from the backend.
     */
    private handleBackendEvent(event: EventMessage): void {
        // Check if this event is for our session
        const data = event.data as { session_id?: string };
        if (data.session_id && data.session_id !== this._sessionId) {
            return;
        }

        if (isOutputEvent(event)) {
            this.emit("output", event.data.data, event.data.stream);
        } else if (isStateChangedEvent(event)) {
            const newState = event.data.new_state as SessionState;
            this.setState(newState);
        }
    }

    /**
     * Set the session state and emit event.
     */
    private setState(state: SessionState): void {
        const oldState = this._state;
        this._state = state;
        if (oldState !== state) {
            this.emit("stateChange", state, oldState);
        }
    }

    /**
     * Ensure the session is connected.
     */
    private ensureConnected(): void {
        if (!this.isConnected) {
            throw new Error("Session is not connected");
        }
    }

    /**
     * Clean up resources.
     */
    private cleanup(): void {
        if (this.eventHandler) {
            this.backend.off("event", this.eventHandler);
            this.eventHandler = null;
        }
    }
}

/**
 * Type-safe event listener methods for DeviceSession.
 */
export interface DeviceSession {
    on(
        event: "output",
        listener: (data: string, stream: "stdout" | "stderr") => void
    ): this;
    on(
        event: "stateChange",
        listener: (newState: SessionState, oldState: SessionState) => void
    ): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "closed", listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
}
