import * as vscode from "vscode";
import { Esp32Tree } from "../board/esp32Fs";
import { Esp32DecorationProvider } from "../ui/decorations";

// Utility commands implementation
export const utilityCommands = {
  refresh: async (tree: Esp32Tree, decorations: Esp32DecorationProvider) => {
    // Import refresh function from utilityOperations
    const { refresh } = await import("../core/utilityOperations");
    await refresh(tree, decorations);
  }
};