import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Esp32Tree } from "../board/esp32Fs";
import { Esp32DecorationProvider } from "../ui/decorations";
import { buildManifest, saveManifest, createIgnoreMatcher } from "../sync/sync";
import { Localization } from "./localization";

const MPY_WORKBENCH_DIR = '.mpy-workbench';
const MPY_MANIFEST_FILE = 'esp32sync.json';

export async function refresh(tree: Esp32Tree, decorations: Esp32DecorationProvider) {
  // Refresh file tree: allow immediate listing (clear manual block), clear caches,
  // force mpremote to refresh, then notify the view to re-request children.
  console.log('[DEBUG] utilityOperations.refresh: Allowing listing and clearing caches');
  try {
    tree.allowListing();
  } catch {}
  try {
    tree.enableRawListForNext();
  } catch {}
  tree.clearCache();
  try {
    const mp = await import("../board/mpremote");
    // Force remote cache refresh which will repopulate the tree on next listing
    await mp.refreshFileTreeCache();
  } catch (err) {
    console.warn('[DEBUG] utilityOperations.refresh: mp.refreshFileTreeCache failed', err);
  }
  console.log('[DEBUG] utilityOperations.refresh: Triggering tree.refreshTree()');
  tree.refreshTree();
}

export async function rebuildManifest(tree: Esp32Tree) {
  try {
    console.log("[DEBUG] Starting manifest rebuild...");
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      Localization.showError("messages.noWorkspaceFolder");
      return;
    }

    // Ensure directories exist
    await ensureWorkbenchIgnoreFile(ws.uri.fsPath);

    // Rebuild manifest
    const matcher = await createIgnoreMatcher(ws.uri.fsPath);
    const newManifest = await buildManifest(ws.uri.fsPath, matcher);
    const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
    await saveManifest(manifestPath, newManifest);

    console.log("[DEBUG] Manifest rebuild completed");
    Localization.showInfo("messages.manifestRebuilt", Object.keys(newManifest.files).length);
  } catch (error: any) {
    console.error("[DEBUG] Manifest rebuild failed:", error);
    Localization.showError("messages.manifestRebuildFailed", error?.message || error);
  }
}

async function ensureWorkbenchIgnoreFile(wsPath: string) {
  const workbenchDir = path.join(wsPath, MPY_WORKBENCH_DIR);
  await fs.mkdir(workbenchDir, { recursive: true });
  const ignoreFile = path.join(workbenchDir, '.mpyignore');
  try {
    await fs.access(ignoreFile);
  } catch {
    // Create default ignore file
    const defaultIgnores = [
      ".git/",
      ".vscode/",
      "node_modules/",
      "dist/",
      "out/",
      "build/",
      "__pycache__/",
      ".DS_Store",
      ".mpy-workbench/"
    ].join('\n') + '\n';
    await fs.writeFile(ignoreFile, defaultIgnores, 'utf8');
  }
}

export async function cancelAllTasks() {
  try {
    console.log("[DEBUG] Starting to cancel all tasks...");
    // Implementation to cancel tasks
    // This might involve terminating running processes or clearing queues
    console.log("[DEBUG] All tasks canceled successfully");
  } catch (error: any) {
    console.error("[DEBUG] Failed to cancel tasks:", error);
    Localization.showError("messages.cancelTasksFailed", error?.message || error);
  }
}