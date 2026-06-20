jest.mock('vscode');
jest.mock('path', () => jest.requireActual('path'));
jest.mock('node:path', () => jest.requireActual('path'));
jest.mock('node:fs', () => ({
  existsSync: jest.fn(),
  statSync: jest.fn(),
}));
jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));
jest.mock('../src/board/mpremote', () => ({
  getActiveConnect: jest.fn(() => 'serial://COM4'),
  normalizeConnect: jest.fn((connect: string) => connect.replace(/^serial:\/\/+/, '').replace(/^\//, '')),
  debugTreeParsing: jest.fn(),
  debugFilesystemStatus: jest.fn(),
  refreshFileTreeCache: jest.fn(),
}));
jest.mock('../src/board/mpremoteCommands', () => ({
  isReplOpen: jest.fn(),
  openReplTerminal: jest.fn(),
  disconnectReplTerminal: jest.fn(),
  suspendSerialSessionsForAutoSync: jest.fn(),
  restoreSerialSessionsFromSnapshot: jest.fn(),
  serialSendCtrlC: jest.fn(),
  stop: jest.fn(),
  softReset: jest.fn(),
  runActiveFile: jest.fn(),
  getReplTerminal: jest.fn(),
  closeReplTerminal: jest.fn(),
}));
jest.mock('../src/core/utilityOperations', () => ({
  rebuildManifest: jest.fn(),
  cancelAllTasks: jest.fn(),
  refresh: jest.fn(),
}));
jest.mock('../src/python/pythonInterpreter', () => ({
  getPythonPath: jest.fn(),
}));

const vscode = require('vscode') as typeof import('vscode');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const { execFile } = require('node:child_process') as typeof import('node:child_process');
const execFileMock = execFile as unknown as jest.Mock;
const mpremote = require('../src/board/mpremote') as {
  getActiveConnect: jest.Mock;
  debugTreeParsing: jest.Mock;
  debugFilesystemStatus: jest.Mock;
};
const mpremoteCommands = require('../src/board/mpremoteCommands') as {
  isReplOpen: jest.Mock;
  openReplTerminal: jest.Mock;
  disconnectReplTerminal: jest.Mock;
  serialSendCtrlC: jest.Mock;
  stop: jest.Mock;
  softReset: jest.Mock;
  runActiveFile: jest.Mock;
  closeReplTerminal: jest.Mock;
};
const {
  isReplOpen,
  openReplTerminal,
  disconnectReplTerminal,
  serialSendCtrlC,
  stop,
  softReset,
  runActiveFile,
  closeReplTerminal,
} = mpremoteCommands;
const utilityOperations = require('../src/core/utilityOperations') as {
  cancelAllTasks: jest.Mock;
  refresh: jest.Mock;
};
const { getPythonPath } = require('../src/python/pythonInterpreter') as {
  getPythonPath: jest.Mock;
};

class MockEventEmitter<T> {
  private listeners: Array<(value: T | undefined) => void> = [];

  event = (listener: (value: T | undefined) => void) => {
    this.listeners.push(listener);
    return { dispose: jest.fn() };
  };

  fire = (value?: T) => {
    for (const listener of this.listeners) {
      listener(value);
    }
  };
}

class MockTreeItem {
  label: string;
  collapsibleState: number;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  iconPath?: unknown;

  constructor(label: string, collapsibleState: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class MockThemeColor {
  id: string;

  constructor(id: string) {
    this.id = id;
  }
}

class MockThemeIcon {
  id: string;
  color?: MockThemeColor;

  constructor(id: string, color?: MockThemeColor) {
    this.id = id;
    this.color = color;
  }
}

describe('small core utilities coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mpremote.getActiveConnect.mockReturnValue('serial://COM4');

    (vscode as any).EventEmitter = MockEventEmitter;
    (vscode as any).TreeItem = MockTreeItem;
    (vscode as any).TreeItemCollapsibleState = { None: 0 };
    (vscode as any).ThemeIcon = MockThemeIcon;
    (vscode as any).ThemeColor = MockThemeColor;
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('ControlTree refreshes and builds colored tree items', async () => {
    const { ControlTree } = require('../src/core/control') as typeof import('../src/core/control');
    const tree = new ControlTree();
    const changed: boolean[] = [];
    tree.onDidChangeTreeData(() => changed.push(true));

    tree.refresh();
    expect(changed).toEqual([true]);

    const stopItem = tree.getTreeItem({ id: 'stop', label: 'Stop', command: 'mpy.stop' });
    expect(stopItem.contextValue).toBe('control');
    expect(stopItem.command).toEqual({ command: 'mpy.stop', title: 'Stop' });
    expect((stopItem.iconPath as MockThemeIcon).id).toBe('debug-stop');

    const interruptItem = tree.getTreeItem({
      id: 'interrupt',
      label: 'Interrupt',
      command: 'mpy.interrupt',
    });
    expect((interruptItem.iconPath as MockThemeIcon).id).toBe('debug-pause');

    const softResetItem = tree.getTreeItem({
      id: 'softreboot',
      label: 'Soft Reset',
      command: 'mpy.softReset',
    });
    expect((softResetItem.iconPath as MockThemeIcon).id).toBe('refresh');

    const plainItem = tree.getTreeItem({ id: 'other', label: 'Other', command: 'mpy.other' });
    expect(plainItem.iconPath).toBeUndefined();
    await expect(tree.getChildren()).resolves.toEqual([]);
  });

  test('ActionsTree switches between open repl and stop based on repl state', async () => {
    isReplOpen.mockReturnValue(false);
    const { ActionsTree, registerActionsTreeRefresh, refreshActionsTreeView } = require('../src/core/actions') as typeof import('../src/core/actions');
    const tree = new ActionsTree();
    const changed: boolean[] = [];
    tree.onDidChangeTreeData(() => changed.push(true));

    tree.refreshTree();
    expect(changed).toEqual([true]);

    const globalRefresh = jest.fn();
    const disposable = registerActionsTreeRefresh(globalRefresh);
    refreshActionsTreeView();
    expect(globalRefresh).toHaveBeenCalledTimes(1);
    disposable.dispose();
    refreshActionsTreeView();
    expect(globalRefresh).toHaveBeenCalledTimes(1);

    const closedNodes = await tree.getActionNodes();
    expect(closedNodes.map(node => node.id)).toEqual([
      'runActive',
      'openRepl',
      'softReset',
      'sendCtrlC',
    ]);

    const runItem = tree.getTreeItemForAction({
      id: 'runActive',
      label: 'Run',
      command: 'mpy.run',
      args: ['demo.py'],
    });
    expect(runItem.contextValue).toBe('action');
    expect(runItem.command).toEqual({
      command: 'microPythonWorkBench.runFromView',
      title: 'Run',
      arguments: ['mpy.run', 'demo.py'],
    });
    expect((runItem.iconPath as MockThemeIcon).id).toBe('play');

    const syncCurrentItem = tree.getTreeItemForAction({
      id: 'syncCurrent',
      label: 'Sync Current',
      command: 'mpy.syncCurrent',
    });
    expect((syncCurrentItem.iconPath as MockThemeIcon).id).toBe('repo-push');

    isReplOpen.mockReturnValue(true);
    const openNodes = await tree.getActionNodes();
    expect(openNodes.map(node => node.id)).toEqual([
      'runActive',
      'stop',
      'softReset',
      'sendCtrlC',
    ]);
  });

  test('workspace utils resolve configured and inferred sync roots', () => {
    const get = jest.fn().mockReturnValue('relative-sync');
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({ get });

    const utils = require('../src/core/workspaceUtils') as typeof import('../src/core/workspaceUtils');
    expect(utils.getLocalSyncRoot()).toBe(path.join('/workspace', 'relative-sync'));

    const absoluteRoot = path.resolve('/absolute-sync');
    get.mockReturnValue(absoluteRoot);
    expect(utils.getLocalSyncRoot()).toBe(absoluteRoot);

    get.mockReturnValue('');
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as any);
    expect(utils.getLocalSyncRoot()).toBe(path.join('/workspace', 'mpy'));

    (fs.existsSync as jest.Mock).mockReturnValue(false);
    expect(() => utils.getLocalSyncRoot()).toThrow('Local sync root not configured');

    expect(utils.getWorkspaceRoot()).toBe('/workspace');
    (vscode.workspace as any).workspaceFolders = [];
    expect(() => utils.getWorkspaceRoot()).toThrow('No workspace folder open');
  });

  test('listDirPyRaw executes helper script and normalizes results', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockReturnValue('serial://COM4'),
    });
    (vscode.extensions.getExtension as jest.Mock).mockReturnValue({ extensionPath: '/extension-root' });
    getPythonPath.mockResolvedValue('/usr/bin/python3');
    execFileMock.mockImplementation(
      (
        _pythonPath: string,
        _args: string[],
        _options: { timeout: number },
        callback: (err: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify([{ name: 'main.py', isDir: false }]), '')
    );

    const { listDirPyRaw } = require('../src/python/pyraw') as typeof import('../src/python/pyraw');
    await expect(listDirPyRaw('/')).resolves.toEqual([{ name: 'main.py', isDir: false }]);
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/python3',
      [
        path.join('/extension-root', 'scripts', 'thonny_list_files.py'),
        '--port',
        'COM4',
        '--baudrate',
        '115200',
        '--path',
        '/',
      ],
      { timeout: 10000 },
      expect.any(Function)
    );

    execFileMock.mockImplementation(
      (
        _pythonPath: string,
        _args: string[],
        _options: { timeout: number },
        callback: (err: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, 'not-json', '')
    );
    await expect(listDirPyRaw('/')).resolves.toEqual([]);

    execFileMock.mockImplementation(
      (
        _pythonPath: string,
        _args: string[],
        _options: { timeout: number },
        callback: (err: Error | null, stdout: string, stderr: string) => void,
      ) => callback(new Error('boom'), '', 'stderr boom')
    );
    await expect(listDirPyRaw('/')).rejects.toThrow('stderr boom');

    mpremote.getActiveConnect.mockReturnValue('auto');
    await expect(listDirPyRaw('/')).rejects.toThrow('No fixed serial port selected');
  });

  test('boardInfoService stores state and notifies listeners', () => {
    const { boardInfoService } = require('../src/board/boardInfoService') as typeof import('../src/board/boardInfoService');
    const seen: unknown[] = [];
    boardInfoService.clearBoardInfo();
    boardInfoService.onDidChange(info => seen.push(info));

    const info = { board: 'esp32', port: 'COM4' } as any;
    boardInfoService.setBoardInfo(info);
    expect(boardInfoService.getBoardInfo()).toBe(info);

    boardInfoService.clearBoardInfo();
    expect(boardInfoService.getBoardInfo()).toBeNull();
    expect(seen).toEqual([info, null]);
  });

  test('debugCommands delegate to debug helpers and surface failures', async () => {
    const { debugCommands } = require('../src/commands/debugCommands') as typeof import('../src/commands/debugCommands');
    mpremote.debugTreeParsing.mockResolvedValue(undefined);
    mpremote.debugFilesystemStatus.mockResolvedValue(undefined);
    utilityOperations.cancelAllTasks.mockResolvedValue(undefined);

    await debugCommands.debugTreeParsing();
    await debugCommands.debugFilesystemStatus();
    await debugCommands.rebuildManifest();
    await debugCommands.cancelAllTasks();

    expect(mpremote.debugTreeParsing).toHaveBeenCalled();
    expect(mpremote.debugFilesystemStatus).toHaveBeenCalled();
    expect(utilityOperations.cancelAllTasks).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Tree parsing debug completed - check console for details'
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Filesystem status debug completed - check console for details'
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Rebuild manifest functionality moved'
    );

    mpremote.debugTreeParsing.mockRejectedValueOnce(new Error('tree boom'));
    mpremote.debugFilesystemStatus.mockRejectedValueOnce(new Error('fs boom'));

    await debugCommands.debugTreeParsing();
    await debugCommands.debugFilesystemStatus();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Tree parsing debug failed: tree boom'
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Filesystem status debug failed: fs boom'
    );
  });

  test('replCommands route serial actions and fallback on close failure', async () => {
    const { replCommands } = require('../src/commands/replCommands') as typeof import('../src/commands/replCommands');

    await replCommands.openRepl();
    expect(openReplTerminal).toHaveBeenCalled();

    isReplOpen.mockReturnValue(true);
    await replCommands.stopSerial();
    expect(disconnectReplTerminal).toHaveBeenCalled();

    isReplOpen.mockReturnValue(false);
    await replCommands.stopSerial();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'No REPL terminal is currently open'
    );

    closeReplTerminal.mockRejectedValueOnce(new Error('close failed'));
    stop.mockResolvedValueOnce(undefined);
    await replCommands.stop();
    expect(closeReplTerminal).toHaveBeenCalledWith(true);
    expect(stop).toHaveBeenCalled();

    expect(replCommands.serialSendCtrlC).toBe(serialSendCtrlC);
    expect(replCommands.runActiveFile).toBe(runActiveFile);
    expect(replCommands.openSerial).toBe(openReplTerminal);
    expect(replCommands.softReset).toBe(softReset);
  });

  test('utilityCommands refresh delegates to utilityOperations refresh', async () => {
    const { utilityCommands } = require('../src/commands/utilityCommands') as typeof import('../src/commands/utilityCommands');
    const tree = { refreshTree: jest.fn() } as any;
    const decorations = { updateFileState: jest.fn() } as any;

    await utilityCommands.refresh(tree, decorations);
    expect(utilityOperations.refresh).toHaveBeenCalledWith(tree, decorations);
  });
});

export {};
