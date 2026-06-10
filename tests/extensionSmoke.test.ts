jest.mock('vscode');
jest.mock('node:path', () => jest.requireActual('node:path'));
jest.mock('node:fs/promises', () => ({
  access: jest.fn().mockRejectedValue(new Error('missing')),
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockRejectedValue(new Error('missing')),
}));
jest.mock('node:fs', () => ({
  existsSync: jest.fn(() => false),
  statSync: jest.fn(() => ({ isDirectory: () => false })),
}));
jest.mock('../src/board/esp32Fs', () => ({
  Esp32Tree: jest.fn().mockImplementation(() => ({
    clearCache: jest.fn(),
    refreshTree: jest.fn(),
    allowListing: jest.fn(),
    requireManualRefresh: jest.fn(),
    addNode: jest.fn(),
  })),
}));
jest.mock('../src/core/actions', () => ({
  ActionsTree: jest.fn().mockImplementation(() => ({
    refreshTree: jest.fn(),
  })),
}));
jest.mock('../src/sync/syncView', () => ({
  SyncTree: jest.fn().mockImplementation(() => ({
    refreshTree: jest.fn(),
  })),
}));
jest.mock('../src/core/workspaceUtils', () => ({
  getLocalSyncRoot: jest.fn(() => '/workspace/src'),
}));
jest.mock('../src/board/mpremote', () => ({
  getActiveConnect: jest.fn(() => 'auto'),
  clearSelectedConnect: jest.fn(),
  clearFileTreeCache: jest.fn(),
  refreshFileTreeCache: jest.fn().mockResolvedValue(undefined),
  ls: jest.fn().mockResolvedValue([]),
  lsTyped: jest.fn().mockResolvedValue([]),
  detectBoardInfo: jest.fn().mockResolvedValue(null),
  cpToDevice: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/sync/sync', () => ({
  buildManifest: jest.fn(),
  diffManifests: jest.fn(),
  saveManifest: jest.fn(),
  loadManifest: jest.fn(),
  defaultIgnorePatterns: jest.fn(() => ['node_modules/']),
  createIgnoreMatcher: jest.fn(async () => () => false),
}));
jest.mock('../src/ui/decorations', () => ({
  Esp32DecorationProvider: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../src/python/pyraw', () => ({
  listDirPyRaw: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/board/boardOperations', () => ({
  BoardOperations: jest.fn().mockImplementation(() => ({
    checkDiffs: jest.fn(),
  })),
}));
jest.mock('../src/python/pythonInterpreter', () => ({
  PythonInterpreterManager: {
    checkMpremoteAvailability: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../src/core/utilityOperations', () => ({
  refresh: jest.fn(),
  rebuildManifest: jest.fn().mockResolvedValue(undefined),
  cancelAllTasks: jest.fn(),
}));
jest.mock('../src/board/mpremoteCommands', () => ({
  disconnectReplTerminal: jest.fn(),
  suspendSerialSessionsForAutoSync: jest.fn().mockResolvedValue({}),
  restoreSerialSessionsFromSnapshot: jest.fn().mockResolvedValue(undefined),
  checkMpremoteAvailability: jest.fn(),
  serialSendCtrlC: jest.fn(),
  stop: jest.fn().mockResolvedValue(undefined),
  softReset: jest.fn(),
  runActiveFile: jest.fn(),
  isReplOpen: jest.fn(),
  closeReplTerminal: jest.fn().mockResolvedValue(undefined),
  openReplTerminal: jest.fn().mockResolvedValue(undefined),
  toLocalRelative: jest.fn(),
  toDevicePath: jest.fn(),
  handleTerminalClose: jest.fn(),
}));
jest.mock('../src/commands/fileCommands', () => ({
  fileCommands: {
    newFileBoardAndLocal: jest.fn(),
    openFileFromLocal: jest.fn(),
    syncActiveFileLocalToBoard: jest.fn(),
    syncFileLocalToBoard: jest.fn(),
    syncFileBoardToLocal: jest.fn(),
    openFile: jest.fn(),
    mkdir: jest.fn(),
    delete: jest.fn(),
    deleteBoardAndLocal: jest.fn(),
    deleteAllBoard: jest.fn(),
    newFileInTree: jest.fn(),
    newFolderInTree: jest.fn(),
    renameNode: jest.fn(),
  },
}));
jest.mock('../src/commands/syncCommands', () => ({
  syncCommands: {
    syncBaseline: jest.fn(),
    syncBaselineFromBoard: jest.fn(),
    syncDiffsLocalToBoard: jest.fn(),
    syncDiffsBoardToLocal: jest.fn(),
  },
}));
jest.mock('../src/commands/boardCommands', () => ({
  boardCommands: {
    pickPort: jest.fn(),
    setPort: jest.fn(),
  },
}));
jest.mock('../src/commands/replCommands', () => ({
  replCommands: {
    serialSendCtrlC: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
    softReset: jest.fn(),
  },
}));
jest.mock('../src/commands/debugCommands', () => ({
  debugCommands: {
    debugTreeParsing: jest.fn(),
    debugFilesystemStatus: jest.fn(),
    cancelAllTasks: jest.fn(),
  },
}));
jest.mock('../src/commands/utilityCommands', () => ({
  utilityCommands: {
    refresh: jest.fn(),
  },
}));
jest.mock('../src/core/localization', () => ({
  Localization: {
    t: jest.fn((key: string) => key),
    showInfo: jest.fn(),
    showError: jest.fn(),
    showWarning: jest.fn(),
  },
}));
jest.mock('../src/completion/codeCompletion', () => ({
  codeCompletionManager: {
    initialize: jest.fn().mockResolvedValue(undefined),
    chooseStub: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../src/board/boardInfoService', () => ({
  boardInfoService: {
    setBoardInfo: jest.fn(),
  },
}));
jest.mock('../src/completion/stubIndex', () => ({
  refreshIndex: jest.fn(),
  clearIndex: jest.fn(),
}));

const vscode = require('vscode') as typeof import('vscode');
const fsPromises = require('node:fs/promises') as {
  access: jest.Mock;
};
const codeCompletionModule = require('../src/completion/codeCompletion') as {
  codeCompletionManager: {
    initialize: jest.Mock;
    chooseStub: jest.Mock;
  };
};
const pythonInterpreterModule = require('../src/python/pythonInterpreter') as {
  PythonInterpreterManager: {
    checkMpremoteAvailability: jest.Mock;
  };
};
const mpModule = require('../src/board/mpremote') as {
  refreshFileTreeCache: jest.Mock;
  cpToDevice: jest.Mock;
};
const stubIndexModule = require('../src/completion/stubIndex') as {
  refreshIndex: jest.Mock;
  clearIndex: jest.Mock;
};
const localizationModule = require('../src/core/localization') as {
  Localization: {
    showInfo: jest.Mock;
    showError: jest.Mock;
  };
};
const mpremoteCommandsModule = require('../src/board/mpremoteCommands') as {
  openReplTerminal: jest.Mock;
  closeReplTerminal: jest.Mock;
  suspendSerialSessionsForAutoSync: jest.Mock;
  restoreSerialSessionsFromSnapshot: jest.Mock;
};

function createStatusBarItem() {
  return {
    command: undefined,
    tooltip: '',
    text: '',
    color: undefined,
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  };
}

function getRegisteredCommandHandler(name: string): (...args: unknown[]) => unknown {
  const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
  const match = calls.find(([commandName]) => commandName === name);
  if (!match) {
    throw new Error(`command not registered: ${name}`);
  }
  return match[1];
}

describe('extension activate smoke coverage', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    (vscode as any).ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
    (vscode as any).StatusBarAlignment = { Left: 1, Right: 2 };
    (vscode as any).ThemeColor = jest.fn((value: string) => ({ value }));
    (vscode as any).RelativePattern = jest.fn((base: string, pattern: string) => ({ base, pattern }));
    (vscode.Uri as any).file = jest.fn((fsPath: string) => ({ fsPath }));

    const globalConfig = {
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'microPythonWorkBench.connect') return 'auto';
        if (key === 'microPythonWorkBench.debug') return false;
        if (key === 'microPythonWorkBench.preListDelayMs') return 0;
        if (key === 'microPythonWorkBench.serialAutoSuspend') return true;
        if (key === 'microPythonWorkBench.usePyRawList') return false;
        if (key === 'microPythonWorkBench.rootPath') return '/';
        if (key === 'microPythonWorkBench.replRestoreBehavior') return 'none';
        return defaultValue;
      }),
      update: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn(() => ({ defaultValue: false })),
    };
    const mpyConfig = {
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'stubInstallPath') return '.mpy-workbench/pyi';
        if (key === 'codeCompletionExtraPaths') return [];
        return defaultValue;
      }),
      update: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn(() => ({ defaultValue: false })),
    };

    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.workspace as any).getWorkspaceFolder = jest.fn(() => ({ uri: { fsPath: '/workspace' } }));
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => {
      if (section === 'microPythonWorkBench') return mpyConfig;
      return globalConfig;
    });
    (vscode.workspace as any).onDidChangeConfiguration = jest.fn(() => ({ dispose: jest.fn() }));
    (vscode.workspace as any).onDidSaveTextDocument = jest.fn(() => ({ dispose: jest.fn() }));
    (vscode.workspace as any).createFileSystemWatcher = jest.fn(() => ({
      onDidChange: jest.fn(),
      onDidCreate: jest.fn(),
      onDidDelete: jest.fn(),
      dispose: jest.fn(),
    }));

    (vscode.window as any).createStatusBarItem = jest
      .fn()
      .mockReturnValueOnce(createStatusBarItem())
      .mockReturnValueOnce(createStatusBarItem())
      .mockReturnValueOnce(createStatusBarItem())
      .mockReturnValueOnce(createStatusBarItem());
    (vscode.window as any).createTreeView = jest.fn((id: string) => ({
      id,
      title: id,
      description: undefined,
      dispose: jest.fn(),
    }));
    (vscode.window as any).registerFileDecorationProvider = jest.fn(() => ({ dispose: jest.fn() }));
    (vscode.window as any).createOutputChannel = jest.fn(() => ({ appendLine: jest.fn(), dispose: jest.fn() }));
    (vscode.window as any).onDidCloseTerminal = jest.fn(() => ({ dispose: jest.fn() }));
    (vscode.window as any).showInformationMessage = jest.fn();
    (vscode.window as any).showWarningMessage = jest.fn();
    (vscode.window as any).showErrorMessage = jest.fn();

    (vscode.commands as any).registerCommand = jest.fn((_name: string, callback: (...args: unknown[]) => unknown) => ({
      callback,
      dispose: jest.fn(),
    }));
    (vscode.commands as any).executeCommand = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('activate registers views commands and startup hooks', async () => {
    const { activate } = require('../src/core/extension') as typeof import('../src/core/extension');
    const context = {
      workspaceState: {
        get: jest.fn(() => undefined),
        update: jest.fn().mockResolvedValue(undefined),
      },
      subscriptions: [] as Array<{ dispose?: () => void }>,
      extension: {
        packageJSON: {
          contributes: {
            views: {
              explorer: [
                { id: 'microPythonWorkBenchFsView' },
                { id: 'microPythonWorkBenchActionsView' },
                { id: 'microPythonWorkBenchSyncView' },
              ],
            },
          },
        },
      },
    } as any;

    await activate(context);
    jest.runOnlyPendingTimers();

    expect(codeCompletionModule.codeCompletionManager.initialize).toHaveBeenCalledWith(context);
    expect(vscode.workspace.getConfiguration).toHaveBeenCalled();
    expect(vscode.commands.registerCommand).toHaveBeenCalled();
    expect(vscode.window.createTreeView).toHaveBeenCalledWith('microPythonWorkBenchFsView', expect.any(Object));
    expect(vscode.window.createTreeView).toHaveBeenCalledWith('microPythonWorkBenchActionsView', expect.any(Object));
    expect(vscode.window.createTreeView).toHaveBeenCalledWith('microPythonWorkBenchSyncView', expect.any(Object));
    expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
    expect(pythonInterpreterModule.PythonInterpreterManager.checkMpremoteAvailability).toHaveBeenCalled();
    expect(context.subscriptions.length).toBeGreaterThan(10);
  });

  test('activate command callbacks and autosave handler execute expected branches', async () => {
    const { activate } = require('../src/core/extension') as typeof import('../src/core/extension');
    const context = {
      workspaceState: {
        get: jest.fn((key: string) => (key === 'autoSyncOnSave' ? true : undefined)),
        update: jest.fn().mockResolvedValue(undefined),
      },
      subscriptions: [] as Array<{ dispose?: () => void }>,
      extension: {
        packageJSON: {
          contributes: {
            views: {
              explorer: [
                { id: 'microPythonWorkBenchFsView' },
                { id: 'microPythonWorkBenchActionsView' },
                { id: 'microPythonWorkBenchSyncView' },
              ],
            },
          },
        },
      },
    } as any;

    await activate(context);

    const refreshStubIndex = getRegisteredCommandHandler('microPythonWorkBench.refreshStubIndex');
    const clearStubIndex = getRegisteredCommandHandler('microPythonWorkBench.clearStubIndex');
    const chooseStub = getRegisteredCommandHandler('microPythonWorkBench.chooseStub');
    const refreshFileTreeCache = getRegisteredCommandHandler('microPythonWorkBench.refreshFileTreeCache');
    const openRepl = getRegisteredCommandHandler('microPythonWorkBench.openRepl');
    const stopSerial = getRegisteredCommandHandler('microPythonWorkBench.stopSerial');
    const toggleWorkspaceAutoSync = getRegisteredCommandHandler('microPythonWorkBench.toggleWorkspaceAutoSync');

    await refreshStubIndex();
    await clearStubIndex();
    await chooseStub();
    await refreshFileTreeCache();
    await openRepl();
    await stopSerial();
    await toggleWorkspaceAutoSync();

    expect(stubIndexModule.refreshIndex).toHaveBeenCalled();
    expect(stubIndexModule.clearIndex).toHaveBeenCalled();
    expect(codeCompletionModule.codeCompletionManager.chooseStub).toHaveBeenCalled();
    expect(mpModule.refreshFileTreeCache).toHaveBeenCalled();
    expect(localizationModule.Localization.showInfo).toHaveBeenCalled();
    expect(mpremoteCommandsModule.openReplTerminal).toHaveBeenCalled();
    expect(mpremoteCommandsModule.closeReplTerminal).toHaveBeenCalledWith(true);
    expect(context.workspaceState.update).toHaveBeenCalledWith('autoSyncOnSave', false);

    fsPromises.access.mockImplementation(async (targetPath: string) => {
      if (String(targetPath).includes('esp32sync.json')) {
        return undefined;
      }
      throw new Error('missing');
    });

    const saveHandler = (vscode.workspace.onDidSaveTextDocument as jest.Mock).mock.calls[0][0] as (doc: { uri: { fsPath: string } }) => Promise<void>;
    await saveHandler({ uri: { fsPath: '/workspace/src/main.py' } });

    expect(mpremoteCommandsModule.suspendSerialSessionsForAutoSync).toHaveBeenCalled();
    expect(mpModule.cpToDevice).toHaveBeenCalledWith('/workspace/src/main.py', '/main.py');
    expect(mpremoteCommandsModule.restoreSerialSessionsFromSnapshot).toHaveBeenCalled();
  });
});

export {};
