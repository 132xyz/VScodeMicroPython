import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as mp from "../board/mpremote";
import { MpRemoteManager } from "../board/MpRemoteManager";
import { 
  toLocalRelative,
  suspendSerialSessionsForAutoSync,
  restoreSerialSessionsFromSnapshot,
  closeReplTerminal,
  isReplOpen
} from "../board/mpremoteCommands";
import { buildManifest, diffManifests, saveManifest, loadManifest, Manifest } from "../sync/sync";
import { getLocalSyncRoot } from "../core/workspaceUtils";
import { createIgnoreMatcher } from "../sync/sync";
import { Esp32DecorationProvider } from "../ui/decorations";
import { createTransferProgressReporter } from "../core/transferProgress";

// Helper function to get workspace folder
function getWorkspaceFolder(): vscode.WorkspaceFolder {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error("No workspace folder open");
  return ws;
}

// Helper function for auto-suspend wrapper - properly suspends REPL before operations
async function withAutoSuspend<T>(fn: () => Promise<T>): Promise<T> {
  // Check if auto-suspend is enabled
  const enabled = vscode.workspace.getConfiguration().get<boolean>("microPythonWorkBench.serialAutoSuspend", true);
  if (!enabled) {
    return fn();
  }

  // Suspend any active serial sessions (REPL, Run terminal) to free the port
  const snapshot = await suspendSerialSessionsForAutoSync();
  try {
    // Small delay to ensure port is released
    await new Promise(r => setTimeout(r, 150));
    return await fn();
  } finally {
    // Restore serial sessions after operation completes
    try {
      await restoreSerialSessionsFromSnapshot(snapshot, { replBehavior: "none" });
    } catch (err) {
      console.error("[syncCommands] Failed to restore serial sessions:", err);
    }
  }
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

// NOTE: use central `toLocalRelative` from mpremoteCommands

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
      let localRootDir: string;
      try {
        localRootDir = getLocalSyncRoot();
      } catch (err) {
        vscode.window.showErrorMessage('Local sync root not configured. Create a "mpy" folder in the workspace or set "microPythonWorkBench.syncLocalRoot".');
        return;
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

      // Upload all files with progress using the board transport helper
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Uploading all files to board...",
        cancellable: true  // Allow user to cancel the operation
      }, async (progress, token) => {
        const files = Object.keys(man.files);
        const total = files.length;

        if (total === 0) {
          progress.report({ increment: 100, message: "No files to upload" });
          return;
        }

        progress.report({ increment: 0, message: `Found ${total} files to upload` });

        // Check for cancellation
        if (token.isCancellationRequested) {
          vscode.window.showWarningMessage("Upload cancelled by user");
          return;
        }

        // Set up cancellation handler to kill any active mpremote process
        const cancellationHandler = token.onCancellationRequested(() => {
          console.log("[syncBaseline] Cancellation requested, killing active mpremote process");
          MpRemoteManager.cancelActive();
        });

        try {
          await withAutoSuspend(async () => {
            // First, create all necessary directories on the device in hierarchical order
            progress.report({ increment: 5, message: "Creating directories on device..." });

            // Normalize rootPath to ensure it starts with /
            const normalizedRootPath = rootPath.startsWith('/') ? rootPath : '/' + rootPath;
            console.log(`[syncBaseline] Starting with ${files.length} files, rootPath=${rootPath}, normalizedRootPath=${normalizedRootPath}`);

            // Collect all unique directory paths that need to be created
            const allDirectories = new Set<string>();
            for (const relativePath of files) {
              const devicePath = path.posix.join(normalizedRootPath, relativePath);
              const deviceDir = path.posix.dirname(devicePath);

              if (deviceDir !== '.' && deviceDir !== normalizedRootPath) {
                // Add all parent directories to the set
                let currentDir = deviceDir;
                let safetyCounter = 0;
                const maxDepth = 50; // Prevent infinite loops
                while (currentDir !== normalizedRootPath && currentDir !== '/' && currentDir !== '' && safetyCounter < maxDepth) {
                  allDirectories.add(currentDir);
                  const parentDir = path.posix.dirname(currentDir);
                  // Safety check: if dirname returns the same value, we're at root
                  if (parentDir === currentDir) break;
                  currentDir = parentDir;
                  safetyCounter++;
                }
                if (safetyCounter >= maxDepth) {
                  console.warn(`[syncBaseline] Safety limit reached for path: ${relativePath}`);
                }
              }
            }

            // Also add the rootPath itself if it's not "/" and doesn't exist
            if (normalizedRootPath !== "/" && normalizedRootPath !== "") {
              // Add all parent paths of rootPath
              const rootParts = normalizedRootPath.split('/').filter(p => p);
              for (let i = 1; i <= rootParts.length; i++) {
                allDirectories.add('/' + rootParts.slice(0, i).join('/'));
              }
            }

            // Sort directories by depth to create parent directories first
            const sortedDirectories = Array.from(allDirectories).sort((a, b) => a.split('/').length - b.split('/').length);

            console.log(`[syncBaseline] Creating ${sortedDirectories.length} directories`);

            const dirTotal = sortedDirectories.length;
            for (let i = 0; i < sortedDirectories.length; i++) {
              // Check for cancellation
              if (token.isCancellationRequested) {
                vscode.window.showWarningMessage("Upload cancelled by user during directory creation");
                return;
              }
              const dir = sortedDirectories[i];
              progress.report({ increment: 5 / Math.max(dirTotal, 1), message: `Creating directory: ${dir}` });
              try {
                await mp.mkdir(dir);
              } catch (e: any) {
                // Directory might already exist, check error message
                const errorStr = String(e?.message || e).toLowerCase();
                if (!errorStr.includes("file exists") && !errorStr.includes("directory exists") && !errorStr.includes("eexist")) {
                  console.error(`[syncBaseline] Failed to create directory ${dir}:`, e?.message || e);
                }
              }
            }

            progress.report({ increment: 5, message: "Uploading files..." });

            // Calculate increment per file (remaining 85% divided by total files)
            const incrementPerFile = 85 / Math.max(total, 1);

            // Upload files
            for (let i = 0; i < files.length; i++) {
              // Check for cancellation before each file
              if (token.isCancellationRequested) {
                vscode.window.showWarningMessage(`Upload cancelled by user. ${i}/${total} files uploaded.`);
                return;
              }

              const relativePath = files[i];
              const localPath = path.join(localRootDir, relativePath);
              const devicePath = path.posix.join(normalizedRootPath, relativePath);

            progress.report({ increment: incrementPerFile, message: `Uploading (${i + 1}/${total}): ${relativePath}` });

            try {
              // Skip mkdir since we already created all directories at the start
              await mp.uploadReplacing(localPath, devicePath, { skipMkdir: true });
            } catch (uploadError: any) {
              console.error(`[syncBaseline] Failed to upload ${relativePath}:`, uploadError?.message || uploadError);
              // Ask user if they want to continue
              const choice = await vscode.window.showErrorMessage(
                `Failed to upload ${relativePath}: ${uploadError?.message || uploadError}`,
                "Continue", "Abort"
              );
              if (choice === "Abort") {
                throw new Error(`Upload aborted after failing to upload ${relativePath}`);
              }
            }
          }
          });
        } finally {
          // Clean up cancellation handler
          cancellationHandler.dispose();
        }
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
      let localRootDir: string;
      try {
        localRootDir = getLocalSyncRoot();
      } catch (err) {
        vscode.window.showErrorMessage('Local sync root not configured. Create a "mpy" folder in the workspace or set "microPythonWorkBench.syncLocalRoot".');
        return;
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
        cancellable: true  // Allow user to cancel the operation
      }, async (progress, token) => {
        const files = deviceStats.filter(e => !e.isDir);
        const total = files.length;

        if (total === 0) {
          progress.report({ increment: 100, message: "No files to download" });
          return;
        }

        progress.report({ increment: 0, message: `Found ${total} files to download` });

        // Check for cancellation
        if (token.isCancellationRequested) {
          vscode.window.showWarningMessage("Download cancelled by user");
          return;
        }

        const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
        const reportTransfer = createTransferProgressReporter(progress, totalBytes);

        await withAutoSuspend(async () => {
          for (let i = 0; i < files.length; i++) {
            // Check for cancellation before each file
            if (token.isCancellationRequested) {
              vscode.window.showWarningMessage(`Download cancelled by user. ${i}/${total} files downloaded.`);
              return;
            }

            const file = files[i];
            const rel = toLocalRelative(file.path, rootPath);
            if (rel === null) {
              // Skip files that don't map into the local sync root
              continue;
            }
            const abs = path.join(localRootDir, ...rel.split('/'));

            progress.report({ increment: 0, message: `Downloading (${i + 1}/${total}): ${rel}` });

            try {
              await fs.mkdir(path.dirname(abs), { recursive: true });
              await mp.cpFromDeviceWithProgress(file.path, abs, event => {
                reportTransfer(`Downloading (${i + 1}/${total}): ${rel}`, event);
              }, { token });
            } catch (downloadError: any) {
              console.error(`[syncBaselineFromBoard] Failed to download ${rel}:`, downloadError?.message || downloadError);
              // Ask user if they want to continue
              const choice = await vscode.window.showErrorMessage(
                `Failed to download ${rel}: ${downloadError?.message || downloadError}`,
                "Continue", "Abort"
              );
              if (choice === "Abort") {
                throw new Error(`Download aborted after failing to download ${rel}`);
              }
            }
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
    let localRootDir: string;
    try {
      localRootDir = getLocalSyncRoot();
    } catch (err) {
      vscode.window.showErrorMessage('Local sync root not configured. Create a "mpy" folder in the workspace or set "microPythonWorkBench.syncLocalRoot".');
      return;
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
    let localRootDir: string;
    try {
      localRootDir = getLocalSyncRoot();
    } catch (err) {
      vscode.window.showErrorMessage('Local sync root not configured. Create a "mpy" folder in the workspace or set "microPythonWorkBench.syncLocalRoot".');
      return;
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
        if (rel === null) return false;
        return !matcher(rel, false);
      });
      const total = filtered.length;
      const reportTransfer = createTransferProgressReporter(progress);
      await withAutoSuspend(async () => {
        for (const devicePath of filtered) {
          const rel = toLocalRelative(devicePath, rootPath2);
          if (rel === null) continue;
          const abs = path.join(localRootDir, ...rel.split('/'));
          progress.report({ message: `Downloading ${rel} (${++done}/${total})` });
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await mp.cpFromDeviceWithProgress(devicePath, abs, event => {
            reportTransfer(`Downloading ${rel} (${done}/${total})`, event);
          });
          // tree.addNode(devicePath, false); // Add downloaded file to tree
        }
      });
    });
    // decorations.clear();
    vscode.window.showInformationMessage("Board: Diffed files downloaded from board and marks cleared");
    // tree.refreshTree();
  }
};
