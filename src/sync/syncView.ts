
import * as vscode from "vscode";

export interface SyncActionNode { id: string; label: string; command: string }

export class SyncTree implements vscode.TreeDataProvider<SyncActionNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly getAutoSyncEnabled: () => boolean | Thenable<boolean> = () => false) {}

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
      if (element.id === "syncActiveFileLocalToBoard") item.iconPath = new vscode.ThemeIcon("repo-push");
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
      const enabled = await Promise.resolve(this.getAutoSyncEnabled());
      autoSyncLabel = enabled ? 'AutoSync: ON (click to disable)' : 'AutoSync: OFF (click to enable)';
    } catch {}
    // action nodes ready
    return [
      { id: "toggleAutoSync", label: autoSyncLabel, command: "microPythonWorkBench.toggleWorkspaceAutoSync" },
      { id: "baseline", label: "Upload all files (Local → Board)", command: "microPythonWorkBench.syncBaseline" },
      { id: "syncActiveFileLocalToBoard", label: "Upload active file (Local → Board)", command: "microPythonWorkBench.syncActiveFileLocalToBoard" },
      { id: "baselineFromBoard", label: "Download all files (Board → Local)", command: "microPythonWorkBench.syncBaselineFromBoard" },
      { id: "checkDiffs", label: "Check for differences (local vs board)", command: "microPythonWorkBench.checkDiffs" },
      { id: "syncDiffsLocalToBoard", label: "Sync changed Files Local → Board", command: "microPythonWorkBench.syncDiffsLocalToBoard" },
      { id: "syncDiffsBoardToLocal", label: "Sync changed Files Board → Local", command: "microPythonWorkBench.syncDiffsBoardToLocal" },
      { id: "deleteAllBoard", label: "Delete ALL files on Board", command: "microPythonWorkBench.deleteAllBoard" }
    ];
  }
}
