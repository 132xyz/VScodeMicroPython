/**
 * New REPL Terminal implementation using mpy_backend.
 *
 * This module provides the new REPL terminal that uses the Python backend
 * with Pseudoterminal for client-side line editing and UTF-8 support.
 */

import * as vscode from "vscode";
import { getSessionManager, SessionManager, DeviceSession } from "../session";
import {
    MpyPseudoterminal,
    HistoryManager,
} from "../terminal";
import { SessionState } from "../backend";

/**
 * State for tracking active REPL terminals.
 */
interface ReplTerminalState {
    terminal: vscode.Terminal;
    session: DeviceSession;
    historyManager: HistoryManager;
}

/** Active REPL terminals by session ID */
const replTerminals = new Map<string, ReplTerminalState>();

/** The history manager (shared across sessions) */
let sharedHistoryManager: HistoryManager | null = null;

/** The session manager instance */
let sessionManager: SessionManager | null = null;

/**
 * Initialize the REPL module.
 *
 * @param context - The extension context
 */
export async function initializeReplModule(
    context: vscode.ExtensionContext
): Promise<void> {
    // Create shared history manager
    sharedHistoryManager = new HistoryManager({
        globalState: context.globalState,
        storageKey: "mpy.replHistory",
        maxEntries: 1000,
    });

    // Get session manager (will be initialized if needed)
    sessionManager = getSessionManager({ context, debug: false });

    // Register disposable
    context.subscriptions.push({
        dispose: () => {
            closeAllReplTerminals();
            sharedHistoryManager?.dispose();
        },
    });
}

/**
 * Open a REPL terminal for a device.
 *
 * @param port - The serial port to connect to
 * @param baudrate - The baud rate (default: 115200)
 * @returns The created terminal
 */
export async function openNewReplTerminal(
    port?: string,
    baudrate = 115200
): Promise<vscode.Terminal> {
    // Ensure session manager is initialized
    if (!sessionManager) {
        throw new Error("REPL module not initialized");
    }

    // Get port from configuration if not provided
    if (!port) {
        port = getConfiguredPort();
        if (!port) {
            // Show port picker
            port = await pickSerialPort();
            if (!port) {
                throw new Error("No port selected");
            }
        }
    }

    // Check if we already have a terminal for this port
    for (const [sessionId, state] of replTerminals) {
        if (state.session.port === port) {
            state.terminal.show();
            return state.terminal;
        }
    }

    // Ensure backend is running
    if (!sessionManager.isInitialized()) {
        await sessionManager.initialize();
    }

    // Create session
    const session = await sessionManager.createSession({ port, baudrate });

    // Connect to device
    try {
        await session.connect();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to connect: ${error}`);
        throw error;
    }

    // Create pseudoterminal
    const pty = new MpyPseudoterminal({
        session,
        historyManager: sharedHistoryManager!,
        prompt: ">>> ",
        continuationPrompt: "... ",
    });

    // Create VS Code terminal
    const terminal = vscode.window.createTerminal({
        name: `MicroPython REPL (${port})`,
        pty,
    });

    // Track state
    const state: ReplTerminalState = {
        terminal,
        session,
        historyManager: sharedHistoryManager!,
    };
    replTerminals.set(session.sessionId, state);

    // Handle terminal close
    const closeListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal === terminal) {
            closeListener.dispose();
            handleTerminalClosed(session.sessionId);
        }
    });

    // Show terminal
    terminal.show();

    // Update context
    setReplContext(true);

    return terminal;
}

/**
 * Close a REPL terminal.
 *
 * @param sessionId - The session ID to close (closes all if not specified)
 */
export async function closeNewReplTerminal(sessionId?: string): Promise<void> {
    if (sessionId) {
        const state = replTerminals.get(sessionId);
        if (state) {
            await cleanupTerminalState(sessionId, state);
        }
    } else {
        // Close the most recent one
        const entries = Array.from(replTerminals.entries());
        if (entries.length > 0) {
            const [id, state] = entries[entries.length - 1];
            await cleanupTerminalState(id, state);
        }
    }
}

/**
 * Close all REPL terminals.
 */
export function closeAllReplTerminals(): void {
    for (const [sessionId, state] of replTerminals) {
        state.session.disconnect().catch(() => {});
        state.session.dispose();
        try {
            state.terminal.dispose();
        } catch {}
    }
    replTerminals.clear();
    setReplContext(false);
}

/**
 * Check if any REPL terminal is open.
 */
export function isNewReplOpen(): boolean {
    return replTerminals.size > 0;
}

/**
 * Get the active REPL terminal.
 */
export function getActiveReplTerminal(): vscode.Terminal | undefined {
    const entries = Array.from(replTerminals.values());
    return entries.length > 0 ? entries[entries.length - 1].terminal : undefined;
}

/**
 * Get the active session.
 */
export function getActiveSession(): DeviceSession | undefined {
    const entries = Array.from(replTerminals.values());
    return entries.length > 0 ? entries[entries.length - 1].session : undefined;
}

/**
 * Send Ctrl+C to the active REPL.
 */
export async function sendInterrupt(): Promise<void> {
    const session = getActiveSession();
    if (session && session.isConnected) {
        await session.interrupt();
    }
}

/**
 * Soft reset the device.
 */
export async function sendSoftReset(): Promise<void> {
    const session = getActiveSession();
    if (session && session.isConnected) {
        await session.softReboot();
    }
}

/**
 * Run a file on the device.
 *
 * @param filePath - Path to the file to run
 */
export async function runFile(filePath: string): Promise<void> {
    const session = getActiveSession();
    if (!session || !session.isConnected) {
        vscode.window.showWarningMessage("No active REPL connection");
        return;
    }

    try {
        // Read file content
        const fileUri = vscode.Uri.file(filePath);
        const content = await vscode.workspace.fs.readFile(fileUri);
        const code = new TextDecoder().decode(content);

        // Execute on device
        const result = await session.execute(code);

        if (!result.success) {
            vscode.window.showErrorMessage(`Execution error: ${result.stderr}`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to run file: ${error}`);
    }
}

/**
 * Run the active editor file.
 */
export async function runActiveEditorFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage("No active editor");
        return;
    }

    const filePath = editor.document.uri.fsPath;
    if (!filePath.endsWith(".py")) {
        vscode.window.showWarningMessage("Not a Python file");
        return;
    }

    await runFile(filePath);
}

// ============================================================================
// Private helpers
// ============================================================================

/**
 * Handle terminal closed by user.
 */
async function handleTerminalClosed(sessionId: string): Promise<void> {
    const state = replTerminals.get(sessionId);
    if (state) {
        await state.session.disconnect();
        state.session.dispose();
        replTerminals.delete(sessionId);

        if (replTerminals.size === 0) {
            setReplContext(false);
        }
    }
}

/**
 * Clean up terminal state and close.
 */
async function cleanupTerminalState(
    sessionId: string,
    state: ReplTerminalState
): Promise<void> {
    await state.session.disconnect();
    state.session.dispose();
    try {
        state.terminal.dispose();
    } catch {}
    replTerminals.delete(sessionId);

    if (replTerminals.size === 0) {
        setReplContext(false);
    }
}

/**
 * Get the configured serial port.
 */
function getConfiguredPort(): string | undefined {
    const config = vscode.workspace.getConfiguration("microPythonWorkBench");
    const connect = config.get<string>("connect");
    if (connect && connect !== "auto") {
        return connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
    }
    return undefined;
}

/**
 * Show a quick pick to select a serial port.
 */
async function pickSerialPort(): Promise<string | undefined> {
    // This is a simplified implementation
    // In a real implementation, you would enumerate available ports
    const port = await vscode.window.showInputBox({
        prompt: "Enter serial port",
        placeHolder: "e.g., COM3 or /dev/ttyUSB0",
    });
    return port;
}

/**
 * Set the REPL context for menu visibility.
 */
function setReplContext(open: boolean): void {
    try {
        vscode.commands.executeCommand(
            "setContext",
            "microPythonWorkBench.replOpen",
            open
        );
    } catch {}
}
