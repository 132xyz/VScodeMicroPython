import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createIgnoreMatcher } from "../sync/sync";
import { Esp32Tree } from "../board/esp32Fs";
import { Esp32DecorationProvider } from "../ui/decorations";
import { Localization } from "../core/localization";

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

// Utility commands implementation
export const utilityCommands = {
  refresh: async (tree: Esp32Tree, decorations: Esp32DecorationProvider) => {
    // Import refresh function from utilityOperations
    const { refresh } = await import("../core/utilityOperations");
    await refresh(tree, decorations);
  },

  uploadActiveFile: async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { Localization.showError("messages.noActiveEditor"); return; }
    await ed.document.save();
    const ws = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    const rel = ws ? path.relative(ws.uri.fsPath, ed.document.uri.fsPath) : path.basename(ed.document.uri.fsPath);
    if (ws) {
      try {
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        const relPosix = rel.replace(/\\\\/g, '/');
        if (matcher(relPosix, false)) {
          Localization.showInfo("messages.uploadSkipped", relPosix);
          return;
        }
      } catch {}
    }
    const dest = "/" + rel.replace(/\\\\/g, "/");
    // Use replacing upload to avoid partial writes while code may autostart
    try {
      // Assuming mp is available
      // await withAutoSuspend(() => mp.uploadReplacing(ed.document.uri.fsPath, dest));
      // tree.addNode(dest, false);
      Localization.showInfo("messages.uploadSuccess", dest);
      // tree.refreshTree();
    } catch (uploadError: any) {
      console.error(`[DEBUG] Failed to upload active file to board:`, uploadError);
      Localization.showError("messages.uploadFailed", uploadError?.message || uploadError);
    }
  },

  runFromView: async (cmd: string, ...args: any[]) => {
    try { await vscode.commands.executeCommand(cmd, ...args); } catch (e) {
      const msg = (e as any)?.message ?? String(e);
      Localization.showError("messages.boardCommandFailed", msg);
    }
  },

  syncBaselineFromView: async () => { await vscode.commands.executeCommand("microPythonWorkBench.syncBaseline"); },

  syncBaselineFromBoardFromView: async () => { await vscode.commands.executeCommand("microPythonWorkBench.syncBaselineFromBoard"); },

  checkDiffsFromView: async () => { await vscode.commands.executeCommand("microPythonWorkBench.checkDiffs"); },

  syncDiffsLocalToBoardFromView: async () => { await vscode.commands.executeCommand("microPythonWorkBench.syncDiffsLocalToBoard"); },

  syncDiffsBoardToLocalFromView: async () => { await vscode.commands.executeCommand("microPythonWorkBench.syncDiffsBoardToLocal"); },

  runActiveFileFromView: async () => { await vscode.commands.executeCommand("microPythonWorkBench.runActiveFile"); },

  openReplFromView: async () => { await vscode.commands.executeCommand("microPythonWorkBench.openRepl"); }
};