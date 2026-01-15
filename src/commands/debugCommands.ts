import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { refreshFileTreeCache, debugTreeParsing, debugFilesystemStatus } from "../board/mpremote";
import { rebuildManifest } from "../core/utilityOperations";
import { cancelAllTasks } from "../core/utilityOperations";

// Debug commands implementation
export const debugCommands = {
  debugTreeParsing: async () => {
    try {
      console.log("[DEBUG] Starting tree parsing debug...");
      await debugTreeParsing();
      console.log("[DEBUG] Tree parsing debug completed");
      vscode.window.showInformationMessage("Tree parsing debug completed - check console for details");
    } catch (error: any) {
      console.error("[DEBUG] Tree parsing debug failed:", error);
      vscode.window.showErrorMessage(`Tree parsing debug failed: ${error?.message || error}`);
    }
  },

  debugFilesystemStatus: async () => {
    try {
      console.log("[DEBUG] Starting filesystem status debug...");
      await debugFilesystemStatus();
      console.log("[DEBUG] Filesystem status debug completed");
      vscode.window.showInformationMessage("Filesystem status debug completed - check console for details");
    } catch (error: any) {
      console.error("[DEBUG] Filesystem status debug failed:", error);
      vscode.window.showErrorMessage(`Filesystem status debug failed: ${error?.message || error}`);
    }
  },

  rebuildManifest: async () => {
    // Assuming tree is available
    // await rebuildManifest(tree);
    vscode.window.showInformationMessage("Rebuild manifest functionality moved");
  },

  cancelAllTasks: async () => {
    await cancelAllTasks();
  }
};