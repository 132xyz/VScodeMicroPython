import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as https from "node:https";
import * as fsSync from "node:fs";
import { execFile } from "node:child_process";
import * as mp from "../board/mpremote";
import { PythonInterpreterManager } from "../python/pythonInterpreter";

// Helper function to get workspace folder
function getWorkspaceFolder(): vscode.WorkspaceFolder {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error("No workspace folder open");
  return ws;
}

// Helper function for auto-suspend wrapper
function withAutoSuspend<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

// Board commands implementation
export const boardCommands = {
  pickPort: async () => {
    // Always get the most recent port list before showing the selector
    const devices = await mp.listSerialPorts();
    const items: vscode.QuickPickItem[] = [
      { label: "auto", description: "Auto-detect device" },
      ...devices.map(d => ({ label: d.port, description: d.name || "serial port" }))
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select Board serial port" });
    if (!picked) return;
    const value = picked.label === "auto" ? "auto" : picked.label;
    await vscode.workspace.getConfiguration().update("microPythonWorkBench.connect", value, vscode.ConfigurationTarget.Global);
    // updatePortContext(); // Assuming this function exists
    // tree.requireManualRefresh();
    // await refreshFilesViewTitle();
    vscode.window.showInformationMessage(`Board connect set to ${value}`);
    // tree.clearCache();
    // tree.refreshTree();
    // (no prompt) just refresh the tree after selecting port
  },

  setPort: async (port: string) => {
    await vscode.workspace.getConfiguration().update("microPythonWorkBench.connect", port, vscode.ConfigurationTarget.Global);
    // updatePortContext();
    // tree.requireManualRefresh();
    // await refreshFilesViewTitle();
    vscode.window.showInformationMessage(`ESP32 connect set to ${port}`);
    // tree.clearCache();
    // tree.refreshTree();
    // (no prompt) just refresh the tree after setting port
  },

  // `flashMicroPython` removed: esptool-based automatic flashing has been
  // permanently removed from this extension. Users should flash boards
  // manually using esptool or other vendor tools. This file no longer
  // contains any esptool integration.
};

// NOTE: helper functions and esptool integration intentionally removed.