jest.mock('vscode');
jest.mock('path', () => jest.requireActual('path'));
jest.mock('node:path', () => jest.requireActual('path'));
jest.mock('node:fs/promises', () => ({
  readdir: jest.fn(),
  stat: jest.fn(),
  mkdir: jest.fn(),
  writeFile: jest.fn(),
  readFile: jest.fn(),
}));
jest.mock('node:crypto', () => ({
  randomUUID: jest.fn(),
}));

const path = require('node:path') as typeof import('node:path');
const vscode = require('vscode') as typeof import('vscode');
const fs = require('node:fs/promises') as {
  readdir: jest.Mock;
  stat: jest.Mock;
  mkdir: jest.Mock;
  writeFile: jest.Mock;
  readFile: jest.Mock;
};
const { randomUUID } = require('node:crypto') as { randomUUID: jest.Mock };

function dirent(name: string, kind: 'file' | 'dir') {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

describe('sync and localization coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    randomUUID.mockReturnValue('uuid-1');
    (vscode.env as any).language = 'en';
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockReturnValue(false),
    });
  });

  test('sync helpers build diff save load and clone manifests', async () => {
    const rootDir = path.join(path.sep, 'root');
    const packageDir = path.join(rootDir, 'pkg');
    const keepFile = path.join(rootDir, 'keep.py');
    const nestedFile = path.join(packageDir, 'nested.py');

    fs.readdir.mockImplementation(async (dir: string) => {
      if (dir === rootDir) {
        return [dirent('keep.py', 'file'), dirent('skip.py', 'file'), dirent('pkg', 'dir')];
      }
      if (dir === packageDir) {
        return [dirent('nested.py', 'file')];
      }
      return [];
    });
    fs.stat.mockImplementation(async (filePath: string) => {
      if (filePath === keepFile) {
        return { size: 10, mtimeMs: 1000 };
      }
      if (filePath === nestedFile) {
        return { size: 20, mtimeMs: 2500 };
      }
      throw new Error(`unexpected stat path ${filePath}`);
    });
    fs.readFile.mockResolvedValue(JSON.stringify({ version: 1, syncId: 'loaded', root: rootDir, generatedAt: 1, files: {} }));

    const sync = require('../src/sync/sync') as typeof import('../src/sync/sync');
    const manifest = await sync.buildManifest(rootDir, new Set(['skip.py']));
    expect(manifest).toEqual({
      version: 1,
      syncId: 'uuid-1',
      root: rootDir,
      generatedAt: expect.any(Number),
      files: {
        'keep.py': { size: 10, mtime: 1000 },
        'pkg/nested.py': { size: 20, mtime: 2500 },
      },
    });

    expect(
      sync.diffManifests(
        { ...manifest, files: { 'keep.py': { size: 9, mtime: 1000 }, 'old.py': { size: 1, mtime: 1 } } },
        manifest,
      )
    ).toEqual({ changedOrNew: ['keep.py', 'pkg/nested.py'], deleted: ['old.py'] });

    const manifestPath = path.join(rootDir, '.mpy-workbench', 'esp32sync.json');
    await sync.saveManifest(manifestPath, manifest);
    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(manifestPath), { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    await expect(sync.loadManifest(manifestPath)).resolves.toEqual({
      version: 1,
      syncId: 'loaded',
      root: rootDir,
      generatedAt: 1,
      files: {},
    });

    fs.readFile.mockRejectedValueOnce(new Error('missing'));
    await expect(sync.loadManifest(manifestPath)).resolves.toBeUndefined();

    const cloned = sync.cloneManifestWithNewId(manifest, 'uuid-2');
    expect(cloned.syncId).toBe('uuid-2');
    expect(cloned.root).toBe(rootDir);
    expect(sync.defaultIgnorePatterns()).toContain('.mpy-workbench/');
  });

  test('createIgnoreMatcher merges default and custom ignore rules', async () => {
    fs.readFile.mockResolvedValue('custom-dir/\n*.tmp\n# ignore comment\n');

    const sync = require('../src/sync/sync') as typeof import('../src/sync/sync');
    const matcher = await sync.createIgnoreMatcher('/workspace');

    expect(matcher('dist/app.js', false)).toBe(true);
    expect(matcher('custom-dir/file.py', true)).toBe(true);
    expect(matcher('nested/file.tmp', false)).toBe(true);
    expect(matcher('src/main.py', false)).toBe(false);
  });

  test('Localization resolves messages, formats args, and routes UI helpers', async () => {
    const consoleDebug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const localization = require('../src/core/localization') as typeof import('../src/core/localization');

    expect(localization.Localization.t('messages.codeCompletionEnabled')).toBe('MicroPython code completion enabled');

    (vscode.env as any).language = 'zh-cn';
    expect(localization.Localization.t('messages.codeCompletionDisabled')).toBe('MicroPython 代码补全已禁用');

    (vscode.env as any).language = 'en';
    expect(localization.Localization.t('messages.codeCompletionEnableFailed', 'boom')).toBe(
      'Failed to enable code completion: boom'
    );
    expect(localization.Localization.t('messages.unknownKey', 'A', 'B')).toBe('messages.unknownKey: A B');

    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockReturnValue(true),
    });
    localization.Localization.t('messages.codeCompletionEnabled');
    expect(consoleDebug).toHaveBeenCalled();

    await localization.Localization.showInfo('messages.codeCompletionEnabled');
    await localization.Localization.showError('messages.codeCompletionDisabled');
    await localization.Localization.showWarning('messages.installPylance');

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('MicroPython code completion enabled');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('MicroPython code completion disabled');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Install Pylance');

    consoleDebug.mockRestore();
  });
});

export {};