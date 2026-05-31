jest.mock('vscode');
jest.mock('node:path', () => jest.requireActual('node:path'));
jest.mock('node:util', () => {
  const actual = jest.requireActual('node:util');
  return {
    ...actual,
    promisify: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => new Promise((resolve, reject) => {
      fn(...args, (error: Error | null, first?: unknown, second?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        if (second !== undefined) {
          resolve({ stdout: first, stderr: second });
          return;
        }
        resolve(first);
      });
    }),
  };
});
jest.mock('node:child_process', () => ({
  exec: jest.fn(),
  execFile: jest.fn(),
}));

const vscode = require('vscode') as typeof import('vscode');
const childProcess = require('node:child_process') as {
  execFile: jest.Mock;
};

function mockExecFileSuccess(stdout = '', stderr = '') {
  childProcess.execFile.mockImplementation((_exe: string, _args: string[], _optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout: string, stderr: string) => void) => {
    const callback = typeof _optionsOrCallback === 'function' ? _optionsOrCallback : maybeCallback;
    callback?.(null, stdout, stderr);
    return { kill: jest.fn() };
  });
}

describe('MpRemoteManager coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecFileSuccess('mpremote 1.24.0', '');

    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.extensions as any).getExtension = jest.fn(() => ({
      isActive: true,
      exports: {
        settings: {
          getExecutionDetails: jest.fn(() => ({ execCommand: ['/venv/python'] })),
        },
      },
    }));
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => ({
      get: jest.fn((key: string) => {
        if (section === 'microPythonWorkBench' && key === 'pythonPath') return '/custom/python';
        if (section === 'python' && key === 'defaultInterpreterPath') return '/python/from/config';
        if (section === 'python' && key === 'pythonPath') return '/legacy/python';
        return undefined;
      }),
    }));
  });

  test('detectPythonPath prefers config, caches, and can be cleared back to extension API', async () => {
    const { MpRemoteManager } = require('../src/board/MpRemoteManager') as typeof import('../src/board/MpRemoteManager');
    MpRemoteManager.clearPythonPathCache();

    await expect(MpRemoteManager.detectPythonPath()).resolves.toBe('/custom/python');

    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({ get: jest.fn(() => undefined) }));
    await expect(MpRemoteManager.detectPythonPath()).resolves.toBe('/custom/python');

    MpRemoteManager.clearPythonPathCache();
    await expect(MpRemoteManager.detectPythonPath()).resolves.toBe('/venv/python');
  });

  test('module checks, version checks, quick runs, install and cancelActive are covered', async () => {
    const { MpRemoteManager } = require('../src/board/MpRemoteManager') as typeof import('../src/board/MpRemoteManager');
    MpRemoteManager.clearPythonPathCache();

    await expect(MpRemoteManager.isModuleAvailable('py -3')).resolves.toBe(true);
    await expect(MpRemoteManager.isPythonModuleAvailable('serial', 'py -3')).resolves.toBe(true);
    await expect(MpRemoteManager.checkVersion()).resolves.toEqual({ version: '1.24.0', compatible: true, source: 'python-module' });

    const quick = await MpRemoteManager.runQuick(['devs'], { pythonPath: 'py -3', timeoutMs: 1234 });
    expect(quick).toEqual({ stdout: 'mpremote 1.24.0', stderr: '' });

    childProcess.execFile.mockImplementation((_exe: string, args: string[], _optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout: string, stderr: string) => void) => {
      const callback = typeof _optionsOrCallback === 'function' ? _optionsOrCallback : maybeCallback;
      callback?.(null, args.includes('install') ? 'installed' : 'pip 24.0', '');
      return { kill: jest.fn() };
    });
    await expect(MpRemoteManager.install('py -3')).resolves.toBeUndefined();
    await expect(MpRemoteManager.installPackages(['pyserial'], 'py -3')).resolves.toBeUndefined();

    const fakeChild = { kill: jest.fn() };
    (MpRemoteManager as any).activeChild = fakeChild;
    (MpRemoteManager as any).activeConnectionPort = 'COM4';
    MpRemoteManager.cancelActive();
    expect(fakeChild.kill).toHaveBeenCalled();
    expect(MpRemoteManager.getActiveConnectionPort()).toBeNull();
    expect(MpRemoteManager.isBusy()).toBe(false);
  });
});

export {};