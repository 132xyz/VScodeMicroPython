import * as vscode from 'vscode';
import * as path from 'node:path';

export function getLocalSyncRoot(): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('No workspace folder open');
  const syncLocalRoot = vscode.workspace.getConfiguration().get<string>('microPythonWorkBench.syncLocalRoot', '');
  if (!syncLocalRoot || syncLocalRoot.trim().length === 0) return ws.uri.fsPath;
  if (path.isAbsolute(syncLocalRoot)) return syncLocalRoot;
  return path.join(ws.uri.fsPath, syncLocalRoot);
}

export function getWorkspaceRoot(): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('No workspace folder open');
  return ws.uri.fsPath;
}
