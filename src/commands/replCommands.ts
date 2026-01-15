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
  getReplTerminal,
  isReplOpen,
  closeReplTerminal,
  openReplTerminal
} from "../board/mpremoteCommands";

// REPL commands implementation
export const replCommands = {
  openRepl: async () => {
    await openReplTerminal();
  },

  stopSerial: async () => {
    if (isReplOpen()) {
      await disconnectReplTerminal();
    } else {
      vscode.window.showInformationMessage("No REPL terminal is currently open");
    }
  },

  serialSendCtrlC: serialSendCtrlC,

  runActiveFile: runActiveFile,

  openSerial: openReplTerminal,

  stop: stop,

  softReset: softReset
};