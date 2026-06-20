import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createIgnoreMatcher } from "../sync/sync";
import {
  disconnectReplTerminal,
  suspendSerialSessionsForAutoSync,
  restoreSerialSessionsFromSnapshot,
  serialSendCtrlC,
  stop,
  softReset,
  runActiveFile,
  isReplOpen,
  isReplTerminalOpen,
  closeReplClientTerminal,
  closeReplTerminal,
  openReplTerminal,
  openSerialConnection
} from "../board/mpremoteCommands";

// REPL commands implementation
export const replCommands = {
  openRepl: async () => {
    await openReplTerminal();
  },

  stopSerial: async () => {
    if (isReplOpen()) {
      await closeReplTerminal(true);
    } else {
      vscode.window.showInformationMessage("No REPL terminal is currently open");
    }
  },

  closeRepl: async () => {
    if (isReplTerminalOpen()) {
      await closeReplClientTerminal(true);
    } else {
      vscode.window.showInformationMessage("No REPL terminal is currently open");
    }
  },

  serialSendCtrlC: serialSendCtrlC,

  runActiveFile: runActiveFile,

  openSerial: openSerialConnection,

  stop: async () => {
    try {
      await closeReplTerminal(true);
    } catch (e) {
      // Fallback to previous stop behavior (soft reset) if closing REPL fails
      try { await stop(); } catch {}
    }
  },

  softReset: softReset
};
