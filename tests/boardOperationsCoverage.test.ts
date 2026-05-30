jest.mock('vscode');
jest.mock('node:path', () => jest.requireActual('node:path'));
jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  readdir: jest.fn(),
  stat: jest.fn(),
}));
jest.mock('../src/board/mpremote', () => ({
  getBoardFilesAndSizes: jest.fn(),
}));
jest.mock('../src/sync/sync', () => ({
  buildManifest: jest.fn(),
  createIgnoreMatcher: jest.fn(),
  saveManifest: jest.fn().mockResolvedValue(undefined),
  diffManifests: jest.fn(),
  loadManifest: jest.fn(),
}));
jest.mock('../src/core/workspaceUtils', () => ({
  getLocalSyncRoot: jest.fn(() => '/local'),
}));
jest.mock('../src/python/pyraw', () => ({
  listDirPyRaw: jest.fn(),
}));
jest.mock('../src/board/mpremoteCommands', () => ({
  suspendSerialSessionsForAutoSync: jest.fn(),
  restoreSerialSessionsFromSnapshot: jest.fn(),
}));

const vscode = require('vscode') as typeof import('vscode');
const fs = require('node:fs/promises') as {
  access: jest.Mock;
  readdir: jest.Mock;
  stat: jest.Mock;
};
const mp = require('../src/board/mpremote') as {
  getBoardFilesAndSizes: jest.Mock;
};
const syncModule = require('../src/sync/sync') as {
  buildManifest: jest.Mock;
  createIgnoreMatcher: jest.Mock;
};

describe('BoardOperations coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode as any).ProgressLocation = { Notification: 15 };
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'microPythonWorkBench.rootPath') return '/';
        return defaultValue;
      }),
    }));
    (vscode.window as any).withProgress = jest.fn(async (_options: unknown, task: (progress: { report: jest.Mock }) => Promise<void>) => {
      await task({ report: jest.fn() });
    });
    (vscode.window as any).showWarningMessage = jest.fn().mockResolvedValue('Initialize');
    (vscode.window as any).showInformationMessage = jest.fn();
    (vscode.window as any).showErrorMessage = jest.fn();
    (vscode.commands as any).executeCommand = jest.fn().mockResolvedValue(undefined);

    fs.access.mockImplementation(async (targetPath: string) => {
      if (targetPath.includes('esp32sync.json') || targetPath.includes('.mpyignore')) {
        throw new Error('missing');
      }
    });
    fs.readdir.mockImplementation(async (targetPath: string) => {
      if (targetPath === '/local') {
        return [{ name: 'localdir', isDirectory: () => true }];
      }
      return [];
    });
    fs.stat.mockImplementation(async (targetPath: string) => {
      if (targetPath.endsWith('same.py')) return { size: 10 };
      if (targetPath.endsWith('diff.py')) return { size: 20 };
      if (targetPath.endsWith('onlylocal.py')) return { size: 30 };
      return { size: 0 };
    });

    syncModule.createIgnoreMatcher.mockResolvedValue(() => false);
    syncModule.buildManifest.mockResolvedValue({
      files: {
        'same.py': {},
        'diff.py': {},
        'onlylocal.py': {},
      },
    });
    mp.getBoardFilesAndSizes.mockResolvedValue({
      files: new Map([
        ['/same.py', { size: 10, isDir: false }],
        ['/diff.py', { size: 99, isDir: false }],
        ['/onlyboard.py', { size: 5, isDir: false }],
      ]),
      directories: new Set(['/boarddir']),
    });
  });

  test('checkDiffs initializes sync and computes decoration sets', async () => {
    const { BoardOperations } = require('../src/board/boardOperations') as typeof import('../src/board/boardOperations');
    const tree = { refreshTree: jest.fn() };
    const decorations = {
      setDiffs: jest.fn(),
      setLocalOnly: jest.fn(),
      setLocalOnlyDirectories: jest.fn(),
      setBoardOnly: jest.fn(),
    };
    const boardOps = new BoardOperations(tree, decorations as any);

    await boardOps.checkDiffs();

    expect(decorations.setDiffs).toHaveBeenCalledWith(new Set(['/diff.py']));
    expect(decorations.setLocalOnly).toHaveBeenCalledWith(new Set(['/onlylocal.py']));
    expect(decorations.setLocalOnlyDirectories).toHaveBeenCalledWith(new Set(['/localdir']));
    expect(decorations.setBoardOnly).toHaveBeenCalledWith(new Set(['/onlyboard.py']));
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('microPythonWorkBench.refresh');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Board: Diff check complete (1 changed, 1 local-only files, 1 local-only folders, 1 board-only, 4 total)'
    );
  });
});

export {};