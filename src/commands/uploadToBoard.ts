import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as mp from "../board/mpremote";
import {
  restoreSerialSessionsFromSnapshot,
  suspendSerialSessionsForAutoSync,
} from "../board/mpremoteCommands";
import { Esp32Node } from "../core/types";
import { refreshActionsTreeView } from "../core/actions";

interface UploadEntry {
  localPath: string;
  devicePath: string;
  isDirectory: boolean;
  size: number;
}

interface UploadSourcePick extends vscode.QuickPickItem {
  sourceKind: "files" | "folders";
}

function normalizeDeviceDir(devicePath: string): string {
  const normalized = (devicePath || "/").replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized ? (normalized.startsWith("/") ? normalized : `/${normalized}`) : "/";
}

function joinDevicePath(parent: string, name: string): string {
  const safeName = name.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const base = normalizeDeviceDir(parent);
  return base === "/" ? `/${safeName}` : `${base}/${safeName}`;
}

function getUploadTargetDir(node?: Esp32Node): string {
  if (!node || (node as any).isContextAnchor) return "/";
  return node.kind === "dir" ? node.path : path.posix.dirname(node.path);
}

async function collectDirectoryUploadEntries(localDir: string, deviceDir: string): Promise<UploadEntry[]> {
  const entries: UploadEntry[] = [{ localPath: localDir, devicePath: deviceDir, isDirectory: true, size: 0 }];
  const children = await fs.readdir(localDir, { withFileTypes: true });

  for (const child of children) {
    const childLocalPath = path.join(localDir, child.name);
    const childDevicePath = joinDevicePath(deviceDir, child.name);
    if (child.isDirectory()) {
      entries.push(...await collectDirectoryUploadEntries(childLocalPath, childDevicePath));
    } else if (child.isFile()) {
      const stat = await fs.stat(childLocalPath);
      entries.push({ localPath: childLocalPath, devicePath: childDevicePath, isDirectory: false, size: stat.size });
    }
  }

  return entries;
}

async function collectUploadEntries(localPath: string, targetDir: string): Promise<UploadEntry[]> {
  const stat = await fs.stat(localPath);
  const name = path.basename(localPath);
  if (!name) return [];
  const devicePath = joinDevicePath(targetDir, name);

  if (stat.isDirectory()) {
    return collectDirectoryUploadEntries(localPath, devicePath);
  }
  if (stat.isFile()) {
    return [{ localPath, devicePath, isDirectory: false, size: stat.size }];
  }

  return [];
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function createUploadCancelledError(): Error & { code?: string } {
  const error = new Error("Upload cancelled") as Error & { code?: string };
  error.code = "cancelled";
  return error;
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw createUploadCancelledError();
}

function isCancelledError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | undefined;
  return candidate?.code === "cancelled" || candidate?.message === "Upload cancelled";
}

async function withUploadAutoSuspend<T>(fn: () => Thenable<T>): Promise<T> {
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
      await restoreSerialSessionsFromSnapshot(snapshot, { replBehavior: "openReplEmpty" });
    } catch (error) {
      console.error("[uploadToBoard] Failed to restore serial sessions:", error);
    } finally {
      refreshActionsTreeView();
    }
  }
}

async function pickUploadSources(targetDir: string): Promise<vscode.Uri[] | undefined> {
  const source = await vscode.window.showQuickPick<UploadSourcePick>([
    { label: "Files", description: "Upload one or more local files", sourceKind: "files" },
    { label: "Folders", description: "Upload folder contents recursively", sourceKind: "folders" },
  ], {
    placeHolder: `Choose what to upload to ${targetDir}`,
  });
  if (!source) return undefined;

  const isFileMode = source.sourceKind === "files";
  return vscode.window.showOpenDialog({
    canSelectFiles: isFileMode,
    canSelectFolders: !isFileMode,
    canSelectMany: true,
    openLabel: "Upload",
    title: isFileMode ? `Upload files to ${targetDir}` : `Upload folders to ${targetDir}`
  });
}

export async function uploadToBoardHere(node?: Esp32Node): Promise<void> {
  const targetDir = getUploadTargetDir(node);
  const selected = await pickUploadSources(targetDir);
  if (!selected || selected.length === 0) return;

  let touchedBoard = false;
  try {
    const uploadEntries: UploadEntry[] = [];
    for (const uri of selected) {
      uploadEntries.push(...await collectUploadEntries(uri.fsPath, targetDir));
    }
    if (uploadEntries.length === 0) {
      vscode.window.showInformationMessage("No uploadable files or folders selected.");
      return;
    }

    const fileCount = uploadEntries.filter(entry => !entry.isDirectory).length;
    const directoryCount = uploadEntries.length - fileCount;
    const totalBytes = uploadEntries.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.size), 0);

    await withUploadAutoSuspend(() => vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Uploading to ${targetDir}...`,
      cancellable: true
    }, async (progress, token) => {
      const startedAt = Date.now();
      const transferredByPath = new Map<string, number>();
      let lastPercent = 0;

      const reportTransfer = (entry: UploadEntry, bytes: number, total: number) => {
        transferredByPath.set(entry.devicePath, Math.min(Math.max(bytes, 0), total || entry.size));
        const transferred = Array.from(transferredByPath.values()).reduce((sum, value) => sum + value, 0);
        const percent = totalBytes > 0 ? Math.min(100, (transferred / totalBytes) * 100) : 0;
        const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
        const speed = transferred / elapsedSeconds;
        const increment = Math.max(0, percent - lastPercent);
        lastPercent = Math.max(lastPercent, percent);
        progress.report({
          increment,
          message: `${entry.devicePath} ${formatBytes(bytes)}/${formatBytes(total || entry.size)} (${percent.toFixed(1)}%, ${formatSpeed(speed)})`
        });
      };

      for (let index = 0; index < uploadEntries.length; index++) {
        throwIfCancelled(token);
        const entry = uploadEntries[index];
        progress.report({ increment: 0, message: `${index + 1}/${uploadEntries.length}: ${entry.devicePath}` });
        touchedBoard = true;
        if (entry.isDirectory) {
          await mp.mkdir(entry.devicePath);
          if (totalBytes === 0) {
            progress.report({ increment: 100 / uploadEntries.length, message: `${index + 1}/${uploadEntries.length}: ${entry.devicePath}` });
          }
        } else {
          await mp.uploadReplacingWithProgress(entry.localPath, entry.devicePath, event => {
            reportTransfer(entry, event.bytes, event.total);
          }, { token });
          reportTransfer(entry, entry.size, entry.size);
        }
      }
    }));

    await vscode.commands.executeCommand("microPythonWorkBench.refresh");
    vscode.window.showInformationMessage(`Uploaded ${fileCount} file(s) and ${directoryCount} folder(s) to ${targetDir}`);
  } catch (err: any) {
    if (touchedBoard) {
      try { await vscode.commands.executeCommand("microPythonWorkBench.refresh"); } catch {}
    }
    if (isCancelledError(err)) {
      vscode.window.showInformationMessage("Upload cancelled.");
      return;
    }
    vscode.window.showErrorMessage(`Upload to board failed: ${err?.message ?? String(err)}`);
  }
}
