jest.mock('vscode');
jest.mock('node:path', () => jest.requireActual('node:path'));
jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  rm: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/board/mpremote', () => ({
  cpToDevice: jest.fn().mockResolvedValue(undefined),
  cpFromDevice: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  deleteAny: jest.fn().mockResolvedValue(undefined),
  listTreeStats: jest.fn().mockResolvedValue([]),
  deleteAllInPath: jest.fn().mockResolvedValue({ deleted: [], errors: [] }),
  uploadReplacing: jest.fn().mockResolvedValue(undefined),
  mvOnDevice: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/core/localization', () => ({
  Localization: {
    showInfo: jest.fn(),
    showError: jest.fn(),
    showWarning: jest.fn(),
  },
}));
jest.mock('../src/sync/sync', () => ({
  createIgnoreMatcher: jest.fn(async () => () => false),
  buildManifest: jest.fn(),
  saveManifest: jest.fn(),
  loadManifest: jest.fn(),
}));
jest.mock('../src/board/mpremoteCommands', () => ({
  toLocalRelative: jest.fn(),
  toDevicePath: jest.fn(),
}));
jest.mock('../src/sync/activeFileSync', () => {
  class ActiveFileSyncError extends Error {
    code: string;
    detail?: string;

    constructor(code: string, detail?: string) {
      super(code);
      this.code = code;
      this.detail = detail;
    }
  }

  return {
    ActiveFileSyncError,
    syncActiveEditorToBoard: jest.fn(),
  };
});
jest.mock('../src/core/workspaceUtils', () => ({
  getLocalSyncRoot: jest.fn(() => '/workspace/mpy'),
}));

const path = require('node:path') as typeof import('node:path');
const vscode = require('vscode') as typeof import('vscode');
const fs = require('node:fs/promises') as {
  access: jest.Mock;
  mkdir: jest.Mock;
  writeFile: jest.Mock;
  rm: jest.Mock;
  rename: jest.Mock;
};
const mp = require('../src/board/mpremote') as {
  cpToDevice: jest.Mock;
  cpFromDevice: jest.Mock;
  mkdir: jest.Mock;
  deleteAny: jest.Mock;
  listTreeStats: jest.Mock;
  deleteAllInPath: jest.Mock;
  uploadReplacing: jest.Mock;
  mvOnDevice: jest.Mock;
};
const localization = require('../src/core/localization') as {
  Localization: {
    showInfo: jest.Mock;
    showError: jest.Mock;
    showWarning: jest.Mock;
  };
};
const syncModule = require('../src/sync/sync') as {
  createIgnoreMatcher: jest.Mock;
};
const pathMapping = require('../src/board/mpremoteCommands') as {
  toLocalRelative: jest.Mock;
};
const activeFileSync = require('../src/sync/activeFileSync') as {
  ActiveFileSyncError: new (code: string, detail?: string) => Error & { code: string; detail?: string };
  syncActiveEditorToBoard: jest.Mock;
};

function configureWorkspace(rootPath: string = '/') {
  const globalConfig = {
    get: jest.fn((key: string, defaultValue: unknown) => {
      if (key === 'microPythonWorkBench.rootPath') return rootPath;
      return defaultValue;
    }),
  };
  (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => globalConfig);
}

describe('fileCommands coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureWorkspace('/');

    (vscode.window as any).showErrorMessage = jest.fn();
    (vscode.window as any).showInformationMessage = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).showWarningMessage = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).showInputBox = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).showTextDocument = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).withProgress = jest.fn(async (_options: unknown, task: (progress: { report: jest.Mock }, token: unknown) => Promise<void>) => {
      await task({ report: jest.fn() }, {});
    });

    (vscode.ProgressLocation as any) = { Notification: 1 };
    (vscode.workspace as any).onDidSaveTextDocument = jest.fn(() => ({ dispose: jest.fn() }));
    (vscode.workspace as any).openTextDocument = jest.fn(async (input: string) => ({ uri: { fsPath: input } }));
    (vscode.commands as any).executeCommand = jest.fn().mockResolvedValue(undefined);
    (vscode.Uri as any).file = jest.fn((fsPath: string) => ({ fsPath }));

    fs.access.mockResolvedValue(undefined);
    pathMapping.toLocalRelative.mockImplementation((devicePath: string) => devicePath.replace(/^\//, ''));
    activeFileSync.syncActiveEditorToBoard.mockResolvedValue({ relativePath: 'main.py' });
    syncModule.createIgnoreMatcher.mockResolvedValue(() => false);
  });

  test('syncActiveFileLocalToBoard covers success and typed error branches', async () => {
    const { fileCommands } = require('../src/commands/fileCommands') as typeof import('../src/commands/fileCommands');

    await fileCommands.syncActiveFileLocalToBoard();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('microPythonWorkBench.refresh');
    expect(localization.Localization.showInfo).toHaveBeenCalledWith('messages.syncedLocalToBoard', 'main.py');

    activeFileSync.syncActiveEditorToBoard.mockRejectedValueOnce(new activeFileSync.ActiveFileSyncError('NO_ACTIVE_EDITOR'));
    await fileCommands.syncActiveFileLocalToBoard();
    expect(localization.Localization.showError).toHaveBeenCalledWith('messages.noActiveEditor');

    activeFileSync.syncActiveEditorToBoard.mockRejectedValueOnce(new activeFileSync.ActiveFileSyncError('OUTSIDE_SYNC_ROOT', 'bad.py'));
    await fileCommands.syncActiveFileLocalToBoard();
    expect(localization.Localization.showWarning).toHaveBeenCalledWith('messages.activeFileSyncOutsideRoot', 'bad.py');
  });

  test('newFileBoardAndLocal creates local file and uploads after first save', async () => {
    const { fileCommands } = require('../src/commands/fileCommands') as typeof import('../src/commands/fileCommands');
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('main.py');

    await fileCommands.newFileBoardAndLocal();
    expect(fs.writeFile).toHaveBeenCalledWith(path.join('/workspace/mpy', 'main.py'), '', { flag: 'wx' });
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(path.join('/workspace/mpy', 'main.py'));

    const saveHandler = (vscode.workspace.onDidSaveTextDocument as jest.Mock).mock.calls[0][0] as (doc: { uri: { fsPath: string } }) => Promise<void>;
    await saveHandler({ uri: { fsPath: path.join('/workspace/mpy', 'main.py') } });
    expect(mp.cpToDevice).toHaveBeenCalledWith(path.join('/workspace/mpy', 'main.py'), '/main.py');
  });

  test('openFileFromLocal handles unmapped and mapped files', async () => {
    const { fileCommands } = require('../src/commands/fileCommands') as typeof import('../src/commands/fileCommands');
    const node = { kind: 'file', path: '/lib/utils.py' } as any;

    pathMapping.toLocalRelative.mockReturnValueOnce(null);
    await fileCommands.openFileFromLocal(node);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();

    pathMapping.toLocalRelative.mockReturnValueOnce('lib/utils.py');
    await fileCommands.openFileFromLocal(node);
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(path.join('/workspace/mpy', 'lib', 'utils.py'));
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
  });

  test('syncFileLocalToBoard downloads missing local file before uploading', async () => {
    const { fileCommands } = require('../src/commands/fileCommands') as typeof import('../src/commands/fileCommands');
    const node = { kind: 'file', path: '/lib/utils.py' } as any;
    pathMapping.toLocalRelative.mockReturnValue('lib/utils.py');
    fs.access.mockRejectedValueOnce(new Error('missing'));
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Download');

    await fileCommands.syncFileLocalToBoard(node);

    expect(mp.cpFromDevice).toHaveBeenCalledWith('/lib/utils.py', path.join('/workspace/mpy', 'lib', 'utils.py'));
    expect(mp.cpToDevice).toHaveBeenCalledWith(path.join('/workspace/mpy', 'lib', 'utils.py'), '/lib/utils.py');
  });

  test('syncFileBoardToLocal downloads missing local file', async () => {
    const { fileCommands } = require('../src/commands/fileCommands') as typeof import('../src/commands/fileCommands');
    const node = { kind: 'file', path: '/boot.py' } as any;
    pathMapping.toLocalRelative.mockReturnValue('boot.py');
    fs.access.mockRejectedValueOnce(new Error('missing'));

    await fileCommands.syncFileBoardToLocal(node);

    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(path.join('/workspace/mpy', 'boot.py')), { recursive: true });
    expect(mp.cpFromDevice).toHaveBeenCalledWith('/boot.py', path.join('/workspace/mpy', 'boot.py'));
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Downloaded board → local: boot.py');
  });

  test('openFile copies from board when local file is missing', async () => {
    const { fileCommands } = require('../src/commands/fileCommands') as typeof import('../src/commands/fileCommands');
    const node = { kind: 'file', path: '/main.py' } as any;
    pathMapping.toLocalRelative.mockReturnValue('main.py');
    fs.access.mockRejectedValueOnce(new Error('missing'));

    await fileCommands.openFile(node);

    expect(mp.cpFromDevice).toHaveBeenCalledWith('/main.py', path.join('/workspace/mpy', 'main.py'));
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ fsPath: path.join('/workspace/mpy', 'main.py') });
  });

  test('delete and deleteAllBoard cover progress flows', async () => {
    const { fileCommands } = require('../src/commands/fileCommands') as typeof import('../src/commands/fileCommands');
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Delete').mockResolvedValueOnce('Delete All');

    await fileCommands.delete({ kind: 'file', path: '/main.py' } as any);
    expect(mp.deleteAny).toHaveBeenCalledWith('/main.py');
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('microPythonWorkBench.refresh');

    mp.listTreeStats.mockResolvedValueOnce([]);
    await fileCommands.deleteAllBoard();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Board: No files found under /');
  });

  test('tree creation and rename commands update both board and local paths', async () => {
    const { fileCommands } = require('../src/commands/fileCommands') as typeof import('../src/commands/fileCommands');

    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('pkg/new.py')
      .mockResolvedValueOnce('pkg')
      .mockResolvedValueOnce('renamed.py');
    (vscode.extensions as any).getExtension = jest.fn(() => ({ exports: { esp32Tree: { refreshTree: jest.fn() } } }));

    await fileCommands.newFileInTree();
    expect(mp.uploadReplacing).toHaveBeenCalledWith(path.join('/workspace/mpy', 'pkg', 'new.py'), '/pkg/new.py');

    await fileCommands.newFolderInTree();
    expect(mp.mkdir).toHaveBeenCalledWith('/pkg');

    await fileCommands.renameNode({ kind: 'file', path: '/main.py' } as any);
    expect(mp.mvOnDevice).toHaveBeenCalledWith('/main.py', '/renamed.py');
    expect(fs.rename).toHaveBeenCalledWith(path.join('/workspace/mpy', 'main.py'), path.join('/workspace/mpy', '', 'renamed.py'));
  });
});

export {};