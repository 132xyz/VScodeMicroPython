
import * as vscode from "vscode";
import { Esp32Tree } from "../board/esp32Fs";
import { ActionsTree, registerActionsTreeRefresh } from "./actions";
import { SyncTree } from "../sync/syncView";
import { getLocalSyncRoot } from "./workspaceUtils";
import { Esp32Node } from "./types";
import * as mp from "../board/mpremote";
import { refreshFileTreeCache, debugTreeParsing, debugFilesystemStatus } from "../board/mpremote";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { exec, execFile } from "node:child_process";
import * as os from "node:os";
import * as https from "node:https";
import { buildManifest, diffManifests, saveManifest, loadManifest, defaultIgnorePatterns, createIgnoreMatcher, Manifest } from "../sync/sync";
import { Esp32DecorationProvider } from "../ui/decorations";
import { listDirPyRaw } from "../python/pyraw";
import { BoardOperations } from "../board/boardOperations";
import { PythonInterpreterManager } from "../python/pythonInterpreter";
// import { monitor } from "../board/monitor"; // switched to auto-suspend REPL strategy
import { refresh, rebuildManifest, cancelAllTasks } from "./utilityOperations";
import {
  disconnectReplTerminal,
  suspendSerialSessionsForAutoSync,
  restoreSerialSessionsFromSnapshot,
  checkMpremoteAvailability,
  serialSendCtrlC,
  stop,
  softReset,
  runActiveFile,
  isReplOpen,
  closeReplTerminal,
  openReplTerminal,
  toLocalRelative,
  toDevicePath
} from "../board/mpremoteCommands";

// Import command modules
import { fileCommands } from "../commands/fileCommands";
import { syncCommands } from "../commands/syncCommands";
import { boardCommands } from "../commands/boardCommands";
import { replCommands } from "../commands/replCommands";
import { debugCommands } from "../commands/debugCommands";
import { utilityCommands } from "../commands/utilityCommands";
import { Localization } from "./localization";
import { codeCompletionManager } from "../completion/codeCompletion";
import { boardInfoService } from '../board/boardInfoService';
import { refreshIndex, clearIndex } from '../completion/stubIndex';

export async function activate(context: vscode.ExtensionContext) {
  // Extension activated
  // Silence noisy `console.log` messages unless explicit debug is enabled.
  const _origConsoleLog = console.log;
  console.log = (...args: any[]) => {
    try {
      const enabled = vscode.workspace.getConfiguration().get<boolean>("microPythonWorkBench.debug", false);
      if (enabled) _origConsoleLog(...args);
    } catch {}
  };
  // 主工作流使用内置 mpyrepl helper；MpRemoteManager 仅保留兼容旧模块名和少量遗留入口。

  // Initialize code completion manager (errors are logged)
  codeCompletionManager.initialize(context).catch(error => {
    console.error('[Extension] Failed to initialize code completion manager:', error);
  });

  // Helper to get workspace folder or throw error
  function getWorkspaceFolder(): vscode.WorkspaceFolder {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) throw new Error("No workspace folder open");
    return ws;
  }

  // Helper to get default ignore patterns as Set for compatibility
  function getDefaultIgnoreSet(): Set<string> {
    return new Set(defaultIgnorePatterns());
  }

  // Firmware catalog and esptool helper utilities removed.

  // Esptool helpers removed (esptool auto-flash permanently deleted)

  // downloadFirmware removed

  // Helper to validate if the local folder is initialized
  async function isLocalSyncInitialized(): Promise<boolean> {
    try {
      const ws = getWorkspaceFolder();
  const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
      await fs.access(manifestPath);
      return true;
    } catch {
      return false;
    }
  }
  
  // Helper for delays in retry logic
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Workspace-level config and manifest stored in .mpy-workbench/
  const MPY_WORKBENCH_DIR = '.mpy-workbench';
  const MPY_CONFIG_FILE = 'config.json';
  const MPY_MANIFEST_FILE = 'esp32sync.json';

  async function ensureMpyWorkbenchDir(wsPath: string) {
    try {
      await fs.mkdir(path.join(wsPath, MPY_WORKBENCH_DIR), { recursive: true });
    } catch { /* ignore */ }
  }

  async function ensureWorkbenchIgnoreFile(wsPath: string) {
    try {
      await ensureMpyWorkbenchDir(wsPath);
      const p = path.join(wsPath, MPY_WORKBENCH_DIR, '.mpyignore');
      await fs.access(p);
    } catch {
      const content = buildDefaultMpyIgnoreContent();
      try { await fs.writeFile(path.join(wsPath, MPY_WORKBENCH_DIR, '.mpyignore'), content, 'utf8'); } catch {}
    }
  }

  function buildDefaultMpyIgnoreContent(): string {
    return [
      '# .mpyignore — default rules (similar to .gitignore). Adjust according to your project.',
      '# Paths are relative to the workspace root.',
      '',
      '# VCS',
      '.git/',
      '.svn/',
      '.hg/',
      '',
      '# IDE/Editor',
      '.vscode/',
      '.idea/',
      '.vs/',
      '',
      '# SO',
      '.DS_Store',
      'Thumbs.db',
      '',
      '# Node/JS',
      'node_modules/',
      'dist/',
      'out/',
      'build/',
      '.cache/',
      'coverage/',
      '.next/',
      '.nuxt/',
      '.svelte-kit/',
      '.turbo/',
      '.parcel-cache/',
      '*.log',
      'npm-debug.log*',
      'yarn-debug.log*',
      'yarn-error.log*',
      'pnpm-debug.log*',
      '',
      '# Python',
      '__pycache__/',
      '*.py[cod]',
      '*.pyo',
      '*.pyd',
      '.venv/',
      'venv/',
      '.env',
      '.env.*',
      '.mypy_cache/',
      '.pytest_cache/',
      '.coverage',
      'coverage.xml',
      '*.egg-info/',
      '.tox/',
      '',
      '# Otros',
      '*.swp',
      '*.swo',
      '',
      '# MicroPython WorkBench',
      '.mpy-workbench/',
      '/.mpy-workbench',
      ''
    ].join('\n');
  }


  async function readWorkspaceConfig(wsPath: string): Promise<any> {
    try {
      const p = path.join(wsPath, MPY_WORKBENCH_DIR, MPY_CONFIG_FILE);
      const txt = await fs.readFile(p, 'utf8');
      return JSON.parse(txt);
    } catch {
      return {};
    }
  }

  async function writeWorkspaceConfig(wsPath: string, obj: any) {
    try {
      await ensureMpyWorkbenchDir(wsPath);
      const p = path.join(wsPath, MPY_WORKBENCH_DIR, MPY_CONFIG_FILE);
      await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to write .mpy-workbench config', e);
    }
  }

  function readAutoSyncSettingFromVsCode(wsPath: string): { value: boolean | undefined; defaultValue: boolean } {
    const inspected = vscode.workspace
      .getConfiguration(undefined, vscode.Uri.file(wsPath))
      .inspect<boolean>('microPythonWorkBench.autoSyncOnSave');
    const value =
      typeof inspected?.workspaceFolderValue === 'boolean' ? inspected.workspaceFolderValue :
      typeof inspected?.workspaceValue === 'boolean' ? inspected.workspaceValue :
      typeof inspected?.globalValue === 'boolean' ? inspected.globalValue :
      undefined;
    return { value, defaultValue: inspected?.defaultValue ?? false };
  }

  // Returns true if autosync should run for this workspace (VS Code setting wins, legacy .mpy-workbench fallback)
  async function workspaceAutoSyncEnabled(wsPath: string): Promise<boolean> {
    // First check extension workspaceState (session/workspace-scoped storage)
    try {
      const wsStateVal = context.workspaceState.get<boolean>('autoSyncOnSave');
      if (typeof wsStateVal === 'boolean') return wsStateVal;
    } catch {}
    const { value: settingValue, defaultValue } = readAutoSyncSettingFromVsCode(wsPath);
    if (typeof settingValue === 'boolean') return settingValue;

    const cfg = await readWorkspaceConfig(wsPath);
    if (typeof cfg.autoSyncOnSave === 'boolean') return cfg.autoSyncOnSave;

    return defaultValue;
  }

  // Context key for welcome UI when no port is selected
  const updatePortContext = () => {
    const v = mp.getActiveConnect();
    const has = !!v && v !== "auto";
    vscode.commands.executeCommand('setContext', 'microPythonWorkBench.hasPort', has);
    if (!has) {
      // Reset view title and caches when no port is selected
      try {
        if (view) view.title = "Files";
        tree.clearCache();
        try { mp.clearFileTreeCache(); } catch {}
      } catch {}
    }
  };
  // A QuickPick selection is session-scoped; when the extension starts, fall back to configuration.
  mp.clearSelectedConnect();
  updatePortContext();
  // If workspace contains a top-level `mpy` folder and the user has not
  // overridden `microPythonWorkBench.rootPath` (still default '/'), then
  // automatically set the device root to '/mpy' to avoid operating on the
  // workspace root directly.
  try {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) {
      const inspected = vscode.workspace.getConfiguration(undefined, ws.uri).inspect<string>('microPythonWorkBench.rootPath');
      const current = typeof inspected?.workspaceFolderValue === 'string' ? inspected.workspaceFolderValue : (typeof inspected?.workspaceValue === 'string' ? inspected.workspaceValue : (typeof inspected?.globalValue === 'string' ? inspected.globalValue : undefined));
      if (!current || current === "/") {
        const candidate = path.join(ws.uri.fsPath, 'mpy');
        try {
          if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isDirectory()) {
            await vscode.workspace.getConfiguration('microPythonWorkBench', ws.uri).update('rootPath', '/mpy', vscode.ConfigurationTarget.WorkspaceFolder);
            console.log('[Extension] auto-set microPythonWorkBench.rootPath to /mpy because workspace contains mpy/ folder');
          }
        } catch (e) {
          // ignore file system errors
        }
      }
    }
  } catch (e) {
    console.warn('[Extension] Failed to auto-set rootPath:', e);
  }
  refreshFilesViewTitle().catch(() => {});

  // Helper: verify the view id is contributed in package.json before creating it
  const isViewContributed = (id: string): boolean => {
    try {
      const contributes = context.extension.packageJSON?.contributes;
      if (!contributes || !contributes.views) return false;
      for (const container of Object.keys(contributes.views)) {
        const views = contributes.views[container];
        if (Array.isArray(views) && views.some((v: any) => v.id === id)) return true;
      }
      return false;
    } catch (e) {
      console.error('[Extension] Error checking contributed views', e);
      return false;
    }
  };

  const tree = new Esp32Tree();
  let view: vscode.TreeView<any> | undefined = undefined;
  if (isViewContributed("microPythonWorkBenchFsView")) {
    view = vscode.window.createTreeView("microPythonWorkBenchFsView", { treeDataProvider: tree });
  } else {
    console.error('[Extension] View not contributed: microPythonWorkBenchFsView');
  }
  const actionsTree = new ActionsTree();
  const refreshActionsTree = () => {
    try {
      actionsTree.refreshTree();
    } catch {}
  };
  let actionsView: vscode.TreeView<any> | undefined = undefined;
  if (isViewContributed("microPythonWorkBenchActionsView")) {
    actionsView = vscode.window.createTreeView("microPythonWorkBenchActionsView", { treeDataProvider: actionsTree });
  } else {
    console.error('[Extension] View not contributed: microPythonWorkBenchActionsView');
  }
  context.subscriptions.push(registerActionsTreeRefresh(refreshActionsTree));
  const syncTree = new SyncTree();
  let syncView: vscode.TreeView<any> | undefined = undefined;
  try {
    // Try to create the view regardless of package.json state. If the view is
    // not declared in package.json, creating it at runtime still makes the
    // UI available as a fallback (helps if package.json was modified or
    // corrupted in development).
    syncView = vscode.window.createTreeView("microPythonWorkBenchSyncView", { treeDataProvider: syncTree });
    // sync view created
    if (!isViewContributed("microPythonWorkBenchSyncView")) {
      console.warn('[Extension] Warning: microPythonWorkBenchSyncView not declared in package.json — created fallback view at runtime');
    }
  } catch (e) {
    console.error('[Extension] Failed to create Sync view:', e);
  }
  const decorations = new Esp32DecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));
  // Export decorations for use in other modules
  (global as any).esp32Decorations = decorations;

  // Create BoardOperations instance
  const boardOperations = new BoardOperations(tree, decorations);
  let lastLocalOnlyNotice = 0;

  // Status bar item to show workspace auto-sync state
  const autoSyncStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  autoSyncStatus.command = 'microPythonWorkBench.toggleWorkspaceAutoSync';
  autoSyncStatus.tooltip = 'Toggle workspace Auto-Sync on Save';
  context.subscriptions.push(autoSyncStatus);

  // NOTE: We no longer create a separate status bar item for "last auto-sync".
  // The last-sync information is shown in the tooltip of `autoSyncStatus`.

  // Output channel for auto-sync events
  const autoSyncOutput = vscode.window.createOutputChannel("MicroPython AutoSync");
  context.subscriptions.push(autoSyncOutput);

  const formatTime = (d: Date) => d.toLocaleTimeString();
  function updateLastAutoSyncStatus(ts?: Date, detail?: string, enabled?: boolean) {
    const baseHint = 'Toggle workspace Auto-Sync on Save (saved to extension workspace state, not written to settings)';
    if (enabled === false) {
      autoSyncStatus.tooltip = `Auto-sync is disabled\n${baseHint}`;
      return;
    }
    if (!ts) {
      autoSyncStatus.tooltip = `No auto-sync yet\n${baseHint}`;
      return;
    }
    const t = formatTime(ts);
    autoSyncStatus.tooltip = detail ? `Last auto-sync at ${t}\n${detail}\n${baseHint}` : `Last auto-sync at ${t}\n${baseHint}`;
  }

  // Status bar item for canceling all tasks
  const cancelTasksStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  cancelTasksStatus.command = 'microPythonWorkBench.cancelAllTasks';
  cancelTasksStatus.tooltip = 'Cancel all running tasks';
  cancelTasksStatus.text = 'MPY: Cancel';
  cancelTasksStatus.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  context.subscriptions.push(cancelTasksStatus);

  async function refreshAutoSyncStatus() {
    try {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        autoSyncStatus.text = 'MPY: no ws';
        autoSyncStatus.show();
        updateLastAutoSyncStatus(undefined, undefined, true);
        return;
      }
      const enabled = await workspaceAutoSyncEnabled(ws.uri.fsPath);
      autoSyncStatus.text = enabled ? 'MPY: AutoSync ON' : 'MPY: AutoSync OFF';
      autoSyncStatus.color = enabled ? undefined : new vscode.ThemeColor('statusBarItem.warningForeground');
      autoSyncStatus.show();
      if (enabled) updateLastAutoSyncStatus(undefined, undefined, true);
      else updateLastAutoSyncStatus(undefined, undefined, false);
    } catch (e) {
      autoSyncStatus.text = 'MPY: ?';
      autoSyncStatus.show();
      updateLastAutoSyncStatus(undefined, undefined, true);
    }
  }

  // Keep the sync view toggle label and status bar in sync
  async function refreshAutoSyncUi() {
    await refreshAutoSyncStatus();
    try { syncTree.refreshTree(); } catch {}
  }

  // Watch for workspace config changes in auto-sync config files to update the status
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    const wsPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const patterns = [
      new vscode.RelativePattern(wsPath, '.mpy-workbench/config.json'),
      new vscode.RelativePattern(wsPath, '.mpystudio/config.json') // legacy
    ];
    for (const cfgGlob of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(cfgGlob);
      watcher.onDidChange(refreshAutoSyncUi);
      watcher.onDidCreate(refreshAutoSyncUi);
      watcher.onDidDelete(refreshAutoSyncUi);
      context.subscriptions.push(watcher);
    }
  }
  // Keep status/toggle in sync if user edits VS Code settings.json directly
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('microPythonWorkBench.autoSyncOnSave')) {
        refreshAutoSyncUi().catch(() => {});
      }
    })
  );

  // Initialize status bar on activation
  refreshAutoSyncUi();
  cancelTasksStatus.show();
  isReplOpen();

  // On startup, check whether pyserial is available in the selected Python
  // environment and prompt the user to install if missing. Run non-blocking
  // so activation isn't delayed. Delay the check to avoid false prompts while
  // the Python extension is still starting up.
  const pythonTransportAvailabilityTimer = setTimeout(() => {
    PythonInterpreterManager.checkMpremoteAvailability().catch(err => {
      console.debug('[Extension] Python transport availability check failed (non-fatal):', err);
    });
  }, 10000);
  context.subscriptions.push({
    dispose: () => clearTimeout(pythonTransportAvailabilityTimer)
  });

  // Ensure sensible ignore files exist or are upgraded from old stub
  try {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) {
      ensureWorkbenchIgnoreFile(ws.uri.fsPath).catch(() => {});
    }
  } catch {}

  let opQueue: Promise<any> = Promise.resolve();
  let listingInProgress = false;
  let skipIdleOnce = false;
  function setSkipIdleOnce() { skipIdleOnce = true; }
  function normalizeReplBehavior(raw: string | undefined | null): "runChanged" | "executeBootMain" | "openReplEmpty" | "none" {
    if (raw === "runChanged" || raw === "executeBootMain" || raw === "openReplEmpty" || raw === "none") return raw;
    if (raw === "resumeCommand") return "runChanged"; // legacy
    if (raw === "softReset") return "executeBootMain"; // legacy
    return "none";
  }
  async function ensureIdle(): Promise<void> {
    // Keep this lightweight: do not chain kill/ctrl-c automatically.
    // Optionally perform a quick check to nudge the connection.
    try { await mp.ls("/"); } catch {}
    if (listingInProgress) {
      const d = vscode.workspace.getConfiguration().get<number>("microPythonWorkBench.preListDelayMs", 150);
      if (d > 0) await new Promise(r => setTimeout(r, d));
    }
  }
  async function withAutoSuspend<T>(fn: () => Promise<T>, opts: { preempt?: boolean; resumeReplCommand?: string; replBehavior?: "runChanged" | "executeBootMain" | "openReplEmpty" | "none" } = {}): Promise<T> {
    const enabled = vscode.workspace.getConfiguration().get<boolean>("microPythonWorkBench.serialAutoSuspend", true);
    // Optionally preempt any in-flight board operation so new command takes priority
    if (opts.preempt !== false) {
      opQueue = Promise.resolve();
    }
    // If auto-suspend disabled or explicitly skipping for this view action, run without ensureIdle/REPL juggling
    if (!enabled || skipIdleOnce) {
      skipIdleOnce = false;
      try { return await fn(); }
      finally { }
    }
    opQueue = opQueue.catch(() => {}).then(async () => {
      const snapshot = await suspendSerialSessionsForAutoSync();
      try {
        await ensureIdle();
        return await fn();
      } finally {
        try {
          // restoreSerialSessionsFromSnapshot start
          // If a replBehavior was explicitly requested by the caller, forward it.
          // Otherwise omit replBehavior so the restore function uses its default
          // behavior (which reopens REPL by default while keeping Run re-exec opt-in).
          await restoreSerialSessionsFromSnapshot(snapshot, { resumeReplCommand: opts.resumeReplCommand, replBehavior: opts.replBehavior });
          // restoreSerialSessionsFromSnapshot done
        } catch (err) {
          console.error("[DEBUG] restoreSerialSessionsFromSnapshot failed:", err);
        } finally {
          refreshActionsTree();
        }
      }
    });
    return opQueue as Promise<T>;
  }

  // Update the Files view header with the detected board name/ID (when available)
  async function refreshFilesViewTitle() {
    // Reset title/description first so stale labels disappear if detection fails
    if (view) {
      view.title = "Files";
      view.description = undefined;
    }

    const connect = mp.getActiveConnect();
    if (!connect || connect === "auto") return;

    try {
      const info = await withAutoSuspend(() => mp.detectBoardInfo(), { preempt: false });
      if (!info) return;
      try { boardInfoService.setBoardInfo(info); } catch {}
      const parts: string[] = [];
      if (info.machine) parts.push(info.machine);
      else if (info.sysname) parts.push(info.sysname);
      if (info.id) parts.push(info.id);
      const label = parts.join(" • ");
      if (label && view) {
        view.title = `Files — ${label}`;
        view.description = undefined;
      }
    } catch (error) {
      console.error("[DEBUG] refreshFilesViewTitle: failed to detect board label", error);
    }
  }

  // Try to show board name on startup if a fixed port is already selected
  refreshFilesViewTitle().catch(() => {});
  // Internal command used by mpremote module to signal cache population
  context.subscriptions.push(vscode.commands.registerCommand('microPythonWorkBench._cachePopulated', () => {
    try {
      // Allow listing and refresh the tree view
      tree.allowListing();
      // Clear the tree's incremental node cache so it will re-query the
      // populated global file-tree cache instead of returning stale nodes.
      try { tree.clearCache(); } catch {}
      tree.refreshTree();
    } catch (e) {
      console.warn('[Extension] _cachePopulated handler failed', e);
    }
  }));
  const initialConnect = mp.getActiveConnect();
  if (initialConnect && initialConnect !== "auto") {
    try { mp.refreshFileTreeCache().catch(() => {}); } catch {}
    tree.refreshTree();
  }

  async function refreshActiveConnectUi(): Promise<void> {
    updatePortContext();
    await refreshFilesViewTitle().catch(() => {});
    tree.requireManualRefresh();
    tree.clearCache();
    try { mp.clearFileTreeCache(); } catch {}
    const newConnect = mp.getActiveConnect();
    if (newConnect && newConnect !== "auto") {
      try { mp.refreshFileTreeCache().catch(() => {}); } catch {}
    }
    tree.refreshTree();
    refreshActionsTree();
  }

  if (view) context.subscriptions.push(view);
  if (actionsView) context.subscriptions.push(actionsView);
  if (syncView) context.subscriptions.push(syncView);
  context.subscriptions.push(
    vscode.commands.registerCommand("microPythonWorkBench.refresh", () => {
      utilityCommands.refresh(tree, decorations);
    }),
    vscode.commands.registerCommand("microPythonWorkBench.refreshFileTreeCache", async () => {
        try {
        await mp.refreshFileTreeCache();
        Localization.showInfo("messages.fileTreeCacheRefreshed");
      } catch (error: any) {
        console.error("File tree cache refresh failed:", error);
        Localization.showError("messages.fileTreeCacheRefreshFailed", error?.message || error);
      }
    }),
    vscode.commands.registerCommand("microPythonWorkBench.rebuildManifest", async () => {
      await rebuildManifest(tree);
    }),
    vscode.commands.registerCommand('microPythonWorkBench.refreshStubIndex', async () => {
      try {
        const config = vscode.workspace.getConfiguration('microPythonWorkBench');
        const installPath = config.get<string>('stubInstallPath', '.mpy-workbench/pyi');
        const extraPaths = config.get<string[]>('codeCompletionExtraPaths', []) || [];
        const ws = vscode.workspace.workspaceFolders?.[0];
        const root = ws ? ws.uri.fsPath : undefined;
        const resolvedInstall = root ? path.join(root, installPath) : installPath;
        const searchPaths = [resolvedInstall, ...extraPaths].filter(Boolean) as string[];
        refreshIndex(searchPaths);
        vscode.window.showInformationMessage('Stub index refreshed');
      } catch (e) {
        vscode.window.showErrorMessage('Failed to refresh stub index: ' + String(e));
      }
    }),
    vscode.commands.registerCommand('microPythonWorkBench.clearStubIndex', async () => {
      try {
        clearIndex();
        vscode.window.showInformationMessage('Stub index cleared');
      } catch (e) {
        vscode.window.showErrorMessage('Failed to clear stub index: ' + String(e));
      }
    }),
    vscode.commands.registerCommand('microPythonWorkBench.chooseStub', async () => {
      try {
        await codeCompletionManager.chooseStub();
      } catch (e) {
        console.error('[Extension] chooseStub command failed', e);
        vscode.window.showErrorMessage('选择 stub 失败: ' + (e instanceof Error ? e.message : String(e)));
      }
    }),
    vscode.commands.registerCommand("microPythonWorkBench.debugTreeParsing", debugCommands.debugTreeParsing),
    vscode.commands.registerCommand("microPythonWorkBench.debugFilesystemStatus", debugCommands.debugFilesystemStatus),
    vscode.commands.registerCommand("microPythonWorkBench.cancelAllTasks", debugCommands.cancelAllTasks),
    // 已移除外部 mpremote 安装与状态检查命令
    vscode.commands.registerCommand("microPythonWorkBench.pickPort", async () => {
      const selected = await boardCommands.pickPort();
      if (selected) await refreshActiveConnectUi();
    }),
    vscode.commands.registerCommand("microPythonWorkBench.serialSendCtrlC", replCommands.serialSendCtrlC),
    vscode.commands.registerCommand("microPythonWorkBench.stop", async () => {
      try {
        await replCommands.stop();
      } finally {
        refreshActionsTree();
      }
    }),
    vscode.commands.registerCommand("microPythonWorkBench.softReset", replCommands.softReset),
    vscode.commands.registerCommand("microPythonWorkBench.newFileBoardAndLocal", fileCommands.newFileBoardAndLocal),
    vscode.commands.registerCommand("microPythonWorkBench.openFileFromLocal", fileCommands.openFileFromLocal),
    vscode.commands.registerCommand("microPythonWorkBench.syncActiveFileLocalToBoard", fileCommands.syncActiveFileLocalToBoard),
    vscode.commands.registerCommand("microPythonWorkBench.syncFileLocalToBoard", fileCommands.syncFileLocalToBoard),
    vscode.commands.registerCommand("microPythonWorkBench.uploadToBoardHere", fileCommands.uploadToBoardHere),
    vscode.commands.registerCommand("microPythonWorkBench.syncFileBoardToLocal", fileCommands.syncFileBoardToLocal),
    vscode.commands.registerCommand("microPythonWorkBench.setPort", async (port: string) => {
      const selected = await boardCommands.setPort(port);
      if (selected) await refreshActiveConnectUi();
    }),
    // `flashMicroPython` command removed: esptool-based auto-flash was deleted
    vscode.commands.registerCommand("microPythonWorkBench.syncBaseline", syncCommands.syncBaseline),
    vscode.commands.registerCommand("microPythonWorkBench.syncBaselineFromBoard", syncCommands.syncBaselineFromBoard),



    vscode.commands.registerCommand("microPythonWorkBench.openSerial", async () => {
      try {
        await replCommands.openSerial();
      } finally {
        refreshActionsTree();
      }
    }),
    vscode.commands.registerCommand("microPythonWorkBench.openRepl", async () => {
      try {
        await openReplTerminal();
      } catch (error: any) {
        Localization.showError("messages.boardCommandFailed", error?.message ?? String(error));
      } finally {
        refreshActionsTree();
      }
    }),
    vscode.commands.registerCommand("microPythonWorkBench.closeRepl", async () => {
      try {
        await replCommands.closeRepl();
      } finally {
        refreshActionsTree();
      }
    }),
    vscode.commands.registerCommand("microPythonWorkBench.stopSerial", async () => {
      try {
        await closeReplTerminal(true);
        Localization.showInfo("messages.replClosed");
      } finally {
        refreshActionsTree();
      }
    }),

    vscode.commands.registerCommand("microPythonWorkBench.autoSuspendLs", async (pathArg: string) => {
      listingInProgress = true;
      try {
        const usePyRaw = vscode.workspace.getConfiguration().get<boolean>("microPythonWorkBench.usePyRawList", false);
        return await withAutoSuspend(() => (usePyRaw ? listDirPyRaw(pathArg) : mp.lsTyped(pathArg)), { preempt: false });
      } finally {
        listingInProgress = false;
      }
    }),
    // Keep welcome button visibility in sync if user changes settings directly
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('microPythonWorkBench.connect')) {
        refreshActiveConnectUi().catch(() => {});
      }
    }),

    vscode.commands.registerCommand("microPythonWorkBench.runActiveFile", runActiveFile),
    vscode.commands.registerCommand("microPythonWorkBench.checkDiffs", () => boardOperations.checkDiffs()),
    vscode.commands.registerCommand("microPythonWorkBench.syncDiffsLocalToBoard", syncCommands.syncDiffsLocalToBoard),
    vscode.commands.registerCommand("microPythonWorkBench.syncDiffsBoardToLocal", syncCommands.syncDiffsBoardToLocal),
    vscode.commands.registerCommand("microPythonWorkBench.openFile", fileCommands.openFile),
    vscode.commands.registerCommand("microPythonWorkBench.mkdir", fileCommands.mkdir),
    vscode.commands.registerCommand("microPythonWorkBench.delete", fileCommands.delete),
    vscode.commands.registerCommand("microPythonWorkBench.deleteBoardAndLocal", fileCommands.deleteBoardAndLocal),
    vscode.commands.registerCommand("microPythonWorkBench.deleteAllBoard", fileCommands.deleteAllBoard),
    vscode.commands.registerCommand("microPythonWorkBench.deleteAllBoardFromView", async () => {
      await vscode.commands.executeCommand("microPythonWorkBench.deleteAllBoard");
    }),
    // View wrappers: funnel commands from the view while keeping auto-suspend active
    vscode.commands.registerCommand("microPythonWorkBench.runFromView", async (cmd: string, ...args: any[]) => {
      try { await vscode.commands.executeCommand(cmd, ...args); } catch (e) {
        const msg = (e as any)?.message ?? String(e);
        Localization.showError("messages.boardCommandFailed", msg);
      }
    }),
    vscode.commands.registerCommand("microPythonWorkBench.syncBaselineFromView", async () => { await vscode.commands.executeCommand("microPythonWorkBench.syncBaseline"); }),
    vscode.commands.registerCommand("microPythonWorkBench.syncBaselineFromBoardFromView", async () => { await vscode.commands.executeCommand("microPythonWorkBench.syncBaselineFromBoard"); }),

    vscode.commands.registerCommand("microPythonWorkBench.checkDiffsFromView", async () => { await vscode.commands.executeCommand("microPythonWorkBench.checkDiffs"); }),
    vscode.commands.registerCommand("microPythonWorkBench.syncDiffsLocalToBoardFromView", async () => { await vscode.commands.executeCommand("microPythonWorkBench.syncDiffsLocalToBoard"); }),
    vscode.commands.registerCommand("microPythonWorkBench.syncDiffsBoardToLocalFromView", async () => { await vscode.commands.executeCommand("microPythonWorkBench.syncDiffsBoardToLocal"); }),
    vscode.commands.registerCommand("microPythonWorkBench.runActiveFileFromView", async () => { await vscode.commands.executeCommand("microPythonWorkBench.runActiveFile"); }),
    vscode.commands.registerCommand("microPythonWorkBench.openReplFromView", async () => { await vscode.commands.executeCommand("microPythonWorkBench.openRepl"); }),
    vscode.commands.registerCommand("microPythonWorkBench.openFileFromTree", fileCommands.openFileFromTree),
    vscode.commands.registerCommand("microPythonWorkBench.newFileInTree", fileCommands.newFileInTree),
    vscode.commands.registerCommand("microPythonWorkBench.newFolderInTree", fileCommands.newFolderInTree),
    vscode.commands.registerCommand("microPythonWorkBench.renameNode", fileCommands.renameNode)
  );
  // Auto-upload on save: if file is inside a workspace, push to device path mapped by microPythonWorkBench.rootPath
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
        if (!ws) return;
        // Determine configured local sync root; refuse to operate on workspace root implicitly
        let localRootDir: string;
        try {
          localRootDir = getLocalSyncRoot();
        } catch (err) {
          // Local sync root not configured — skip auto-upload to avoid touching workspace root
          const now = Date.now();
          if (now - lastLocalOnlyNotice > 5000) {
            vscode.window.setStatusBarMessage("Board: Auto sync skipped — local sync root not configured (see microPythonWorkBench.syncLocalRoot)", 5000);
            lastLocalOnlyNotice = now;
          }
          return;
        }
        // Only create .mpy-workbench directory if workspace is initialized (and local root present)
        const initialized = await isLocalSyncInitialized();
        if (!initialized) return;
        // ensure project config folder exists
    await ensureMpyWorkbenchDir(ws.uri.fsPath);
        const enabled = await workspaceAutoSyncEnabled(ws.uri.fsPath);
        if (!enabled) {
        return; // save locally only
      }
        const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
        const rel = path.relative(localRootDir, doc.uri.fsPath).replace(/\\/g, "/");
        // If file is outside the configured local sync root, do not auto-upload
        if (rel.startsWith('..') || path.isAbsolute(rel)) return;
        try {
          const matcher = await createIgnoreMatcher(localRootDir);
          if (matcher(rel, false)) {
            // Skip auto-upload for ignored files
            return;
          }
        } catch {}
        const normalizedRootPath = rootPath === "/" ? "" : rootPath.replace(/\/$/, "");
        const deviceDest = `${normalizedRootPath}/${rel}`;
      const rawBehavior = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.replRestoreBehavior", "openReplEmpty");
      const behavior = normalizeReplBehavior(rawBehavior);
      let resumeCmd: string | undefined;
      if (behavior === "runChanged") {
        const moduleName = deviceDest
          .replace(/^[\\/]+/, "")
          .replace(/\.py$/i, "")
          .replace(/[\\/]+/g, ".");
        const validModule = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(moduleName);
        if (validModule) {
          resumeCmd = `import ${moduleName}`;
        } else {
          // Skipping resume import; invalid module name derived
        }
      }
      try {
        // auto-sync resume prepared
        await withAutoSuspend(
          () => mp.cpToDevice(doc.uri.fsPath, deviceDest),
          { resumeReplCommand: resumeCmd, replBehavior: behavior }
        );
        tree.addNode(deviceDest, false);
        const ts = new Date();
        const detail = `${rel} → ${deviceDest}`;
        autoSyncOutput.appendLine(`[${ts.toISOString()}] Auto-sync OK: ${detail}`);
        updateLastAutoSyncStatus(ts, detail, true);
      }
      catch (e) {
        console.error(`[DEBUG] Auto-upload failed for ${rel}:`, e);
        Localization.showWarning("messages.boardAutoUploadFailed", rel, String((e as any)?.message ?? e));
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      // Delegate terminal close handling to mpremoteCommands which tracks Run/REPL terminals
      try {
        const { handleTerminalClose } = require("../board/mpremoteCommands");
        handleTerminalClose(terminal);
        refreshActionsTree();
      } catch (e) {
        console.error("[DEBUG] handleTerminalClose failed:", e);
      }
    })
  );
  // Command to toggle workspace-level autosync setting
  context.subscriptions.push(vscode.commands.registerCommand('microPythonWorkBench.toggleWorkspaceAutoSync', async () => {
    try {
      const ws = getWorkspaceFolder();
      const current = await workspaceAutoSyncEnabled(ws.uri.fsPath);
      const next = !current;
      // Persist the toggle to extension workspaceState (per-workspace storage), do not write VS Code settings
      await context.workspaceState.update('autoSyncOnSave', next);
      // Do NOT write to VS Code settings or package.json; this is intentionally kept as extension-scoped persistence
      try { await refreshAutoSyncUi(); } catch {}
    } catch (e) {
      try {
        const msg = String((e as any)?.message || e);
        Localization.showError("messages.toggleAutoSyncFailed", msg);
      } catch (inner) {
        Localization.showError("messages.toggleAutoSyncFailed", String(e));
      }
    }
  }));
}

export function deactivate() {}

// (no stray command registrations beyond this point)
/*
vscode.commands.registerCommand("microPythonWorkBench.rename", async (node: Esp32Node) => {
  if (!node) return;
  const oldPath = node.path;
  const isDir = node.kind === "dir";
  const base = path.posix.dirname(oldPath);
  const oldName = path.posix.basename(oldPath);
  const newName = await vscode.window.showInputBox({
    prompt: `Nuevo nombre para ${oldName}`,
    value: oldName,
    validateInput: v => v && v !== oldName ? undefined : "El nombre debe ser diferente y no vacío"
  });
  if (!newName || newName === oldName) return;
  const newPath = base === "/" ? `/${newName}` : `${base}/${newName}`;
  try {
    if (typeof mp.rename === "function") {
      await withAutoSuspend(() => mp.rename(oldPath, newPath));
    } else if (typeof mp.mv === "function") {
      await withAutoSuspend(() => mp.mv(oldPath, newPath));
    } else {
      Localization.showError("messages.noRenameFunction");
      return;
    }
    Localization.showInfo("messages.renameSuccess", oldPath, newPath);
    tree.refreshTree();
  } catch (err: any) {
    Localization.showError("messages.renameError", err?.message ?? err);
  }
});
*/
