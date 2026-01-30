import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';

export function getLocalSyncRoot(): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('No workspace folder open');
  const syncLocalRoot = vscode.workspace.getConfiguration().get<string>('microPythonWorkBench.syncLocalRoot', '');
  // If configured explicitly, honor absolute or workspace-relative paths
  if (syncLocalRoot && syncLocalRoot.trim().length > 0) {
    if (path.isAbsolute(syncLocalRoot)) return syncLocalRoot;
    return path.join(ws.uri.fsPath, syncLocalRoot);
  }
  // No explicit config: prefer workspace/mpy if present (safer than using workspace root)
  const candidate = path.join(ws.uri.fsPath, 'mpy');
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  } catch {}
  // If no configured local root and no workspace/mpy, require explicit configuration
  throw new Error('Local sync root not configured');
}

export function getWorkspaceRoot(): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('No workspace folder open');
  return ws.uri.fsPath;
}
