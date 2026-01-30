/**
 * Session Manager for MicroPython devices.
 *
 * Manages multiple device sessions and provides a central interface
 * for device operations.
 */

import * as vscode from "vscode";
import { EventEmitter } from "events";
import {
    BackendProcess,
    BackendState,
    getBackendProcess,
    disposeBackendProcess,
    MessageFactory,
    SessionInfo,
    ListSessionsResponseData,
    EventMessage,
} from "../backend";
import { DeviceSession, DeviceSessionOptions } from "./DeviceSession";

/**
 * Options for SessionManager.
 */
export interface SessionManagerOptions {
    /** Extension context for resource management */
    context: vscode.ExtensionContext;
    /** Enable debug mode */
    debug?: boolean;
}

/**
 * Session Manager for managing multiple device sessions.
 *
 * Provides:
 * - Backend process lifecycle management
 * - Session creation and management
 * - Event forwarding
 *
 * @example
 * ```typescript
 * const manager = new SessionManager({ context: extensionContext });
 * await manager.initialize();
 *
 * const session = await manager.createSession({ port: 'COM3' });
 * await session.connect();
 *
 * await session.execute('print("Hello")');
 *
 * await manager.dispose();
 * ```
 */
export class SessionManager extends EventEmitter {
    private context: vscode.ExtensionContext;
    private debug: boolean;
    private backend: BackendProcess | null = null;
    private sessions: Map<string, DeviceSession> = new Map();
    private initialized = false;

    /**
     * Create a new session manager.
     *
     * @param options - Manager options
     */
    constructor(options: SessionManagerOptions) {
        super();
        this.context = options.context;
        this.debug = options.debug ?? false;
    }

    /**
     * Initialize the session manager.
     *
     * Starts the backend process.
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.log("Initializing session manager");

        // Create and start backend
        this.backend = getBackendProcess({
            context: this.context,
            debug: this.debug,
        });

        // Forward backend events
        this.backend.on("event", (event: EventMessage) => {
            this.emit("event", event);
        });

        this.backend.on("error", (error: Error) => {
            this.emit("error", error);
        });

        this.backend.on("stateChange", (newState: BackendState) => {
            this.emit("backendStateChange", newState);
        });

        await this.backend.start();
        this.initialized = true;
        this.log("Session manager initialized");
    }

    /**
     * Check if the manager is initialized.
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Get the backend state.
     */
    getBackendState(): BackendState {
        return this.backend?.getState() ?? BackendState.Stopped;
    }

    /**
     * Create a new device session.
     *
     * @param options - Session options
     * @returns The created session (not yet connected)
     */
    async createSession(
        options: Omit<DeviceSessionOptions, "sessionId">
    ): Promise<DeviceSession> {
        this.ensureInitialized();

        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        
        const session = new DeviceSession(this.backend!, {
            ...options,
            sessionId,
        });

        // Track session
        this.sessions.set(sessionId, session);

        // Clean up when session is closed
        session.on("closed", () => {
            this.sessions.delete(sessionId);
        });

        this.log(`Created session: ${sessionId}`);
        return session;
    }

    /**
     * Get a session by ID.
     *
     * @param sessionId - The session ID
     * @returns The session or undefined
     */
    getSession(sessionId: string): DeviceSession | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * Get all sessions.
     *
     * @returns Array of all sessions
     */
    getAllSessions(): DeviceSession[] {
        return Array.from(this.sessions.values());
    }

    /**
     * Get session info from the backend.
     *
     * @returns List of session info from backend
     */
    async getBackendSessions(): Promise<SessionInfo[]> {
        this.ensureInitialized();

        const response = await this.backend!.sendCommand(
            MessageFactory.createListSessions()
        );

        if (!response.success) {
            throw new Error(response.error?.message ?? "Failed to list sessions");
        }

        const data = response.data as ListSessionsResponseData;
        return data.sessions;
    }

    /**
     * Remove a session.
     *
     * @param sessionId - The session ID to remove
     */
    async removeSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.disconnect();
            session.dispose();
            this.sessions.delete(sessionId);
            this.log(`Removed session: ${sessionId}`);
        }
    }

    /**
     * Remove all sessions.
     */
    async removeAllSessions(): Promise<void> {
        const sessionIds = Array.from(this.sessions.keys());
        for (const sessionId of sessionIds) {
            await this.removeSession(sessionId);
        }
    }

    /**
     * List available serial ports.
     *
     * @returns List of available ports
     */
    async listPorts(): Promise<Array<{
        port: string;
        description?: string;
        vendorId?: string;
        productId?: string;
        manufacturer?: string;
    }>> {
        this.ensureInitialized();

        const response = await this.backend!.sendCommand(
            MessageFactory.createCommand("list_ports", {})
        );

        if (!response.success) {
            throw new Error(response.error?.message ?? "Failed to list ports");
        }

        return (response.data as any)?.ports ?? [];
    }

    /**
     * Check if any session is busy.
     */
    isBusy(): boolean {
        for (const session of this.sessions.values()) {
            if (session.isConnected) {
                return true;
            }
        }
        return false;
    }

    /**
     * Get the active session (most recently created connected session).
     */
    getActiveSession(): DeviceSession | undefined {
        const sessions = this.getAllSessions().filter(s => s.isConnected);
        return sessions.length > 0 ? sessions[sessions.length - 1] : undefined;
    }

    /**
     * Cancel all active operations.
     */
    async cancelAll(): Promise<void> {
        for (const session of this.sessions.values()) {
            if (session.isConnected) {
                try {
                    await session.interrupt();
                } catch {
                    // Ignore errors during cancel
                }
            }
        }
    }

    /**
     * Dispose of the session manager.
     *
     * Disconnects all sessions and stops the backend.
     */
    async dispose(): Promise<void> {
        this.log("Disposing session manager");

        // Remove all sessions
        await this.removeAllSessions();

        // Stop backend
        if (this.backend) {
            await this.backend.stop();
            disposeBackendProcess();
            this.backend = null;
        }

        this.initialized = false;
        this.removeAllListeners();
        this.log("Session manager disposed");
    }

    /**
     * Ensure the manager is initialized.
     */
    private ensureInitialized(): void {
        if (!this.initialized || !this.backend) {
            throw new Error("Session manager is not initialized");
        }
    }

    /**
     * Log a message.
     */
    private log(...args: unknown[]): void {
        if (this.debug) {
            console.log("[SessionManager]", ...args);
        }
    }
}

/**
 * Type-safe event listener methods for SessionManager.
 */
export interface SessionManager {
    on(event: "event", listener: (event: EventMessage) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "backendStateChange", listener: (state: BackendState) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
}

/**
 * Singleton instance of the session manager.
 */
let sessionManagerInstance: SessionManager | null = null;

/**
 * Get the singleton session manager instance.
 *
 * @param options - Options for creating the manager (only used on first call)
 * @returns The session manager instance
 */
export function getSessionManager(
    options?: SessionManagerOptions
): SessionManager {
    if (!sessionManagerInstance) {
        if (!options) {
            throw new Error(
                "SessionManager not initialized. Provide options on first call."
            );
        }
        sessionManagerInstance = new SessionManager(options);
    }
    return sessionManagerInstance;
}

/**
 * Dispose of the singleton session manager instance.
 */
export async function disposeSessionManager(): Promise<void> {
    if (sessionManagerInstance) {
        await sessionManagerInstance.dispose();
        sessionManagerInstance = null;
    }
}
