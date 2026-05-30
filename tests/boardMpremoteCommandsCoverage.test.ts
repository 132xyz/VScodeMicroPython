jest.mock('vscode');
jest.mock('node:path', () => jest.requireActual('node:path'));
jest.mock('node:fs', () => ({
  existsSync: jest.fn(() => false),
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('node:os', () => ({
  tmpdir: jest.fn(() => '/tmp'),
}));
jest.mock('node:child_process', () => ({
  exec: jest.fn(),
}));
jest.mock('../src/board/mpremote', () => ({
  normalizeConnect: jest.fn((connect: string) => connect.replace(/^serial:\/\/+/, '').replace(/^\//, '')),
  toLocalRelative: jest.fn(),
  toDevicePath: jest.fn(),
  healthCheck: jest.fn(),
}));
jest.mock('../src/board/MpRemoteManager', () => ({
  MpRemoteManager: {
    isModuleAvailable: jest.fn(),
    detectPythonPath: jest.fn(),
    run: jest.fn(),
  },
}));
jest.mock('../src/core/localization', () => ({
  showInfo: jest.fn(),
  showError: jest.fn(),
  showWarning: jest.fn(),
}));
jest.mock('../src/completion/codeCompletion', () => ({
  codeCompletionManager: {
    getActiveStubPath: jest.fn(() => undefined),
  },
}));

const vscode = require('vscode') as typeof import('vscode');
const childProcess = require('node:child_process') as {
  exec: jest.Mock;
};
const mp = require('../src/board/mpremote') as {
  normalizeConnect: jest.Mock;
  toLocalRelative: jest.Mock;
  toDevicePath: jest.Mock;
  healthCheck: jest.Mock;
};
const mpRemoteManager = require('../src/board/MpRemoteManager') as {
  MpRemoteManager: {
    isModuleAvailable: jest.Mock;
    detectPythonPath: jest.Mock;
    run: jest.Mock;
  };
};
const localization = require('../src/core/localization') as {
  showInfo: jest.Mock;
  showError: jest.Mock;
};

type MockTerminal = {
  name: string;
  sendText: jest.Mock;
  show: jest.Mock;
  dispose: jest.Mock;
};

function createTerminal(name: string): MockTerminal {
  return {
    name,
    sendText: jest.fn(),
    show: jest.fn(),
    dispose: jest.fn(),
  };
}

describe('board mpremoteCommands coverage', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const globalConfig = {
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'microPythonWorkBench.connect') return 'serial:///COM4';
        if (key === 'microPythonWorkBench.interruptOnConnect') return true;
        if (key === 'microPythonWorkBench.strictConnect') return true;
        if (key === 'microPythonWorkBench.experimentalCustomRepl') return false;
        if (key === 'microPythonWorkBench.debug') return false;
        return defaultValue;
      }),
    };

    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => globalConfig);
    (vscode.extensions as any).getExtension = jest.fn(() => undefined);
    (vscode.extensions as any).all = [];

    const terminals: MockTerminal[] = [];
    (vscode.window as any).terminals = terminals;
    (vscode.window as any).createTerminal = jest.fn((options: { name: string }) => {
      const term = createTerminal(options.name);
      terminals.push(term);
      return term;
    });
    (vscode.window as any).showErrorMessage = jest.fn();
    (vscode.window as any).showInformationMessage = jest.fn();
    (vscode.window as any).showWarningMessage = jest.fn();
    (vscode.window as any).activeTextEditor = undefined;

    (vscode.commands as any).executeCommand = jest.fn().mockResolvedValue(undefined);

    mpRemoteManager.MpRemoteManager.isModuleAvailable.mockResolvedValue(true);
    mpRemoteManager.MpRemoteManager.detectPythonPath.mockResolvedValue('/python.exe');
    childProcess.exec.mockImplementation((_cmd: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, '', '');
    });
    mp.normalizeConnect.mockImplementation((connect: string) => connect.replace(/^serial:\/\/+/, '').replace(/^\//, ''));
    mp.toLocalRelative.mockImplementation((devicePath: string) => devicePath.replace(/^\//, ''));
    mp.toDevicePath.mockImplementation((localRel: string, rootPath: string) => (rootPath === '/' ? `/${localRel}` : `${rootPath}/${localRel}`));
    mp.healthCheck.mockResolvedValue({ healthy: true, responseTime: 20 });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('availability checks and path mapping helpers cover success and fallback', async () => {
    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');

    await expect(commands.checkMpremoteAvailability()).resolves.toBeUndefined();

    mpRemoteManager.MpRemoteManager.isModuleAvailable.mockResolvedValueOnce(false);
    await expect(commands.checkMpremoteAvailability()).rejects.toThrow('Python interpreter or mpremote not available');
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();

    expect(commands.toLocalRelative('/lib/utils.py', '/')).toBe('lib/utils.py');
    expect(commands.toDevicePath('main.py', '/')).toBe('/main.py');

    mp.toLocalRelative.mockImplementationOnce(() => {
      throw new Error('bad map');
    });
    expect(commands.toLocalRelative('/bad.py', '/')).toBeNull();

    mp.toDevicePath.mockImplementationOnce(() => {
      throw new Error('bad map');
    });
    expect(commands.toDevicePath('main.py', '/')).toBe('/main.py');
  });

  test('repl terminal lifecycle opens shows and closes correctly', async () => {
    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');

    const replTerminal = await commands.getReplTerminal();
    expect(vscode.window.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ name: 'ESP32 REPL' }));
    expect(replTerminal.sendText).toHaveBeenCalledWith(expect.stringContaining('connect COM4'), true);
    expect(commands.isReplOpen()).toBe(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'microPythonWorkBench.replOpen', true);

    const openPromise = commands.openReplTerminal();
    await jest.runOnlyPendingTimersAsync();
    await openPromise;
    expect(replTerminal.show).toHaveBeenCalled();

    const closePromise = commands.closeReplTerminal(true);
    await jest.runOnlyPendingTimersAsync();
    await closePromise;
    expect(replTerminal.dispose).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'microPythonWorkBench.replOpen', false);
  });

  test('runActiveFile covers missing editor, missing port, run terminal open and close', async () => {
    jest.useRealTimers();
    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');

    try {
      await commands.runActiveFile();
      expect(localization.showError).toHaveBeenCalledWith('messages.noActiveEditor');

      (vscode.window as any).activeTextEditor = {
        document: {
          uri: { fsPath: '/workspace/main.py' },
          save: jest.fn().mockResolvedValue(undefined),
        },
      };
      (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
        get: jest.fn((key: string, defaultValue: unknown) => {
          if (key === 'microPythonWorkBench.connect') return 'auto';
          if (key === 'microPythonWorkBench.debug') return false;
          return defaultValue;
        }),
      }));
      await commands.runActiveFile();
      expect(localization.showError).toHaveBeenCalledWith('messages.selectSpecificPort');

      (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
        get: jest.fn((key: string, defaultValue: unknown) => {
          if (key === 'microPythonWorkBench.connect') return 'serial:///COM4';
          if (key === 'microPythonWorkBench.interruptOnConnect') return true;
          if (key === 'microPythonWorkBench.strictConnect') return true;
          if (key === 'microPythonWorkBench.experimentalCustomRepl') return false;
          if (key === 'microPythonWorkBench.debug') return false;
          return defaultValue;
        }),
      }));

      await commands.runActiveFile();
      const runTerminal = ((vscode.window.terminals as unknown) as MockTerminal[]).find(t => t.name === 'ESP32 Run File');
      expect(runTerminal).toBeDefined();
      expect(runTerminal?.sendText).toHaveBeenCalledWith(expect.stringContaining('OutputEncoding'), true);
      expect(runTerminal?.sendText).toHaveBeenCalledWith(expect.stringContaining('connect COM4 run /workspace/main.py'), true);

      await commands.closeRunTerminal();
      expect(runTerminal?.dispose).toHaveBeenCalled();
    } finally {
      jest.useFakeTimers();
    }
  }, 10000);

  test('softReset falls back to shell command when repl is closed', async () => {
    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');

    const resetPromise = commands.softReset();
    await jest.runOnlyPendingTimersAsync();
    await resetPromise;

    expect(childProcess.exec).toHaveBeenCalledWith(expect.stringContaining('connect COM4 reset'), expect.any(Function));
    expect(localization.showInfo).toHaveBeenCalledWith('messages.softResetSentViaMpremoteConnect');
  });

  test('robustInterrupt falls back to mpremote when direct echo fails', async () => {
    jest.useRealTimers();
    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');

    try {
      mp.healthCheck.mockResolvedValueOnce({ healthy: false, responseTime: 999 });
      childProcess.exec.mockImplementationOnce((_cmd: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        callback(new Error('serial failed'), '', 'serial failed');
      });

      await commands.robustInterrupt('COM4');

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Device at COM4 may not be responding properly.');
      expect(mpRemoteManager.MpRemoteManager.run).toHaveBeenCalledWith(
        ['connect', 'COM4', 'exec', '--no-follow', "import sys; sys.stdin.write(b'\\x03\\x03')"],
        { retryOnFailure: true }
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Board: Interrupt sent via mpremote to COM4');
    } finally {
      jest.useFakeTimers();
    }
  });
});

export {};