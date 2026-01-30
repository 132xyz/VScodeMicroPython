/**
 * Backend Process Manager for mpy_backend.
 *
 * Manages the lifecycle of the Python backend process,
 * including startup, shutdown, and automatic restart.
 */

import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { IPCClient, IPCClientOptions } from "./IPCClient";
import {
    CommandMessage,
    ResponseMessage,
    EventMessage,
    MessageFactory,
} from "./messages";

/**
 * Options for BackendProcess.
 */
export interface BackendProcessOptions {
    /** Path to Python executable. Default: "python" */
    pythonPath?: string;
    /** Path to mpy_backend module. Default: resolved from extension */
    backendPath?: string;
    /** Enable debug logging. Default: false */
    debug?: boolean;
    /** Log file path for backend. Default: undefined (stderr) */
    logFile?: string;
    /** IPC client options */
    ipcOptions?: IPCClientOptions;
    /** Extension context for resolving paths */
    context?: vscode.ExtensionContext;
}

/**
 * Backend process states.
 */
export enum BackendState {
    Stopped = "stopped",
    Starting = "starting",
    Running = "running",
    Stopping = "stopping",
    Error = "error",
}

/**
 * Manages the Python backend process.
 *
 * Provides:
 * - Process lifecycle management (start, stop, restart)
 * - IPC client integration
 * - Automatic restart on crash
 * - Event forwarding from backend
 *
 * @example
 * ```typescript
 * const backend = new BackendProcess({ context: extensionContext });
 * await backend.start();
 *
 * const response = await backend.sendCommand(
 *     MessageFactory.createConnect({ port: 'COM3' })
 * );
 *
 * backend.on('event', (event) => console.log('Event:', event));
 *
 * await backend.stop();
 * ```
 */
export class BackendProcess extends EventEmitter {
    private process: ChildProcess | null = null;
    private client: IPCClient | null = null;
    private state: BackendState = BackendState.Stopped;
    private options: Required<
        Omit<BackendProcessOptions, "context" | "logFile">
    > & {
        logFile?: string;
        context?: vscode.ExtensionContext;
    };
    private restartAttempts = 0;
    private maxRestartAttempts = 3;
    private outputChannel: vscode.OutputChannel | null = null;

    /**
     * Create a new backend process manager.
     *
     * @param options - Process options
     */
    constructor(options: BackendProcessOptions = {}) {
        super();
        this.options = {
            pythonPath: options.pythonPath ?? "python",
            backendPath: options.backendPath ?? this.resolveBackendPath(options.context),
            debug: options.debug ?? false,
            logFile: options.logFile,
            ipcOptions: options.ipcOptions ?? {},
            context: options.context,
        };
    }

    /**
     * Get the current backend state.
     */
    public getState(): BackendState {
        return this.state;
    }

    /**
     * Check if the backend is running.
     */
    public isRunning(): boolean {
        return this.state === BackendState.Running;
    }

    /**
     * Start the backend process.
     *
     * @returns Promise that resolves when the backend is ready
     * @throws Error if the backend fails to start
     */
    public async start(): Promise<void> {
        if (this.state === BackendState.Running) {
            return;
        }

        if (
            this.state === BackendState.Starting ||
            this.state === BackendState.Stopping
        ) {
            throw new Error(`Cannot start backend in state: ${this.state}`);
        }

        this.setState(BackendState.Starting);
        this.log("Starting backend process...");

        try {
            await this.spawnProcess();
            this.setState(BackendState.Running);
            this.restartAttempts = 0;
            this.log("Backend process started");
        } catch (error) {
            this.setState(BackendState.Error);
            throw error;
        }
    }

    /**
     * Stop the backend process.
     *
     * @returns Promise that resolves when the backend is stopped
     */
    public async stop(): Promise<void> {
        if (
            this.state === BackendState.Stopped ||
            this.state === BackendState.Stopping
        ) {
            return;
        }

        this.setState(BackendState.Stopping);
        this.log("Stopping backend process...");

        try {
            // Send shutdown command
            if (this.client && !this.client.isClosed()) {
                try {
                    await this.client.sendCommand(MessageFactory.createShutdown());
                } catch {
                    // Ignore shutdown command errors
                }
            }

            // Close client
            if (this.client) {
                this.client.close();
                this.client = null;
            }

            // Kill process if still running
            if (this.process) {
                this.process.kill();
                this.process = null;
            }

            this.setState(BackendState.Stopped);
            this.log("Backend process stopped");
        } catch (error) {
            this.log("Error stopping backend:", error);
            // Force cleanup
            if (this.process) {
                this.process.kill("SIGKILL");
                this.process = null;
            }
            this.setState(BackendState.Stopped);
        }
    }

    /**
     * Restart the backend process.
     */
    public async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    /**
     * Send a command to the backend.
     *
     * @param command - The command to send
     * @returns Promise that resolves with the response
     * @throws Error if the backend is not running
     */
    public async sendCommand(command: CommandMessage): Promise<ResponseMessage> {
        if (!this.client || this.state !== BackendState.Running) {
            throw new Error("Backend is not running");
        }

        return this.client.sendCommand(command);
    }

    /**
     * Get the output channel for backend logs.
     */
    public getOutputChannel(): vscode.OutputChannel {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel(
                "MicroPython Backend"
            );
        }
        return this.outputChannel;
    }

    /**
     * Dispose of resources.
     */
    public dispose(): void {
        this.stop().catch(() => {});
        if (this.outputChannel) {
            this.outputChannel.dispose();
            this.outputChannel = null;
        }
    }

    /**
     * Spawn the Python backend process.
     */
    private async spawnProcess(): Promise<void> {
        const args = ["-m", "mpy_backend"];

        if (this.options.debug) {
            args.push("--debug");
        }

        if (this.options.logFile) {
            args.push("--log-file", this.options.logFile);
        }

        this.log(`Spawning: ${this.options.pythonPath} ${args.join(" ")}`);

        return new Promise((resolve, reject) => {
            try {
                this.process = spawn(this.options.pythonPath, args, {
                    cwd: this.options.backendPath,
                    stdio: ["pipe", "pipe", "pipe"],
                    env: {
                        ...process.env,
                        PYTHONUNBUFFERED: "1",
                    },
                });

                // Handle process errors
                this.process.on("error", (error) => {
                    this.log("Process error:", error);
                    this.handleProcessExit(-1);
                    reject(error);
                });

                this.process.on("exit", (code, signal) => {
                    this.log(`Process exited with code ${code}, signal ${signal}`);
                    this.handleProcessExit(code ?? -1);
                });

                // Set up stderr logging
                if (this.process.stderr) {
                    this.process.stderr.on("data", (data: Buffer) => {
                        const text = data.toString("utf-8");
                        this.log("[STDERR]", text);
                        this.getOutputChannel().append(text);
                    });
                }

                // Create IPC client
                if (this.process.stdin && this.process.stdout) {
                    this.client = new IPCClient(
                        this.process.stdin,
                        this.process.stdout,
                        {
                            ...this.options.ipcOptions,
                            debug: this.options.debug,
                        }
                    );

                    // Forward events
                    this.client.on("event", (event: EventMessage) => {
                        this.emit("event", event);
                    });

                    this.client.on("error", (error: Error) => {
                        this.emit("error", error);
                    });

                    this.client.on("close", () => {
                        this.handleClientClose();
                    });

                    // Wait a bit for process to initialize
                    setTimeout(() => {
                        if (this.process && !this.process.killed) {
                            resolve();
                        } else {
                            reject(new Error("Process died during startup"));
                        }
                    }, 100);
                } else {
                    reject(new Error("Failed to get process stdio streams"));
                }
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Handle process exit.
     */
    private handleProcessExit(code: number): void {
        const wasRunning = this.state === BackendState.Running;
        this.process = null;

        if (this.state === BackendState.Stopping) {
            // Expected exit
            return;
        }

        if (wasRunning && code !== 0) {
            // Unexpected exit - attempt restart
            this.setState(BackendState.Error);
            this.emit("error", new Error(`Backend process exited with code ${code}`));

            if (this.restartAttempts < this.maxRestartAttempts) {
                this.restartAttempts++;
                this.log(
                    `Attempting restart ${this.restartAttempts}/${this.maxRestartAttempts}`
                );
                setTimeout(() => {
                    this.start().catch((error) => {
                        this.log("Restart failed:", error);
                    });
                }, 1000 * this.restartAttempts);
            } else {
                this.log("Max restart attempts reached");
                this.setState(BackendState.Stopped);
            }
        } else {
            this.setState(BackendState.Stopped);
        }
    }

    /**
     * Handle IPC client close.
     */
    private handleClientClose(): void {
        if (this.state === BackendState.Running) {
            this.log("IPC client closed unexpectedly");
            // Process exit handler will take care of restart
        }
    }

    /**
     * Resolve the path to the mpy_backend module.
     */
    private resolveBackendPath(context?: vscode.ExtensionContext): string {
        if (context) {
            return vscode.Uri.joinPath(
                context.extensionUri,
                "src",
                "python"
            ).fsPath;
        }
        // Default fallback
        return ".";
    }

    /**
     * Set the backend state and emit event.
     */
    private setState(state: BackendState): void {
        const oldState = this.state;
        this.state = state;
        if (oldState !== state) {
            this.emit("stateChange", state, oldState);
        }
    }

    /**
     * Log a message.
     */
    private log(...args: unknown[]): void {
        if (this.options.debug) {
            console.log("[BackendProcess]", ...args);
        }
    }
}

/**
 * Type-safe event listener methods for BackendProcess.
 */
export interface BackendProcess {
    on(event: "event", listener: (event: EventMessage) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(
        event: "stateChange",
        listener: (newState: BackendState, oldState: BackendState) => void
    ): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
}

/**
 * Singleton instance of the backend process.
 */
let backendInstance: BackendProcess | null = null;

/**
 * Get the singleton backend process instance.
 *
 * @param options - Options for creating the backend (only used on first call)
 * @returns The backend process instance
 */
export function getBackendProcess(
    options?: BackendProcessOptions
): BackendProcess {
    if (!backendInstance) {
        backendInstance = new BackendProcess(options);
    }
    return backendInstance;
}

/**
 * Dispose of the singleton backend instance.
 */
export function disposeBackendProcess(): void {
    if (backendInstance) {
        backendInstance.dispose();
        backendInstance = null;
    }
}
