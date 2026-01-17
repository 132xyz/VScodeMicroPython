
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface SyncActionNode { id: string; label: string; command: string }

export class SyncTree implements vscode.TreeDataProvider<SyncActionNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  refreshTree(): void { this._onDidChangeTreeData.fire(); }
  // Diagnostic helper: log when the view is asked to refresh
  logRefresh(): void { /* debug log removed */ }

  getTreeItem(element: SyncActionNode): vscode.TreeItem {
    return this.getTreeItemForAction(element);
  }

  async getChildren(): Promise<SyncActionNode[]> {
    return this.getActionNodes();
  }

  getTreeItemForAction(element: SyncActionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    if (element.id === "toggleAutoSync") {
      item.command = { command: "microPythonWorkBench.toggleWorkspaceAutoSync", title: element.label };
      item.iconPath = new vscode.ThemeIcon("sync");
    } else {
      item.command = { command: "microPythonWorkBench.runFromView", title: element.label, arguments: [element.command] };
      if (element.id === "baseline") item.iconPath = new vscode.ThemeIcon("cloud-upload");
      if (element.id === "baselineFromBoard") item.iconPath = new vscode.ThemeIcon("cloud-download");
      if (element.id === "checkDiffs") item.iconPath = new vscode.ThemeIcon("diff");
      if (element.id === "syncDiffsLocalToBoard") item.iconPath = new vscode.ThemeIcon("cloud-upload");
      if (element.id === "syncDiffsBoardToLocal") item.iconPath = new vscode.ThemeIcon("cloud-download");
      if (element.id === "deleteAllBoard") item.iconPath = new vscode.ThemeIcon("trash", new vscode.ThemeColor("charts.red"));
    }
    return item;
  }

  async getActionNodes(): Promise<SyncActionNode[]> {
    // building action nodes
    // Determina el estado actual de autosync para mostrarlo en el label
    let autoSyncLabel = "Toggle AutoSync";
    try {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        const inspected = vscode.workspace
          .getConfiguration(undefined, ws.uri)
          .inspect<boolean>('microPythonWorkBench.autoSyncOnSave');
        const settingValue =
          typeof inspected?.workspaceFolderValue === 'boolean' ? inspected.workspaceFolderValue :
          typeof inspected?.workspaceValue === 'boolean' ? inspected.workspaceValue :
          typeof inspected?.globalValue === 'boolean' ? inspected.globalValue :
          undefined;
        const legacyPath = path.join(ws.uri.fsPath, '.mpy-workbench', 'config.json');
        const legacyCfg = fs.existsSync(legacyPath)
          ? JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
          : {};
        const enabled = typeof settingValue === 'boolean'
          ? settingValue
          : typeof legacyCfg.autoSyncOnSave === 'boolean'
            ? legacyCfg.autoSyncOnSave
            : inspected?.defaultValue ?? false;
        autoSyncLabel = enabled ? 'AutoSync: ON (click to disable)' : 'AutoSync: OFF (click to enable)';
      }
    } catch {}
    // action nodes ready
    return [
      { id: "toggleAutoSync", label: autoSyncLabel, command: "microPythonWorkBench.toggleWorkspaceAutoSync" },
      { id: "baseline", label: "Upload all files (Local → Board)", command: "microPythonWorkBench.syncBaseline" },
      { id: "baselineFromBoard", label: "Download all files (Board → Local)", command: "microPythonWorkBench.syncBaselineFromBoard" },
      { id: "checkDiffs", label: "Check for differences (local vs board)", command: "microPythonWorkBench.checkDiffs" },
      { id: "syncDiffsLocalToBoard", label: "Sync changed Files Local → Board", command: "microPythonWorkBench.syncDiffsLocalToBoard" },
      { id: "syncDiffsBoardToLocal", label: "Sync changed Files Board → Local", command: "microPythonWorkBench.syncDiffsBoardToLocal" },
      { id: "deleteAllBoard", label: "Delete ALL files on Board", command: "microPythonWorkBench.deleteAllBoard" }
    ];
  }
}
