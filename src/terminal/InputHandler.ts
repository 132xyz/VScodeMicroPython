/**
 * Input Handler for terminal line editing.
 *
 * Handles keyboard input, cursor movement, and line editing
 * with full UTF-8/Unicode support.
 */

import { ANSI } from "./MpyPseudoterminal";

/**
 * Result of processing an input character.
 */
export interface InputResult {
    /** Text to output to terminal (for echo) */
    output: string;
    /** Whether the line is complete (Enter pressed) */
    complete: boolean;
}

/**
 * Callbacks for input handler events.
 */
export interface InputHandlerCallbacks {
    /** Called when a line is complete (Enter pressed) */
    onLineComplete: (line: string) => void;
    /** Called when up arrow is pressed (history navigation) */
    onHistoryUp: () => void;
    /** Called when down arrow is pressed (history navigation) */
    onHistoryDown: () => void;
    /** Called when Ctrl+C is pressed */
    onInterrupt: () => void;
}

/**
 * Escape sequence state.
 */
enum EscapeState {
    Normal,
    Escape,
    CSI,
}

/**
 * Input Handler for client-side line editing.
 *
 * Features:
 * - Full line editing (insert, delete, cursor movement)
 * - UTF-8/Unicode character support
 * - Arrow keys for cursor movement and history
 * - Home/End for line navigation
 * - Backspace/Delete for character removal
 * - Ctrl+C for interrupt
 * - Ctrl+D for EOF (empty line)
 */
export class InputHandler {
    private line: string = "";
    private cursorPos: number = 0;
    private callbacks: InputHandlerCallbacks;
    private escapeState: EscapeState = EscapeState.Normal;
    private escapeBuffer: string = "";

    /**
     * Create a new input handler.
     *
     * @param callbacks - Event callbacks
     */
    constructor(callbacks: InputHandlerCallbacks) {
        this.callbacks = callbacks;
    }

    /**
     * Handle an input character.
     *
     * @param char - The input character (may be part of escape sequence)
     * @returns Result with output text and completion status
     */
    handleChar(char: string): InputResult {
        // Handle escape sequences
        if (this.escapeState !== EscapeState.Normal) {
            return this.handleEscapeChar(char);
        }

        const code = char.charCodeAt(0);

        // Handle control characters
        if (code < 32) {
            return this.handleControlChar(code);
        }

        // Start of escape sequence
        if (code === 27) {
            this.escapeState = EscapeState.Escape;
            this.escapeBuffer = "";
            return { output: "", complete: false };
        }

        // Handle DEL (127)
        if (code === 127) {
            return this.handleBackspace();
        }

        // Regular character - insert at cursor
        return this.insertChar(char);
    }

    /**
     * Get the current line.
     */
    getLine(): string {
        return this.line;
    }

    /**
     * Set the current line (used for history).
     */
    setLine(line: string): void {
        this.line = line;
        this.cursorPos = line.length;
    }

    /**
     * Clear the current line.
     */
    clear(): void {
        this.line = "";
        this.cursorPos = 0;
    }

    /**
     * Get the cursor position.
     */
    getCursorPos(): number {
        return this.cursorPos;
    }

    /**
     * Handle control characters (code < 32).
     */
    private handleControlChar(code: number): InputResult {
        switch (code) {
            case 1: // Ctrl+A - Home
                return this.moveCursorToStart();

            case 3: // Ctrl+C - Interrupt
                this.callbacks.onInterrupt();
                return { output: "", complete: false };

            case 4: // Ctrl+D - EOF
                if (this.line.length === 0) {
                    // Empty line - could trigger disconnect
                }
                return { output: "", complete: false };

            case 5: // Ctrl+E - End
                return this.moveCursorToEnd();

            case 8: // Ctrl+H - Backspace
                return this.handleBackspace();

            case 10: // LF
            case 13: // CR - Enter
                return this.handleEnter();

            case 21: // Ctrl+U - Clear line
                return this.clearLine();

            case 23: // Ctrl+W - Delete word
                return this.deleteWord();

            default:
                return { output: "", complete: false };
        }
    }

    /**
     * Handle escape sequence characters.
     */
    private handleEscapeChar(char: string): InputResult {
        this.escapeBuffer += char;

        if (this.escapeState === EscapeState.Escape) {
            if (char === "[") {
                this.escapeState = EscapeState.CSI;
                return { output: "", complete: false };
            }
            // Unknown escape - reset
            this.escapeState = EscapeState.Normal;
            return { output: "", complete: false };
        }

        if (this.escapeState === EscapeState.CSI) {
            // Check for complete CSI sequence
            const code = char.charCodeAt(0);
            if (code >= 64 && code <= 126) {
                // Final byte - process sequence
                const result = this.processCSISequence(this.escapeBuffer);
                this.escapeState = EscapeState.Normal;
                this.escapeBuffer = "";
                return result;
            }
            return { output: "", complete: false };
        }

        return { output: "", complete: false };
    }

    /**
     * Process a complete CSI escape sequence.
     */
    private processCSISequence(sequence: string): InputResult {
        // sequence includes '[' and final byte
        const final = sequence.charAt(sequence.length - 1);
        const params = sequence.slice(1, -1);

        switch (final) {
            case "A": // Up arrow
                this.callbacks.onHistoryUp();
                return { output: "", complete: false };

            case "B": // Down arrow
                this.callbacks.onHistoryDown();
                return { output: "", complete: false };

            case "C": // Right arrow
                return this.moveCursorRight();

            case "D": // Left arrow
                return this.moveCursorLeft();

            case "H": // Home
                return this.moveCursorToStart();

            case "F": // End
                return this.moveCursorToEnd();

            case "~": // Extended keys
                switch (params) {
                    case "1": // Home
                    case "7":
                        return this.moveCursorToStart();
                    case "3": // Delete
                        return this.handleDelete();
                    case "4": // End
                    case "8":
                        return this.moveCursorToEnd();
                    default:
                        return { output: "", complete: false };
                }

            default:
                return { output: "", complete: false };
        }
    }

    /**
     * Insert a character at the cursor position.
     */
    private insertChar(char: string): InputResult {
        // Insert character at cursor position
        const before = this.line.slice(0, this.cursorPos);
        const after = this.line.slice(this.cursorPos);
        this.line = before + char + after;
        this.cursorPos += this.getCharWidth(char);

        // Calculate output
        if (this.cursorPos === this.line.length) {
            // At end - just echo the character
            return { output: char, complete: false };
        } else {
            // In middle - need to redraw rest of line
            const output =
                char + after + ANSI.cursorLeft(this.getStringWidth(after));
            return { output, complete: false };
        }
    }

    /**
     * Handle Enter key.
     */
    private handleEnter(): InputResult {
        const line = this.line;
        this.callbacks.onLineComplete(line);
        this.line = "";
        this.cursorPos = 0;
        return { output: "", complete: true };
    }

    /**
     * Handle Backspace key.
     */
    private handleBackspace(): InputResult {
        if (this.cursorPos === 0) {
            return { output: "", complete: false };
        }

        // Find the character before cursor
        const before = this.line.slice(0, this.cursorPos);
        const charToDelete = this.getLastChar(before);
        const charWidth = this.getCharWidth(charToDelete);

        // Remove character
        const newBefore = before.slice(0, -charToDelete.length);
        const after = this.line.slice(this.cursorPos);
        this.line = newBefore + after;
        this.cursorPos -= charWidth;

        // Calculate output
        const output =
            ANSI.cursorLeft(charWidth) +
            after +
            " " +
            ANSI.cursorLeft(this.getStringWidth(after) + 1);
        return { output, complete: false };
    }

    /**
     * Handle Delete key.
     */
    private handleDelete(): InputResult {
        if (this.cursorPos >= this.line.length) {
            return { output: "", complete: false };
        }

        // Find the character at cursor
        const after = this.line.slice(this.cursorPos);
        const charToDelete = after.charAt(0);
        const remaining = after.slice(charToDelete.length);

        // Remove character
        this.line = this.line.slice(0, this.cursorPos) + remaining;

        // Calculate output
        const output = remaining + " " + ANSI.cursorLeft(this.getStringWidth(remaining) + 1);
        return { output, complete: false };
    }

    /**
     * Move cursor left.
     */
    private moveCursorLeft(): InputResult {
        if (this.cursorPos === 0) {
            return { output: "", complete: false };
        }

        // Find the character before cursor
        const before = this.line.slice(0, this.cursorPos);
        const charToPass = this.getLastChar(before);
        const charWidth = this.getCharWidth(charToPass);

        this.cursorPos -= charWidth;
        return { output: ANSI.cursorLeft(charWidth), complete: false };
    }

    /**
     * Move cursor right.
     */
    private moveCursorRight(): InputResult {
        if (this.cursorPos >= this.line.length) {
            return { output: "", complete: false };
        }

        // Find the character at cursor
        const after = this.line.slice(this.cursorPos);
        const charToPass = after.charAt(0);
        const charWidth = this.getCharWidth(charToPass);

        this.cursorPos += charWidth;
        return { output: ANSI.cursorRight(charWidth), complete: false };
    }

    /**
     * Move cursor to start of line.
     */
    private moveCursorToStart(): InputResult {
        if (this.cursorPos === 0) {
            return { output: "", complete: false };
        }

        const width = this.getStringWidth(this.line.slice(0, this.cursorPos));
        this.cursorPos = 0;
        return { output: ANSI.cursorLeft(width), complete: false };
    }

    /**
     * Move cursor to end of line.
     */
    private moveCursorToEnd(): InputResult {
        if (this.cursorPos >= this.line.length) {
            return { output: "", complete: false };
        }

        const after = this.line.slice(this.cursorPos);
        const width = this.getStringWidth(after);
        this.cursorPos = this.line.length;
        return { output: ANSI.cursorRight(width), complete: false };
    }

    /**
     * Clear the current line.
     */
    private clearLine(): InputResult {
        const width = this.getStringWidth(this.line.slice(0, this.cursorPos));
        this.line = "";
        this.cursorPos = 0;

        const output =
            ANSI.cursorLeft(width) + ANSI.CLEAR_LINE_END;
        return { output, complete: false };
    }

    /**
     * Delete the word before cursor.
     */
    private deleteWord(): InputResult {
        if (this.cursorPos === 0) {
            return { output: "", complete: false };
        }

        const before = this.line.slice(0, this.cursorPos);
        const after = this.line.slice(this.cursorPos);

        // Find word boundary
        let wordStart = this.cursorPos;
        // Skip trailing spaces
        while (wordStart > 0 && before.charAt(wordStart - 1) === " ") {
            wordStart--;
        }
        // Skip word characters
        while (wordStart > 0 && before.charAt(wordStart - 1) !== " ") {
            wordStart--;
        }

        const deleted = before.slice(wordStart);
        const newBefore = before.slice(0, wordStart);
        this.line = newBefore + after;

        const deletedWidth = this.getStringWidth(deleted);
        this.cursorPos = wordStart;

        const output =
            ANSI.cursorLeft(deletedWidth) +
            after +
            " ".repeat(deletedWidth) +
            ANSI.cursorLeft(this.getStringWidth(after) + deletedWidth);
        return { output, complete: false };
    }

    /**
     * Get the last character of a string (handles surrogate pairs).
     */
    private getLastChar(str: string): string {
        if (str.length === 0) {
            return "";
        }

        const lastCode = str.charCodeAt(str.length - 1);
        // Check for surrogate pair
        if (lastCode >= 0xdc00 && lastCode <= 0xdfff && str.length >= 2) {
            const prevCode = str.charCodeAt(str.length - 2);
            if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
                return str.slice(-2);
            }
        }

        return str.charAt(str.length - 1);
    }

    /**
     * Get the display width of a character.
     *
     * CJK characters are typically double-width in terminals.
     */
    private getCharWidth(char: string): number {
        if (char.length === 0) {
            return 0;
        }

        const code = char.codePointAt(0);
        if (code === undefined) {
            return 1;
        }

        // CJK ranges (simplified check)
        if (
            (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
            (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
            (code >= 0x20000 && code <= 0x2a6df) || // CJK Extension B
            (code >= 0x2a700 && code <= 0x2b73f) || // CJK Extension C
            (code >= 0x2b740 && code <= 0x2b81f) || // CJK Extension D
            (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
            (code >= 0x3000 && code <= 0x303f) || // CJK Punctuation
            (code >= 0xff00 && code <= 0xffef) // Fullwidth Forms
        ) {
            return 2;
        }

        return 1;
    }

    /**
     * Get the display width of a string.
     */
    private getStringWidth(str: string): number {
        let width = 0;
        for (const char of str) {
            width += this.getCharWidth(char);
        }
        return width;
    }
}
