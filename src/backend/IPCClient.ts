/**
 * IPC Client for communicating with the Python backend.
 *
 * Handles JSON message serialization, request/response matching,
 * and event dispatching via EventEmitter.
 */

import { EventEmitter } from "events";
import { Readable, Writable } from "stream";
import {
    BackendMessage,
    CommandMessage,
    ResponseMessage,
    EventMessage,
    MessageType,
    parseBackendMessage,
    serializeCommand,
    isResponseMessage,
    isEventMessage,
} from "./messages";

/**
 * Pending request awaiting response.
 */
interface PendingRequest {
    command: CommandMessage;
    resolve: (response: ResponseMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
}

/**
 * Options for IPCClient.
 */
export interface IPCClientOptions {
    /** Timeout for requests in milliseconds. Default: 30000 */
    requestTimeout?: number;
    /** Whether to log debug messages. Default: false */
    debug?: boolean;
}

/**
 * IPC Client for bidirectional communication with Python backend.
 *
 * Events:
 * - 'event': Emitted when an event message is received from the backend
 * - 'error': Emitted when an error occurs
 * - 'close': Emitted when the connection is closed
 *
 * @example
 * ```typescript
 * const client = new IPCClient(stdin, stdout);
 * client.on('event', (event) => console.log('Event:', event));
 *
 * const response = await client.sendCommand(MessageFactory.createConnect({ port: 'COM3' }));
 * ```
 */
export class IPCClient extends EventEmitter {
    private stdin: Writable;
    private stdout: Readable;
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private buffer = "";
    private closed = false;
    private requestTimeout: number;
    private debug: boolean;

    /**
     * Create a new IPC client.
     *
     * @param stdin - Writable stream for sending commands to backend
     * @param stdout - Readable stream for receiving responses and events from backend
     * @param options - Client options
     */
    constructor(
        stdin: Writable,
        stdout: Readable,
        options: IPCClientOptions = {}
    ) {
        super();
        this.stdin = stdin;
        this.stdout = stdout;
        this.requestTimeout = options.requestTimeout ?? 30000;
        this.debug = options.debug ?? false;

        this.setupStreamHandlers();
    }

    /**
     * Send a command and wait for response.
     *
     * @param command - The command message to send
     * @returns Promise that resolves with the response
     * @throws Error if the request times out or the connection is closed
     */
    public sendCommand(command: CommandMessage): Promise<ResponseMessage> {
        if (this.closed) {
            return Promise.reject(new Error("IPC client is closed"));
        }

        return new Promise((resolve, reject) => {
            // Create timeout
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(command.id);
                reject(
                    new Error(
                        `Request timeout for command ${command.id} (${command.command})`
                    )
                );
            }, this.requestTimeout);

            // Store pending request
            const pending: PendingRequest = {
                command,
                resolve,
                reject,
                timeout,
            };
            this.pendingRequests.set(command.id, pending);

            // Send command
            try {
                const json = serializeCommand(command);
                this.log("Sending command:", json);
                this.stdin.write(json + "\n");
            } catch (error) {
                clearTimeout(timeout);
                this.pendingRequests.delete(command.id);
                reject(error);
            }
        });
    }

    /**
     * Close the IPC client.
     *
     * Cancels all pending requests and stops listening for messages.
     */
    public close(): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.log("Closing IPC client");

        // Cancel all pending requests
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("IPC client closed"));
        }
        this.pendingRequests.clear();

        this.emit("close");
    }

    /**
     * Check if the client is closed.
     */
    public isClosed(): boolean {
        return this.closed;
    }

    /**
     * Get the number of pending requests.
     */
    public getPendingCount(): number {
        return this.pendingRequests.size;
    }

    /**
     * Set up stream handlers for reading messages.
     */
    private setupStreamHandlers(): void {
        this.stdout.on("data", (chunk: Buffer) => {
            this.handleData(chunk.toString("utf-8"));
        });

        this.stdout.on("end", () => {
            this.log("Stdout stream ended");
            this.close();
        });

        this.stdout.on("error", (error) => {
            this.log("Stdout stream error:", error);
            this.emit("error", error);
            this.close();
        });

        this.stdin.on("error", (error) => {
            this.log("Stdin stream error:", error);
            this.emit("error", error);
            this.close();
        });
    }

    /**
     * Handle incoming data from stdout.
     */
    private handleData(data: string): void {
        this.buffer += data;

        // Process complete lines
        let newlineIndex: number;
        while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.substring(0, newlineIndex);
            this.buffer = this.buffer.substring(newlineIndex + 1);

            if (line.trim()) {
                this.processLine(line);
            }
        }
    }

    /**
     * Process a single line of JSON message.
     */
    private processLine(line: string): void {
        this.log("Received message:", line.substring(0, 200));

        try {
            const message = parseBackendMessage(line);
            this.handleMessage(message);
        } catch (error) {
            this.log("Failed to parse message:", error);
            this.emit("error", new Error(`Failed to parse message: ${error}`));
        }
    }

    /**
     * Handle a parsed message.
     */
    private handleMessage(message: BackendMessage): void {
        if (isResponseMessage(message)) {
            this.handleResponse(message);
        } else if (isEventMessage(message)) {
            this.handleEvent(message);
        } else {
            this.log("Unknown message type:", message);
        }
    }

    /**
     * Handle a response message.
     */
    private handleResponse(response: ResponseMessage): void {
        const pending = this.pendingRequests.get(response.id);

        if (!pending) {
            this.log("Received response for unknown request:", response.id);
            return;
        }

        // Clear timeout and remove from pending
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(response.id);

        // Resolve the promise
        pending.resolve(response);
    }

    /**
     * Handle an event message.
     */
    private handleEvent(event: EventMessage): void {
        this.log("Received event:", event.event);
        this.emit("event", event);

        // Also emit specific event type
        this.emit(`event:${event.event}`, event);
    }

    /**
     * Log a debug message.
     */
    private log(...args: unknown[]): void {
        if (this.debug) {
            console.log("[IPCClient]", ...args);
        }
    }
}

/**
 * Type-safe event listener methods for IPCClient.
 */
export interface IPCClient {
    on(event: "event", listener: (event: EventMessage) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;

    emit(event: "event", eventMessage: EventMessage): boolean;
    emit(event: "error", error: Error): boolean;
    emit(event: "close"): boolean;
    emit(event: string, ...args: unknown[]): boolean;
}
