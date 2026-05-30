import * as vscode from "vscode";
import * as path from "node:path";
import * as mp from "../board/mpremote";
import {
  restoreSerialSessionsFromSnapshot,
  suspendSerialSessionsForAutoSync
} from "../board/mpremoteCommands";
import { getLocalSyncRoot } from "../core/workspaceUtils";
import { createIgnoreMatcher } from "./sync";

export type ReplRestoreBehavior = "runChanged" | "executeBootMain" | "openReplEmpty" | "none";

export type ActiveFileSyncErrorCode =
  | "NO_ACTIVE_EDITOR"
  | "INVALID_DOCUMENT"
  | "SAVE_FAILED"
  | "NO_WORKSPACE"
  | "LOCAL_ROOT_NOT_CONFIGURED"
  | "OUTSIDE_SYNC_ROOT"
  | "IGNORED_FILE";

export class ActiveFileSyncError extends Error {
  constructor(
    public readonly code: ActiveFileSyncErrorCode,
    message: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "ActiveFileSyncError";
  }
}

export type ActiveFileSyncTarget = {
  workspaceFolder: vscode.WorkspaceFolder;
  localRootDir: string;
  localPath: string;
  relativePath: string;
  devicePath: string;
  replBehavior: ReplRestoreBehavior;
  resumeReplCommand?: string;
};

export function toConfiguredSyncDevicePath(relativePath: string, rootPath: string): string {
  const normalizedRelativePath = relativePath.replace(/^\/+/, "");
  if (!normalizedRelativePath) {
    return rootPath === "/" ? "/" : rootPath.replace(/\/$/, "") || "/";
  }

  const normalizedRootPath = rootPath === "/" ? "" : rootPath.replace(/\/$/, "");
  return `${normalizedRootPath}/${normalizedRelativePath}`;
}

function normalizeReplBehavior(raw: string | undefined | null): ReplRestoreBehavior {
  if (raw === "runChanged" || raw === "executeBootMain" || raw === "openReplEmpty" || raw === "none") {
    return raw;
  }
  if (raw === "resumeCommand") return "runChanged";
  if (raw === "softReset") return "executeBootMain";
  return "none";
}

function buildResumeReplCommand(devicePath: string, behavior: ReplRestoreBehavior): string | undefined {
  if (behavior !== "runChanged") {
    return undefined;
  }

  const moduleName = devicePath
    .replace(/^[\\/]+/, "")
    .replace(/\.py$/i, "")
    .replace(/[\\/]+/g, ".");
  const validModule = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(moduleName);
  return validModule ? `import ${moduleName}` : undefined;
}

async function withAutoSuspend<T>(
  fn: () => Promise<T>,
  opts: { resumeReplCommand?: string; replBehavior?: ReplRestoreBehavior } = {}
): Promise<T> {
  const enabled = vscode.workspace.getConfiguration().get<boolean>("microPythonWorkBench.serialAutoSuspend", true);
  if (!enabled) {
    return fn();
  }

  const snapshot = await suspendSerialSessionsForAutoSync();
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    return await fn();
  } finally {
    try {
      await restoreSerialSessionsFromSnapshot(snapshot, {
        resumeReplCommand: opts.resumeReplCommand,
        replBehavior: opts.replBehavior
      });
    } catch (error) {
      console.error("[activeFileSync] Failed to restore serial sessions:", error);
    }
  }
}

export async function resolveActiveFileSyncTarget(document: vscode.TextDocument): Promise<ActiveFileSyncTarget> {
  if (document.isUntitled || document.uri.scheme !== "file") {
    throw new ActiveFileSyncError(
      "INVALID_DOCUMENT",
      "Active editor must be a saved local file before syncing."
    );
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    throw new ActiveFileSyncError(
      "NO_WORKSPACE",
      "Active file is outside the workspace and cannot be synced.",
      document.uri.fsPath
    );
  }

  let localRootDir: string;
  try {
    localRootDir = getLocalSyncRoot(workspaceFolder);
  } catch {
    throw new ActiveFileSyncError(
      "LOCAL_ROOT_NOT_CONFIGURED",
      "Local sync root not configured.",
      workspaceFolder.uri.fsPath
    );
  }

  const relativePath = path.relative(localRootDir, document.uri.fsPath).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new ActiveFileSyncError(
      "OUTSIDE_SYNC_ROOT",
      "Active file is outside the configured sync local root.",
      document.uri.fsPath
    );
  }

  const matcher = await createIgnoreMatcher(workspaceFolder.uri.fsPath);
  if (matcher(relativePath, false)) {
    throw new ActiveFileSyncError(
      "IGNORED_FILE",
      "Active file is ignored by sync rules.",
      relativePath
    );
  }

  const rootPath = vscode.workspace
    .getConfiguration(undefined, workspaceFolder.uri)
    .get<string>("microPythonWorkBench.rootPath", "/");
  const replBehavior = normalizeReplBehavior(
    vscode.workspace
      .getConfiguration(undefined, workspaceFolder.uri)
      .get<string>("microPythonWorkBench.replRestoreBehavior", "none")
  );
  const devicePath = toConfiguredSyncDevicePath(relativePath, rootPath);
  const resumeReplCommand = buildResumeReplCommand(devicePath, replBehavior);

  return {
    workspaceFolder,
    localRootDir,
    localPath: document.uri.fsPath,
    relativePath,
    devicePath,
    replBehavior,
    resumeReplCommand
  };
}

export async function uploadActiveFileSyncTarget(target: ActiveFileSyncTarget): Promise<ActiveFileSyncTarget> {
  await withAutoSuspend(
    () => mp.cpToDevice(target.localPath, target.devicePath),
    {
      resumeReplCommand: target.resumeReplCommand,
      replBehavior: target.replBehavior
    }
  );

  return target;
}

export async function syncDocumentToBoard(document: vscode.TextDocument): Promise<ActiveFileSyncTarget> {
  const target = await resolveActiveFileSyncTarget(document);
  return uploadActiveFileSyncTarget(target);
}

export async function syncActiveEditorToBoard(): Promise<ActiveFileSyncTarget> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new ActiveFileSyncError("NO_ACTIVE_EDITOR", "No active editor.");
  }

  if (editor.document.isDirty) {
    const saved = await editor.document.save();
    if (!saved) {
      throw new ActiveFileSyncError(
        "SAVE_FAILED",
        "Active editor must be saved before syncing.",
        editor.document.uri.fsPath
      );
    }
  }

  return syncDocumentToBoard(editor.document);
}