/**
 * History Manager for terminal command history.
 *
 * Provides command history navigation with persistence support.
 */

import * as vscode from "vscode";

/**
 * Options for HistoryManager.
 */
export interface HistoryManagerOptions {
    /** Maximum number of history entries. Default: 1000 */
    maxEntries?: number;
    /** GlobalState for persistence. If not provided, history is not persisted */
    globalState?: vscode.Memento;
    /** Key for storing history in globalState. Default: "mpy.replHistory" */
    storageKey?: string;
    /** Whether to deduplicate consecutive identical entries. Default: true */
    deduplicateConsecutive?: boolean;
}

/**
 * History Manager for command history.
 *
 * Features:
 * - Navigation through previous commands
 * - Persistence to VS Code globalState
 * - Maximum entry limit with automatic pruning
 * - Deduplication of consecutive identical entries
 */
export class HistoryManager {
    private history: string[] = [];
    private currentIndex: number = -1;
    private tempLine: string = "";
    private maxEntries: number;
    private globalState?: vscode.Memento;
    private storageKey: string;
    private deduplicateConsecutive: boolean;
    private dirty = false;

    /**
     * Create a new history manager.
     *
     * @param options - Manager options
     */
    constructor(options: HistoryManagerOptions = {}) {
        this.maxEntries = options.maxEntries ?? 1000;
        this.globalState = options.globalState;
        this.storageKey = options.storageKey ?? "mpy.replHistory";
        this.deduplicateConsecutive = options.deduplicateConsecutive ?? true;

        // Load from storage
        this.load();
    }

    /**
     * Add a command to history.
     *
     * @param line - The command to add
     */
    add(line: string): void {
        // Don't add empty lines
        if (!line.trim()) {
            return;
        }

        // Deduplicate consecutive entries
        if (
            this.deduplicateConsecutive &&
            this.history.length > 0 &&
            this.history[this.history.length - 1] === line
        ) {
            return;
        }

        // Add to history
        this.history.push(line);

        // Prune if over limit
        while (this.history.length > this.maxEntries) {
            this.history.shift();
        }

        // Reset navigation
        this.resetNavigation();

        // Mark dirty for save
        this.dirty = true;
        this.scheduleSave();
    }

    /**
     * Navigate to previous history entry.
     *
     * @returns The previous entry, or null if at the beginning
     */
    previous(): string | null {
        if (this.history.length === 0) {
            return null;
        }

        // Save current line if starting navigation
        if (this.currentIndex === -1) {
            this.tempLine = "";
        }

        // Calculate new index
        const newIndex =
            this.currentIndex === -1
                ? this.history.length - 1
                : Math.max(0, this.currentIndex - 1);

        if (newIndex === this.currentIndex) {
            return null;
        }

        this.currentIndex = newIndex;
        return this.history[this.currentIndex];
    }

    /**
     * Navigate to next history entry.
     *
     * @returns The next entry, or null if at the end
     */
    next(): string | null {
        if (this.currentIndex === -1) {
            return null;
        }

        // Move forward
        this.currentIndex++;

        if (this.currentIndex >= this.history.length) {
            // Past the end - return to current input
            this.currentIndex = -1;
            return this.tempLine;
        }

        return this.history[this.currentIndex];
    }

    /**
     * Reset navigation state.
     *
     * Call this when the user starts typing or submits a command.
     */
    resetNavigation(): void {
        this.currentIndex = -1;
        this.tempLine = "";
    }

    /**
     * Set the temporary line (current input before navigation).
     *
     * @param line - The current input line
     */
    setTempLine(line: string): void {
        if (this.currentIndex === -1) {
            this.tempLine = line;
        }
    }

    /**
     * Get all history entries.
     *
     * @returns Copy of the history array
     */
    getAll(): string[] {
        return [...this.history];
    }

    /**
     * Get the number of history entries.
     */
    get length(): number {
        return this.history.length;
    }

    /**
     * Clear all history.
     */
    clear(): void {
        this.history = [];
        this.resetNavigation();
        this.dirty = true;
        this.save();
    }

    /**
     * Search history for entries matching a prefix.
     *
     * @param prefix - The prefix to search for
     * @returns Matching entries (most recent first)
     */
    search(prefix: string): string[] {
        if (!prefix) {
            return [];
        }

        const matches: string[] = [];
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (this.history[i].startsWith(prefix)) {
                // Avoid duplicates in results
                if (!matches.includes(this.history[i])) {
                    matches.push(this.history[i]);
                }
            }
        }
        return matches;
    }

    /**
     * Load history from storage.
     */
    private load(): void {
        if (!this.globalState) {
            return;
        }

        try {
            const stored = this.globalState.get<string[]>(this.storageKey);
            if (Array.isArray(stored)) {
                this.history = stored.slice(-this.maxEntries);
            }
        } catch (error) {
            console.error("Failed to load history:", error);
        }
    }

    /**
     * Save history to storage.
     */
    private save(): void {
        if (!this.globalState || !this.dirty) {
            return;
        }

        try {
            this.globalState.update(this.storageKey, this.history);
            this.dirty = false;
        } catch (error) {
            console.error("Failed to save history:", error);
        }
    }

    private saveTimeout: NodeJS.Timeout | null = null;

    /**
     * Schedule a save operation (debounced).
     */
    private scheduleSave(): void {
        if (this.saveTimeout) {
            return;
        }

        this.saveTimeout = setTimeout(() => {
            this.saveTimeout = null;
            this.save();
        }, 1000);
    }

    /**
     * Dispose of the history manager.
     *
     * Saves pending changes and cleans up.
     */
    dispose(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        this.save();
    }
}
