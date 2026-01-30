/**
 * MicroPython Pseudoterminal for VSCode.
 *
 * Implements vscode.Pseudoterminal to provide a REPL interface
 * with client-side line editing, supporting UTF-8/Chinese input.
 */

import * as vscode from "vscode";
import { DeviceSession, SessionState } from "../session";
import { InputHandler } from "./InputHandler";
import { HistoryManager } from "./HistoryManager";

/**
 * ANSI escape codes for terminal control.
 */
export const ANSI = {
    /** Clear from cursor to end of line */
    CLEAR_LINE_END: "\x1b[K",
    /** Clear entire line */
    CLEAR_LINE: "\x1b[2K",
    /** Move cursor to beginning of line */
    CARRIAGE_RETURN: "\r",
    /** Move cursor left N columns */
    cursorLeft: (n: number) => `\x1b[${n}D`,
    /** Move cursor right N columns */
    cursorRight: (n: number) => `\x1b[${n}C`,
    /** Move cursor to column N */
    cursorColumn: (n: number) => `\x1b[${n}G`,
    /** Save cursor position */
    SAVE_CURSOR: "\x1b[s",
    /** Restore cursor position */
    RESTORE_CURSOR: "\x1b[u",
    /** Hide cursor */
    HIDE_CURSOR: "\x1b[?25l",
    /** Show cursor */
    SHOW_CURSOR: "\x1b[?25h",
    /** Colors */
    GREEN: "\x1b[32m",
    RED: "\x1b[31m",
    YELLOW: "\x1b[33m",
    RESET: "\x1b[0m",
    BOLD: "\x1b[1m",
};

/**
 * Options for MpyPseudoterminal.
 */
export interface MpyPseudoterminalOptions {
    /** The device session to use */
    session: DeviceSession;
    /** History manager for command history */
    historyManager?: HistoryManager;
    /** The REPL prompt string */
    prompt?: string;
    /** The continuation prompt string */
    continuationPrompt?: string;
}

/**
 * MicroPython Pseudoterminal implementation.
 *
 * Provides:
 * - Client-side line editing (UTF-8 support)
 * - Command history (up/down arrows)
 * - Multi-line input support
 * - Output display with proper formatting
 */
export class MpyPseudoterminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number | void>();
    
    private session: DeviceSession;
    private inputHandler: InputHandler;
    private historyManager: HistoryManager;
    private prompt: string;
    private continuationPrompt: string;
    
    private isOpen = false;
    private isExecuting = false;
    private multiLineBuffer: string[] = [];
    private outputHandler: ((data: string, stream: string) => void) | null = null;
    private stateHandler: ((state: SessionState) => void) | null = null;

    /**
     * Event that fires when data should be written to the terminal.
     */
    onDidWrite = this.writeEmitter.event;

    /**
     * Event that fires when the terminal should close.
     */
    onDidClose = this.closeEmitter.event;

    /**
     * Create a new MicroPython Pseudoterminal.
     *
     * @param options - Terminal options
     */
    constructor(options: MpyPseudoterminalOptions) {
        this.session = options.session;
        this.historyManager = options.historyManager ?? new HistoryManager();
        this.prompt = options.prompt ?? ">>> ";
        this.continuationPrompt = options.continuationPrompt ?? "... ";
        
        this.inputHandler = new InputHandler({
            onLineComplete: (line: string) => this.handleLineComplete(line),
            onHistoryUp: () => this.handleHistoryUp(),
            onHistoryDown: () => this.handleHistoryDown(),
            onInterrupt: () => this.handleInterrupt(),
        });
    }

    /**
     * Called when the terminal is opened.
     */
    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        this.isOpen = true;
        
        // Set up event handlers
        this.outputHandler = (data: string, stream: string) => {
            this.handleDeviceOutput(data, stream);
        };
        this.session.on("output", this.outputHandler);
        
        this.stateHandler = (state: SessionState) => {
            this.handleStateChange(state);
        };
        this.session.on("stateChange", this.stateHandler);
        
        // Write welcome message
        this.writeLine(`${ANSI.GREEN}${ANSI.BOLD}MicroPython REPL${ANSI.RESET}`);
        this.writeLine(`Connected to ${this.session.port}`);
        this.writeLine("");
        
        // Show prompt
        this.showPrompt();
    }

    /**
     * Called when the terminal is closed.
     */
    close(): void {
        this.isOpen = false;
        
        // Clean up event handlers
        if (this.outputHandler) {
            this.session.off("output", this.outputHandler);
            this.outputHandler = null;
        }
        if (this.stateHandler) {
            this.session.off("stateChange", this.stateHandler);
            this.stateHandler = null;
        }
    }

    /**
     * Handle input from the terminal.
     *
     * @param data - Input data (may be partial UTF-8, control sequences, etc.)
     */
    handleInput(data: string): void {
        if (!this.isOpen) {
            return;
        }
        
        // Process each character
        for (const char of data) {
            this.processInputChar(char);
        }
    }

    /**
     * Process a single input character.
     */
    private processInputChar(char: string): void {
        const result = this.inputHandler.handleChar(char);
        
        if (result.output) {
            this.write(result.output);
        }
    }

    /**
     * Handle a complete line of input.
     */
    private async handleLineComplete(line: string): Promise<void> {
        // Echo newline
        this.write("\r\n");
        
        // Check for multi-line input
        if (this.isMultiLineStart(line) || this.multiLineBuffer.length > 0) {
            this.multiLineBuffer.push(line);
            
            if (this.isMultiLineComplete(line)) {
                // Execute multi-line code
                const code = this.multiLineBuffer.join("\n");
                this.multiLineBuffer = [];
                await this.executeCode(code);
            } else {
                // Show continuation prompt
                this.showContinuationPrompt();
            }
        } else {
            // Single line - execute immediately
            if (line.trim()) {
                await this.executeCode(line);
            } else {
                this.showPrompt();
            }
        }
    }

    /**
     * Execute code on the device.
     */
    private async executeCode(code: string): Promise<void> {
        if (!code.trim()) {
            this.showPrompt();
            return;
        }
        
        // Add to history
        this.historyManager.add(code);
        
        this.isExecuting = true;
        
        try {
            const result = await this.session.execute(code);
            
            // Output is already handled by the output event handler
            // But we may want to show stderr in red
            if (result.stderr) {
                this.write(`${ANSI.RED}${result.stderr}${ANSI.RESET}`);
            }
        } catch (error) {
            this.writeLine(`${ANSI.RED}Error: ${error}${ANSI.RESET}`);
        } finally {
            this.isExecuting = false;
            this.showPrompt();
        }
    }

    /**
     * Handle Ctrl+C interrupt.
     */
    private async handleInterrupt(): Promise<void> {
        this.write("^C\r\n");
        
        if (this.isExecuting) {
            try {
                await this.session.interrupt();
            } catch (error) {
                this.writeLine(`${ANSI.RED}Failed to interrupt: ${error}${ANSI.RESET}`);
            }
        } else {
            // Clear current input
            this.inputHandler.clear();
            this.multiLineBuffer = [];
            this.showPrompt();
        }
    }

    /**
     * Handle history up (previous command).
     */
    private handleHistoryUp(): void {
        const previous = this.historyManager.previous();
        if (previous !== null) {
            this.replaceCurrentLine(previous);
        }
    }

    /**
     * Handle history down (next command).
     */
    private handleHistoryDown(): void {
        const next = this.historyManager.next();
        if (next !== null) {
            this.replaceCurrentLine(next);
        } else {
            this.replaceCurrentLine("");
        }
    }

    /**
     * Replace the current input line.
     */
    private replaceCurrentLine(newLine: string): void {
        // Clear current line
        const currentLine = this.inputHandler.getLine();
        const prompt = this.multiLineBuffer.length > 0 
            ? this.continuationPrompt 
            : this.prompt;
        
        // Move to start and clear
        this.write(ANSI.CARRIAGE_RETURN);
        this.write(ANSI.CLEAR_LINE_END);
        
        // Write prompt and new line
        this.write(prompt);
        this.write(newLine);
        
        // Update input handler
        this.inputHandler.setLine(newLine);
    }

    /**
     * Handle output from the device.
     */
    private handleDeviceOutput(data: string, stream: string): void {
        if (stream === "stderr") {
            this.write(`${ANSI.RED}${data}${ANSI.RESET}`);
        } else {
            this.write(data);
        }
    }

    /**
     * Handle session state changes.
     */
    private handleStateChange(state: SessionState): void {
        if (state === SessionState.Disconnected) {
            this.writeLine(`\r\n${ANSI.YELLOW}Disconnected${ANSI.RESET}`);
            this.closeEmitter.fire(0);
        } else if (state === SessionState.Error) {
            this.writeLine(`\r\n${ANSI.RED}Connection error${ANSI.RESET}`);
        }
    }

    /**
     * Check if a line starts a multi-line block.
     */
    private isMultiLineStart(line: string): boolean {
        const trimmed = line.trimEnd();
        // Lines ending with : start a block
        return trimmed.endsWith(":");
    }

    /**
     * Check if multi-line input is complete.
     */
    private isMultiLineComplete(line: string): boolean {
        // Empty line ends multi-line input
        return line.trim() === "";
    }

    /**
     * Show the main prompt.
     */
    private showPrompt(): void {
        this.write(this.prompt);
    }

    /**
     * Show the continuation prompt.
     */
    private showContinuationPrompt(): void {
        this.write(this.continuationPrompt);
    }

    /**
     * Write text to the terminal.
     */
    private write(text: string): void {
        if (this.isOpen) {
            this.writeEmitter.fire(text);
        }
    }

    /**
     * Write a line to the terminal (with newline).
     */
    private writeLine(text: string): void {
        this.write(text + "\r\n");
    }

    /**
     * Get the terminal dimensions.
     */
    setDimensions?(dimensions: vscode.TerminalDimensions): void {
        // Handle terminal resize if needed
    }
}
