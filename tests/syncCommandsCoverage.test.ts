jest.mock('vscode');
jest.mock('node:path', () => jest.requireActual('node:path'));
jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/board/mpremote', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  uploadReplacing: jest.fn().mockResolvedValue(undefined),
  listTreeStats: jest.fn().mockResolvedValue([]),
  cpFromDevice: jest.fn().mockResolvedValue(undefined),
  cpFromDeviceWithProgress: jest.fn(async (_devicePath: string, _localPath: string, onProgress: (event: { bytes: number; total: number; done?: boolean }) => void) => {
    onProgress({ bytes: 10, total: 10, done: true });
  }),
}));
jest.mock('../src/board/MpRemoteManager', () => ({
  MpRemoteManager: {
    cancelActive: jest.fn(),
  },
}));
jest.mock('../src/board/mpremoteCommands', () => ({
  toLocalRelative: jest.fn(),
  suspendSerialSessionsForAutoSync: jest.fn().mockResolvedValue({}),
  restoreSerialSessionsFromSnapshot: jest.fn().mockResolvedValue(undefined),
  closeReplTerminal: jest.fn(),
  isReplOpen: jest.fn(() => false),
}));
jest.mock('../src/sync/sync', () => ({
  buildManifest: jest.fn(),
  diffManifests: jest.fn(),
  saveManifest: jest.fn().mockResolvedValue(undefined),
  loadManifest: jest.fn(),
  createIgnoreMatcher: jest.fn(async () => () => false),
}));
jest.mock('../src/core/workspaceUtils', () => ({
  getLocalSyncRoot: jest.fn(() => '/workspace/mpy'),
}));
jest.mock('../src/ui/decorations', () => ({
  Esp32DecorationProvider: jest.fn(),
}));

const path = require('node:path') as typeof import('node:path');
const vscode = require('vscode') as typeof import('vscode');
const fs = require('node:fs/promises') as {
  access: jest.Mock;
  mkdir: jest.Mock;
  writeFile: jest.Mock;
};
const mp = require('../src/board/mpremote') as {
  mkdir: jest.Mock;
  uploadReplacing: jest.Mock;
  listTreeStats: jest.Mock;
  cpFromDevice: jest.Mock;
  cpFromDeviceWithProgress: jest.Mock;
};
const syncModule = require('../src/sync/sync') as {
  buildManifest: jest.Mock;
  saveManifest: jest.Mock;
  createIgnoreMatcher: jest.Mock;
};
const pathMapping = require('../src/board/mpremoteCommands') as {
  toLocalRelative: jest.Mock;
};
const workspaceUtils = require('../src/core/workspaceUtils') as {
  getLocalSyncRoot: jest.Mock;
};

function configureWorkspace(rootPath: string = '/', serialAutoSuspend: boolean = false) {
  const globalConfig = {
    get: jest.fn((key: string, defaultValue: unknown) => {
      if (key === 'microPythonWorkBench.rootPath') return rootPath;
      if (key === 'microPythonWorkBench.serialAutoSuspend') return serialAutoSuspend;
      return defaultValue;
    }),
  };
  (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => globalConfig);
}

describe('syncCommands coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    configureWorkspace('/', false);

    (vscode.window as any).showErrorMessage = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).showInformationMessage = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).showWarningMessage = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).withProgress = jest.fn(async (_options: unknown, task: (progress: { report: jest.Mock }, token: { isCancellationRequested: boolean; onCancellationRequested: (callback: () => void) => { dispose: jest.Mock } }) => Promise<void>) => {
      await task(
        { report: jest.fn() },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: jest.fn() }) }
      );
    });

    (vscode.ProgressLocation as any) = { Notification: 1 };
    (vscode.commands as any).executeCommand = jest.fn().mockResolvedValue(undefined);

    fs.access.mockResolvedValue(undefined);
    syncModule.createIgnoreMatcher.mockResolvedValue(() => false);
    syncModule.buildManifest.mockResolvedValue({
      files: {
        'main.py': {},
        'lib/utils.py': {},
      },
    });
    pathMapping.toLocalRelative.mockImplementation((devicePath: string) => devicePath.replace(/^\//, ''));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('syncBaseline handles no workspace and missing local root', async () => {
    const { syncCommands } = require('../src/commands/syncCommands') as typeof import('../src/commands/syncCommands');
    (vscode.workspace as any).workspaceFolders = [];
    await syncCommands.syncBaseline();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No workspace folder open');

    configureWorkspace('/', false);
    workspaceUtils.getLocalSyncRoot.mockImplementationOnce(() => {
      throw new Error('missing local root');
    });
    await syncCommands.syncBaseline();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Local sync root not configured. Create a "mpy" folder in the workspace or set "microPythonWorkBench.syncLocalRoot".');
  });

  test('syncBaseline initializes and uploads manifest files', async () => {
    const { syncCommands } = require('../src/commands/syncCommands') as typeof import('../src/commands/syncCommands');
    fs.access.mockRejectedValueOnce(new Error('manifest missing')).mockResolvedValue(undefined);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Initialize');

    await syncCommands.syncBaseline();

    expect(syncModule.buildManifest).toHaveBeenCalled();
    expect(syncModule.saveManifest).toHaveBeenCalledWith(
      path.join('/workspace', '.mpy-workbench', 'esp32sync.json'),
      expect.any(Object)
    );
    expect(mp.mkdir).toHaveBeenCalledWith('/lib');
    expect(mp.uploadReplacing).toHaveBeenCalledWith(path.join('/workspace/mpy', 'main.py'), '/main.py', { skipMkdir: true });
    expect(mp.uploadReplacing).toHaveBeenCalledWith(path.join('/workspace/mpy', 'lib', 'utils.py'), '/lib/utils.py', { skipMkdir: true });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Baseline sync completed successfully');
  });

  test('syncBaselineFromBoard initializes and downloads device files', async () => {
    const { syncCommands } = require('../src/commands/syncCommands') as typeof import('../src/commands/syncCommands');
    fs.access.mockRejectedValueOnce(new Error('manifest missing')).mockResolvedValue(undefined);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Initialize');
    mp.listTreeStats.mockResolvedValueOnce([
      { path: '/main.py', isDir: false },
      { path: '/lib', isDir: true },
      { path: '/lib/utils.py', isDir: false },
    ]);

    await syncCommands.syncBaselineFromBoard();

    expect(mp.cpFromDeviceWithProgress).toHaveBeenCalledWith('/main.py', path.join('/workspace/mpy', 'main.py'), expect.any(Function), expect.objectContaining({ token: expect.any(Object) }));
    expect(mp.cpFromDeviceWithProgress).toHaveBeenCalledWith('/lib/utils.py', path.join('/workspace/mpy', 'lib', 'utils.py'), expect.any(Function), expect.objectContaining({ token: expect.any(Object) }));
    expect(syncModule.saveManifest).toHaveBeenCalledWith(
      path.join('/workspace', '.mpy-workbench', 'esp32sync.json'),
      expect.any(Object)
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Baseline sync from board completed successfully');
  });

  test('placeholder sync commands cover user-facing branches', async () => {
    const { syncCommands } = require('../src/commands/syncCommands') as typeof import('../src/commands/syncCommands');

    await syncCommands.checkDiffs();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Check diffs functionality moved to board operations');

    fs.access.mockRejectedValueOnce(new Error('manifest missing')).mockResolvedValue(undefined);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Initialize');
    await syncCommands.syncDiffsLocalToBoard();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Sync diffs local to board - implementation moved');

    fs.access.mockRejectedValueOnce(new Error('manifest missing')).mockResolvedValue(undefined);
    (vscode.window.showWarningMessage as jest.Mock)
      .mockResolvedValueOnce('Initialize')
      .mockResolvedValueOnce('Check Differences Now');
    mp.listTreeStats.mockResolvedValueOnce([]);

    await syncCommands.syncDiffsBoardToLocal();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('microPythonWorkBench.checkDiffs');
  });
});

export {};
