import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as mp from "../mpremote";
import { Esp32Tree } from "../esp32Fs";
import { Esp32Node } from "../types";
import { createIgnoreMatcher, buildManifest, saveManifest, loadManifest, Manifest } from "../sync";
import { toLocalRelative, toDevicePath } from "../mpremoteCommands";

// Helper function to get workspace folder
function getWorkspaceFolder(): vscode.WorkspaceFolder {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error("No workspace folder open");
  return ws;
}

// Helper function for auto-suspend wrapper (assuming it's defined elsewhere)
function withAutoSuspend<T>(fn: () => Promise<T>): Promise<T> {
  // Placeholder - implement based on extension logic
  return fn();
}

// Helper to ensure workbench directory exists
async function ensureMpyWorkbenchDir(wsPath: string): Promise<void> {
  const dir = path.join(wsPath, ".mpy-workbench");
  await fs.mkdir(dir, { recursive: true });
}

// Helper to ensure workbench ignore file
async function ensureWorkbenchIgnoreFile(wsPath: string): Promise<void> {
  const ignorePath = path.join(wsPath, ".mpy-workbench", ".mpyignore");
  try {
    await fs.access(ignorePath);
  } catch {
    await fs.writeFile(ignorePath, "# Add files to ignore during sync\n# Examples:\n# *.pyc\n# __pycache__/\n# .git/\n");
  }
}

// File commands implementation
export const fileCommands = {
  newFileBoardAndLocal: async () => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage("No workspace folder open");
      return;
    }
    const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
    const filename = await vscode.window.showInputBox({
      prompt: "New file name (relative to project root)",
      placeHolder: "main.py, lib/utils.py, ..."
    });
    if (!filename || filename.endsWith("/")) return;
    const abs = path.join(ws.uri.fsPath, ...filename.split("/"));
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, "", { flag: "wx" });
    } catch (e: any) {
      if (e.code !== "EEXIST") {
        vscode.window.showErrorMessage("Could not create file: " + e.message);
        return;
      }
    }
    const doc = await vscode.workspace.openTextDocument(abs);
    await vscode.window.showTextDocument(doc, { preview: false });
    // On first save, upload to board (unless ignored)
    const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
      if (savedDoc.uri.fsPath !== abs) return;
      const devicePath = (rootPath === "/" ? "/" : rootPath.replace(/\/$/, "")) + "/" + filename.replace(/^\/+/, "");
      try {
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        const rel = filename.replace(/^\/+/, "");
        if (matcher(rel.replace(/\\/g, '/'), false)) {
          vscode.window.showInformationMessage(`File saved (ignored for upload): ${filename}`);
        } else {
          try {
            await withAutoSuspend(() => mp.cpToDevice(abs, devicePath));
            vscode.window.showInformationMessage(`File saved locally and uploaded to board: ${filename}`);
            // Assuming tree is accessible - may need to pass as parameter
            // tree.addNode(devicePath, false);
          } catch (uploadError: any) {
            console.error(`[DEBUG] Failed to upload new file to board:`, uploadError);
            vscode.window.showWarningMessage(`File saved locally but upload to board failed: ${uploadError?.message || uploadError}`);
          }
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error uploading file to board: ${err?.message ?? err}`);
      }
      saveDisposable.dispose();
    });
  },

  openFileFromLocal: async (node: Esp32Node) => {
    if (node.kind !== "file") return;
    try {
      const ws = getWorkspaceFolder();
      const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
      const rel = toLocalRelative(node.path, rootPath);
      const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
      await fs.access(abs);
      const doc = await vscode.workspace.openTextDocument(abs);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (error) {
      vscode.window.showErrorMessage(`File not found in local workspace: ${toLocalRelative(node.path, vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/"))}`);
    }
  },

  syncFileLocalToBoard: async (node: Esp32Node) => {
    if (node.kind !== "file") return;
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
    const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
    const rel = toLocalRelative(node.path, rootPath);
    const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
    try {
      await fs.access(abs);
    } catch {
      const pick = await vscode.window.showWarningMessage(`Local file not found: ${rel}. Download from board first?`, { modal: true }, "Download");
      if (pick !== "Download") return;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
    }
    await withAutoSuspend(() => mp.cpToDevice(abs, node.path));
    // tree.addNode(node.path, false); // Add uploaded file to tree
    vscode.window.showInformationMessage(`Synced local → board: ${rel}`);
  },

  syncFileBoardToLocal: async (node: Esp32Node) => {
    if (node.kind !== "file") return;
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
    const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
    const rel = toLocalRelative(node.path, rootPath);
    const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
    try {
      await fs.access(abs);
    } catch {
      // Local file doesn't exist, just download it
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
      vscode.window.showInformationMessage(`Downloaded board → local: ${rel}`);
      return;
    }
    // Local file exists, overwrite it with board version
    await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
    vscode.window.showInformationMessage(`Synced board → local: ${rel}`);
  },

  openFile: async (node: Esp32Node) => {
    if (node.kind !== "file") return;
    const ws = vscode.workspace.workspaceFolders?.[0];
    const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
    if (ws) {
      const rel = toLocalRelative(node.path, rootPath);
      const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });

      // Check if file is local-only (exists locally but not on board)
      const isLocalOnly = (node as any).isLocalOnly;

      if (isLocalOnly) {
        // For local-only files, just open the local file directly
        console.log(`[DEBUG] openFile (extension): Opening local-only file: ${abs}`);
      } else {
        // For files that should exist on board, check if present locally first
        const fileExistsLocally = await fs.access(abs).then(() => true).catch(() => false);
        if (!fileExistsLocally) {
          console.log(`[DEBUG] openFile (extension): File not found locally, copying from board: ${node.path} -> ${abs}`);
          try {
            await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
            console.log(`[DEBUG] openFile (extension): Successfully copied file from board`);
          } catch (copyError: any) {
            console.error(`[DEBUG] openFile (extension): Failed to copy file from board:`, copyError);
            vscode.window.showErrorMessage(`Failed to copy file from board: ${copyError?.message || copyError}`);
            return; // Don't try to open the file if copy failed
          }
        } else {
          console.log(`[DEBUG] openFile (extension): File already exists locally: ${abs}`);
        }
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      await vscode.window.showTextDocument(doc, { preview: false });
      // await context.workspaceState.update("microPythonWorkBench.lastOpenedPath", abs);
    } else {
      // Fallback: no workspace, use temp
      // const temp = vscode.Uri.joinPath(context.globalStorageUri, node.path.replace(/\//g, "_"));
      // await fs.mkdir(path.dirname(temp.fsPath), { recursive: true });
      // try {
      //   await withAutoSuspend(() => mp.cpFromDevice(node.path, temp.fsPath));
      //   const doc = await vscode.workspace.openTextDocument(temp);
      //   await vscode.window.showTextDocument(doc, { preview: true });
      //   await context.workspaceState.update("microPythonWorkBench.lastOpenedPath", temp.fsPath);
      // } catch (copyError: any) {
      //   console.error(`[DEBUG] openFile (extension fallback): Failed to copy file to temp location:`, copyError);
      //   vscode.window.showErrorMessage(`Failed to copy file from board to temp location: ${copyError?.message || copyError}`);
      // }
    }
  },

  mkdir: async (node?: Esp32Node) => {
    const base = node?.kind === "dir" ? node.path : (node ? path.posix.dirname(node.path) : "/");
    const name = await vscode.window.showInputBox({ prompt: "New folder name", validateInput: v => v ? undefined : "Required" });
    if (!name) return;
    const target = base === "/" ? `/${name}` : `${base}/${name}`;
    await withAutoSuspend(() => mp.mkdir(target));
    // tree.addNode(target, true);
  },

  delete: async (node: Esp32Node) => {
    if ((node as any).isContextAnchor) {
      vscode.window.showInformationMessage("Select a file or folder to delete.");
      return;
    }
    const okBoard = await vscode.window.showWarningMessage(`Delete ${node.path} from board?`, { modal: true }, "Delete");
    if (okBoard !== "Delete") return;

    // Mostrar progreso con animación
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Deleting ${node.path}...`,
      cancellable: false
    }, async (progress, token) => {
      progress.report({ increment: 0, message: "Starting deletion..." });
      try {
        // Fast path: one-shot delete (file or directory)
        const isDir = node.kind === "dir";
        progress.report({ increment: 60, message: isDir ? "Removing directory..." : "Removing file..." });
        await withAutoSuspend(() => mp.deleteAny(node.path));
        progress.report({ increment: 100, message: "Deletion complete!" });
        vscode.window.showInformationMessage(`Successfully deleted ${node.path} from board`);
        // tree.removeNode(node.path);
      } catch (err: any) {
        progress.report({ increment: 100, message: "Deletion failed!" });
        vscode.window.showErrorMessage(`Failed to delete ${node.path} from board: ${err?.message ?? String(err)}`);
      }
    });
  },

  deleteBoardAndLocal: async (node: Esp32Node) => {
    if ((node as any).isContextAnchor) {
      vscode.window.showInformationMessage("Select a file or folder to delete.");
      return;
    }
    const okBoardLocal = await vscode.window.showWarningMessage(`Delete ${node.path} from board AND local workspace?`, { modal: true }, "Delete");
    if (okBoardLocal !== "Delete") return;

    // Mostrar progreso con animación
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Deleting ${node.path} from board and local...`,
      cancellable: false
    }, async (progress, token) => {
      progress.report({ increment: 0, message: "Starting deletion..." });

      try {
        // Fast path: one-shot delete on board
        const isDir = node.kind === "dir";
        progress.report({ increment: 50, message: isDir ? "Removing directory from board..." : "Removing file from board..." });
        await withAutoSuspend(() => mp.deleteAny(node.path));
        progress.report({ increment: 70, message: "Board deletion complete!" });
        vscode.window.showInformationMessage(`Successfully deleted ${node.path} from board`);
        // tree.removeNode(node.path);
      } catch (err: any) {
        progress.report({ increment: 70, message: "Board deletion failed!" });
        vscode.window.showErrorMessage(`Failed to delete ${node.path} from board: ${err?.message ?? String(err)}`);
      }
    });

    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) {
      const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
      const rel = toLocalRelative(node.path, rootPath);
      const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
      try {
        await fs.rm(abs, { recursive: true, force: true });
      } catch {}
    }
    // tree.removeNode(node.path);
  },

  deleteAllBoard: async () => {
    const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
    const warn = await vscode.window.showWarningMessage(
      `This will DELETE ALL files and folders under '${rootPath}' on the board. This cannot be undone.`,
      { modal: true },
      "Delete All"
    );
    if (warn !== "Delete All") return;

    // Mostrar progreso con animación detallada
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Deleting all files from ${rootPath}...`,
      cancellable: false
    }, async (progress, token) => {
      progress.report({ increment: 0, message: "Scanning board files..." });

      try {
        // Get list of files to show progress
        const items = await withAutoSuspend(() => mp.listTreeStats(rootPath));
        const totalItems = items.length;

        if (totalItems === 0) {
          progress.report({ increment: 100, message: "No files to delete!" });
          vscode.window.showInformationMessage(`Board: No files found under ${rootPath}`);
          return;
        }

        progress.report({ increment: 20, message: `Found ${totalItems} items to delete...` });

        // Usar nuestra nueva función para eliminar todo
        const result = await withAutoSuspend(() => mp.deleteAllInPath(rootPath));

        progress.report({ increment: 80, message: "Verifying deletion..." });

        // Verificar lo que queda
        const remaining = await withAutoSuspend(() => mp.listTreeStats(rootPath));

        progress.report({ increment: 100, message: "Deletion complete!" });

        // Reportar resultados
        const deletedCount = (result as any).deleted_count ?? result.deleted.length;
        const errorCount = (result as any).error_count ?? result.errors.length;
        const remainingCount = remaining.length;

        if (errorCount > 0) {
          console.warn("Delete errors:", result.errors);
          vscode.window.showWarningMessage(
            `Board: Deleted ${deletedCount} items, but ${errorCount} failed. ${remainingCount} items remain. Check console for details.`
          );
        } else if (remainingCount > 0) {
          vscode.window.showWarningMessage(
            `Board: Deleted ${deletedCount} items, but ${remainingCount} system files remain (this is normal).`
          );
        } else {
          vscode.window.showInformationMessage(
            `Board: Successfully deleted all ${deletedCount} files and folders under ${rootPath}`
          );
        }

      } catch (error: any) {
        progress.report({ increment: 100, message: "Deletion failed!" });
        vscode.window.showErrorMessage(`Failed to delete files from board: ${error?.message ?? String(error)}`);
      }
    });
    // Update tree without relisting: leave root directory empty in cache
    // tree.resetDir(rootPath);
  },

  newFileInTree: async (node?: Esp32Node) => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return;
    // Determine base path on device
    const baseDevice = node
      ? (node.kind === "dir" ? node.path : path.posix.dirname(node.path))
      : "/";
    const baseLabel = baseDevice === "/" ? "/" : baseDevice;
    const newName = await vscode.window.showInputBox({
      prompt: `New file name (in ${baseLabel})`,
      placeHolder: "filename.ext or subfolder/filename.ext",
      validateInput: v => v && !v.endsWith("/") && !v.endsWith("\\") ? undefined : "Name must not end with / and cannot be empty"
    });
    if (!newName) return;
    const devicePath = baseDevice === "/" ? `/${newName.replace(/^\//, "")}` : `${baseDevice}/${newName.replace(/^\//, "")}`;
    try {
      // Create locally first
      const relLocal = devicePath.replace(/^\//, "");
      const localPath = path.join(ws, relLocal);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, "");
      // Upload to board
      try {
        await mp.uploadReplacing(localPath, devicePath);
        vscode.window.showInformationMessage(`File created: ${devicePath}`);
      } catch (uploadError: any) {
        console.error(`[DEBUG] Failed to upload new file to board:`, uploadError);
        vscode.window.showWarningMessage(`File created locally but upload to board failed: ${uploadError?.message || uploadError}`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Error creating file: ${err?.message ?? err}`);
    }
    vscode.commands.executeCommand("microPythonWorkBench.refresh");
  },

  newFolderInTree: async (node?: Esp32Node) => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return;
    const baseDevice = node
      ? (node.kind === "dir" ? node.path : path.posix.dirname(node.path))
      : "/";
    const baseLabel = baseDevice === "/" ? "/" : baseDevice;
    const newName = await vscode.window.showInputBox({
      prompt: `New folder name (in ${baseLabel})`,
      placeHolder: "folder or subfolder/name",
      validateInput: v => v && !v.endsWith(".") && !v.endsWith("/") && !v.endsWith("\\") ? undefined : "Name must not end with / and cannot be empty"
    });
    if (!newName) return;
    const devicePath = baseDevice === "/" ? `/${newName.replace(/^\//, "")}` : `${baseDevice}/${newName.replace(/^\//, "")}`;
    try {
      await mp.mkdir(devicePath);
      const relLocal = devicePath.replace(/^\//, "");
      const localPath = path.join(ws, relLocal);
      await fs.mkdir(localPath, { recursive: true });
      vscode.window.showInformationMessage(`Folder created: ${devicePath}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Error creating folder: ${err?.message ?? err}`);
    }
    vscode.commands.executeCommand("microPythonWorkBench.refresh");
  },

  renameNode: async (node: Esp32Node) => {
    if (!node || (node as any).isContextAnchor) {
      vscode.window.showInformationMessage("Select a file or folder to rename.");
      return;
    }
    const oldPath = node.path;
    const isDir = node.kind === "dir";
    const base = path.posix.dirname(oldPath);
    const oldName = path.posix.basename(oldPath);
    const newName = await vscode.window.showInputBox({
      prompt: `New name for ${oldName}`,
      value: oldName,
      validateInput: v => v && v !== oldName ? undefined : "Name must be different and not empty"
    });
    if (!newName || newName === oldName) return;
    const newPath = base === "/" ? `/${newName}` : `${base}/${newName}`;
    // Try to rename on board first
    try {
      await mp.mvOnDevice(oldPath, newPath);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Error renaming on board: ${err?.message ?? err}`);
      return;
    }
    // Try to rename locally if file exists locally
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsFolder) {
      // Compute local path from node.path
      const relPath = node.path.replace(/^\//, "");
      const localOld = path.join(wsFolder, relPath);
      const localNew = path.join(wsFolder, base.replace(/^\//, ""), newName);
      try {
        await fs.rename(localOld, localNew);
      } catch (e) {
        // If file doesn't exist locally, ignore
      }
    }
    vscode.window.showInformationMessage(`Renamed: ${oldPath} → ${newPath}`);
    // Refresh tree
    const tree = vscode.extensions.getExtension("WebForks.MicroPython-WorkBench")?.exports?.esp32Tree as { refreshTree: () => void };
    if (tree && typeof tree.refreshTree === "function") tree.refreshTree();
    else vscode.commands.executeCommand("microPythonWorkBench.refresh");
  }
};