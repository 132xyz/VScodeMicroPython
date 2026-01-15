import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as mp from "../board/mpremote";
import { buildManifest, diffManifests, saveManifest, loadManifest, Manifest } from "../sync/sync";
import { createIgnoreMatcher } from "../sync/sync";
import { Esp32DecorationProvider } from "../ui/decorations";

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

// Helper to check if local sync is initialized
async function isLocalSyncInitialized(): Promise<boolean> {
  try {
    const ws = getWorkspaceFolder();
    const manifestPath = path.join(ws.uri.fsPath, ".mpy-workbench", "esp32sync.json");
    await fs.access(manifestPath);
    return true;
  } catch {
    return false;
  }
}

// Helper to convert device path to local relative
function toLocalRelative(devicePath: string, rootPath: string): string {
  const rel = devicePath.replace(new RegExp(`^${rootPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), "").replace(/^\//, "");
  return rel;
}

// Sync commands implementation
export const syncCommands = {
  syncBaseline: async () => {
    try {
      // Close the REPL terminal if open to avoid port conflicts
      // Assuming isReplOpen and closeReplTerminal are available
      // if (isReplOpen()) {
      //   await disconnectReplTerminal();
      //   await new Promise(r => setTimeout(r, 400));
      // }
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      const syncLocalRoot = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.syncLocalRoot", "");
      let localRootDir = ws.uri.fsPath;
      if (syncLocalRoot) {
        if (path.isAbsolute(syncLocalRoot)) {
          localRootDir = syncLocalRoot;
        } else {
          localRootDir = path.join(ws.uri.fsPath, syncLocalRoot);
        }
        try {
          await fs.access(localRootDir);
        } catch {
          const create = await vscode.window.showWarningMessage(`Sync local root '${syncLocalRoot}' does not exist. Create it?`, "Create", "Use Workspace Root");
          if (create === "Create") {
            await fs.mkdir(localRootDir, { recursive: true });
          } else {
            localRootDir = ws.uri.fsPath;
          }
        }
      }
      const initialized = await isLocalSyncInitialized();
      if (!initialized) {
        const initialize = await vscode.window.showWarningMessage(
          "The local folder is not initialized for synchronization. Would you like to initialize it now?",
          { modal: true },
          "Initialize"
        );
        if (initialize !== "Initialize") return;
        // Create initial manifest to initialize sync
        await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        const initialManifest = await buildManifest(localRootDir, matcher);
        const manifestPath = path.join(ws.uri.fsPath, ".mpy-workbench", "esp32sync.json");
        await saveManifest(manifestPath, initialManifest);
        vscode.window.showInformationMessage("Local folder initialized for synchronization.");
      }

      const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
      const matcher2 = await createIgnoreMatcher(ws.uri.fsPath);
      const man = await buildManifest(localRootDir, matcher2);

      // Upload all files with progress using single mpremote fs cp command
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Uploading all files to board...",
        cancellable: false
      }, async (progress) => {
        const files = Object.keys(man.files);
        const total = files.length;

        if (total === 0) {
          progress.report({ increment: 100, message: "No files to upload" });
          return;
        }

        progress.report({ increment: 0, message: `Found ${total} files to upload` });

        await withAutoSuspend(async () => {
          // First, create all necessary directories on the device in hierarchical order
          progress.report({ increment: 5, message: "Creating directories on device..." });

          // Collect all unique directory paths that need to be created
          const allDirectories = new Set<string>();
          for (const relativePath of files) {
            const devicePath = path.posix.join(rootPath, relativePath);
            const deviceDir = path.posix.dirname(devicePath);

            if (deviceDir !== '.' && deviceDir !== rootPath) {
              // Add all parent directories to the set
              let currentDir = deviceDir;
              while (currentDir !== rootPath && currentDir !== '/') {
                allDirectories.add(currentDir);
                currentDir = path.posix.dirname(currentDir);
              }
            }
          }

          // Sort directories by depth to create parent directories first
          const sortedDirectories = Array.from(allDirectories).sort((a, b) => a.split('/').length - b.split('/').length);

          for (const dir of sortedDirectories) {
            try {
              await mp.mkdir(dir);
            } catch (e) {
              // Directory might already exist, ignore error
            }
          }

          progress.report({ increment: 10, message: "Uploading files..." });

          // Upload files
          for (let i = 0; i < files.length; i++) {
            const relativePath = files[i];
            const localPath = path.join(localRootDir, relativePath);
            const devicePath = path.posix.join(rootPath, relativePath);

            progress.report({ increment: 10 + (i / total) * 85, message: `Uploading ${relativePath}` });

            await mp.uploadReplacing(localPath, devicePath);
          }
        });
      });

      // Save manifest after successful upload
      const manifestPath = path.join(ws.uri.fsPath, ".mpy-workbench", "esp32sync.json");
      await saveManifest(manifestPath, man);

      vscode.window.showInformationMessage("Baseline sync completed successfully");
      // tree.clearCache();
      // tree.refreshTree();
    } catch (error: any) {
      vscode.window.showErrorMessage(`Sync baseline failed: ${error?.message || error}`);
    }
  },

  syncBaselineFromBoard: async () => {
    try {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      const syncLocalRoot = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.syncLocalRoot", "");
      let localRootDir = ws.uri.fsPath;
      if (syncLocalRoot) {
        if (path.isAbsolute(syncLocalRoot)) {
          localRootDir = syncLocalRoot;
        } else {
          localRootDir = path.join(ws.uri.fsPath, syncLocalRoot);
        }
        try {
          await fs.access(localRootDir);
        } catch {
          const create = await vscode.window.showWarningMessage(`Sync local root '${syncLocalRoot}' does not exist. Create it?`, "Create", "Use Workspace Root");
          if (create === "Create") {
            await fs.mkdir(localRootDir, { recursive: true });
          } else {
            localRootDir = ws.uri.fsPath;
          }
        }
      }
      const initialized = await isLocalSyncInitialized();
      if (!initialized) {
        const initialize = await vscode.window.showWarningMessage(
          "The local folder is not initialized for synchronization. Would you like to initialize it now?",
          { modal: true },
          "Initialize"
        );
        if (initialize !== "Initialize") return;

        // Create initial manifest to initialize sync
        await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        const initialManifest = await buildManifest(localRootDir, matcher);
        const manifestPath = path.join(ws.uri.fsPath, ".mpy-workbench", "esp32sync.json");
        await saveManifest(manifestPath, initialManifest);
        vscode.window.showInformationMessage("Local folder initialized for synchronization.");
      }

      const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");

      // Get all files from board
      const deviceStats = await withAutoSuspend(() => mp.listTreeStats(rootPath));

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Downloading all files from board...",
        cancellable: false
      }, async (progress) => {
        const files = deviceStats.filter(e => !e.isDir);
        const total = files.length;

        if (total === 0) {
          progress.report({ increment: 100, message: "No files to download" });
          return;
        }

        progress.report({ increment: 0, message: `Found ${total} files to download` });

        await withAutoSuspend(async () => {
          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const rel = toLocalRelative(file.path, rootPath);
            const abs = path.join(localRootDir, ...rel.split('/'));

            progress.report({ increment: (i / total) * 100, message: `Downloading ${rel}` });

            await fs.mkdir(path.dirname(abs), { recursive: true });
            await mp.cpFromDevice(file.path, abs);
          }
        });
      });

      // Create manifest from downloaded files
      const matcher = await createIgnoreMatcher(ws.uri.fsPath);
      const man = await buildManifest(localRootDir, matcher);
      const manifestPath = path.join(ws.uri.fsPath, ".mpy-workbench", "esp32sync.json");
      await saveManifest(manifestPath, man);

      vscode.window.showInformationMessage("Baseline sync from board completed successfully");
      // tree.clearCache();
      // tree.refreshTree();
    } catch (error: any) {
      vscode.window.showErrorMessage(`Sync baseline from board failed: ${error?.message || error}`);
    }
  },

  checkDiffs: async () => {
    // Assuming boardOperations.checkDiffs is available
    // await boardOperations.checkDiffs();
    vscode.window.showInformationMessage("Check diffs functionality moved to board operations");
  },

  syncDiffsLocalToBoard: async () => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
    const syncLocalRoot = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.syncLocalRoot", "");
    let localRootDir = ws.uri.fsPath;
    if (syncLocalRoot) {
      if (path.isAbsolute(syncLocalRoot)) {
        localRootDir = syncLocalRoot;
      } else {
        localRootDir = path.join(ws.uri.fsPath, syncLocalRoot);
      }
      try {
        await fs.access(localRootDir);
      } catch {
        const create = await vscode.window.showWarningMessage(`Sync local root '${syncLocalRoot}' does not exist. Create it?`, "Create", "Use Workspace Root");
        if (create === "Create") {
          await fs.mkdir(localRootDir, { recursive: true });
        } else {
          localRootDir = ws.uri.fsPath;
        }
      }
    }
    const initialized = await isLocalSyncInitialized();
    if (!initialized) {
      const initialize = await vscode.window.showWarningMessage(
        "The local folder is not initialized for synchronization. Would you like to initialize it now?",
        { modal: true },
        "Initialize"
      );
      if (initialize !== "Initialize") return;

      // Create initial manifest to initialize sync
      await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
      const matcher = await createIgnoreMatcher(ws.uri.fsPath);
      const initialManifest = await buildManifest(localRootDir, matcher);
      const manifestPath = path.join(ws.uri.fsPath, ".mpy-workbench", "esp32sync.json");
      await saveManifest(manifestPath, initialManifest);
      vscode.window.showInformationMessage("Local folder initialized for synchronization.");
    }
    const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
    // Get current diffs and filter to files by comparing with current device stats
    // Check if differences have been detected first
    // Assuming decorations is available
    // const allDiffs = decorations.getDiffsFilesOnly();
    // const allLocalOnly = decorations.getLocalOnlyFilesOnly();
    // if (allDiffs.length === 0 && allLocalOnly.length === 0) {
    //   const runCheck = await vscode.window.showInformationMessage(
    //     "No file differences detected. You need to check for differences first before syncing.",
    //     "Check Differences Now"
    //   );
    //   if (runCheck === "Check Differences Now") {
    //     await vscode.commands.executeCommand("microPythonWorkBench.checkDiffs");
    //     // After checking diffs, try again - check both diffs and local-only files
    //     const newDiffs = decorations.getDiffsFilesOnly();
    //     const newLocalOnly = decorations.getLocalOnlyFilesOnly();
    //     if (newDiffs.length === 0 && newLocalOnly.length === 0) {
    //       vscode.window.showInformationMessage("No differences found between local and board files.");
    //       return;
    //     }
    //   } else {
    //     return;
    //   }
    // }

    // Placeholder implementation
    vscode.window.showInformationMessage("Sync diffs local to board - implementation moved");
  },

  syncDiffsBoardToLocal: async () => {
    const ws2 = vscode.workspace.workspaceFolders?.[0];
    if (!ws2) { vscode.window.showErrorMessage("No workspace folder open"); return; }
    const syncLocalRoot = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.syncLocalRoot", "");
    let localRootDir = ws2.uri.fsPath;
    if (syncLocalRoot) {
      if (path.isAbsolute(syncLocalRoot)) {
        localRootDir = syncLocalRoot;
      } else {
        localRootDir = path.join(ws2.uri.fsPath, syncLocalRoot);
      }
      try {
        await fs.access(localRootDir);
      } catch {
        const create = await vscode.window.showWarningMessage(`Sync local root '${syncLocalRoot}' does not exist. Create it?`, "Create", "Use Workspace Root");
        if (create === "Create") {
          await fs.mkdir(localRootDir, { recursive: true });
        } else {
          localRootDir = ws2.uri.fsPath;
        }
      }
    }
    const initialized = await isLocalSyncInitialized();
    if (!initialized) {
      const initialize = await vscode.window.showWarningMessage(
        "The local folder is not initialized for synchronization. Would you like to initialize it now?",
        { modal: true },
        "Initialize"
      );
      if (initialize !== "Initialize") return;

      // Create initial manifest to initialize sync
      await ensureWorkbenchIgnoreFile(ws2.uri.fsPath);
      const matcher = await createIgnoreMatcher(ws2.uri.fsPath);
      const initialManifest = await buildManifest(localRootDir, matcher);
      const manifestPath = path.join(ws2.uri.fsPath, ".mpy-workbench", "esp32sync.json");
      await saveManifest(manifestPath, initialManifest);
      vscode.window.showInformationMessage("Local folder initialized for synchronization.");
    }

    const rootPath2 = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
    // Get current diffs and filter to files by comparing with current device stats
    const deviceStats2 = await withAutoSuspend(() => mp.listTreeStats(rootPath2));
    // Placeholder for diffs filtering
    const diffs2: string[] = [];

    if (diffs2.length === 0) {
      // Placeholder for local-only files
      const localOnlyFiles: any[] = [];
      if (localOnlyFiles.length > 0) {
        const syncLocalToBoard = await vscode.window.showInformationMessage(
          `Board → Local: No board files to download, but you have ${localOnlyFiles.length} local-only files. Use 'Sync Files (Local → Board)' to upload them to the board.`,
          { modal: true },
          "Sync Local → Board"
        );
        if (syncLocalToBoard === "Sync Local → Board") {
          await vscode.commands.executeCommand("microPythonWorkBench.syncDiffsLocalToBoard");
        }
      } else {
        const checkNow = await vscode.window.showWarningMessage(
          "Board: No diffed files found to sync. You need to run 'Check Differences' first to detect changes between board and local files.",
          { modal: true },
          "Check Differences Now"
        );
        if (checkNow === "Check Differences Now") {
          await vscode.commands.executeCommand("microPythonWorkBench.checkDiffs");
        }
      }
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Board: Sync Diffed Files Board → Local", cancellable: false }, async (progress) => {
      let done = 0;
      const matcher = await createIgnoreMatcher(ws2.uri.fsPath);
      const filtered = diffs2.filter(devicePath => {
        const rel = toLocalRelative(devicePath, rootPath2);
        return !matcher(rel, false);
      });
      const total = filtered.length;
      await withAutoSuspend(async () => {
        for (const devicePath of filtered) {
          const rel = toLocalRelative(devicePath, rootPath2);
          const abs = path.join(localRootDir, ...rel.split('/'));
          progress.report({ message: `Downloading ${rel} (${++done}/${total})` });
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await mp.cpFromDevice(devicePath, abs);
          // tree.addNode(devicePath, false); // Add downloaded file to tree
        }
      });
    });
    // decorations.clear();
    vscode.window.showInformationMessage("Board: Diffed files downloaded from board and marks cleared");
    // tree.refreshTree();
  }
};