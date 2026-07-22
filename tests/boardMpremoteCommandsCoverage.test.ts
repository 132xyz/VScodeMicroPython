jest.mock('vscode');
jest.mock('node:path', () => jest.requireActual('node:path'));
jest.mock('node:fs', () => ({
  existsSync: jest.fn(() => false),
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn(),
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
  getActiveConnect: jest.fn(() => 'serial:///COM4'),
  normalizeConnect: jest.fn((connect: string) => connect.replace(/^serial:\/\/+/, '').replace(/^\//, '')),
  toLocalRelative: jest.fn(),
  toDevicePath: jest.fn(),
  healthCheck: jest.fn(),
}));
jest.mock('../src/board/mpyClient', () => ({
  interrupt: jest.fn(),
  softReset: jest.fn(),
}));
jest.mock('../src/board/serialManager', () => ({
  buildReplClientCommand: jest.fn(),
  closeManager: jest.fn(),
  ensureManagerStarted: jest.fn(),
  getManagerStatus: jest.fn(),
  executeInManager: jest.fn(),
  interruptManager: jest.fn(),
  isSerialManagerActive: jest.fn(),
  softResetManager: jest.fn(),
}));
jest.mock('../src/board/MpRemoteManager', () => ({
  MpRemoteManager: {
    isModuleAvailable: jest.fn(),
    isPythonModuleAvailable: jest.fn(),
    installPackages: jest.fn(),
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
    getActiveCompletionRoots: jest.fn(() => []),
  },
}));

const vscode = require('vscode') as typeof import('vscode');
const childProcess = require('node:child_process') as {
  exec: jest.Mock;
};
const mp = require('../src/board/mpremote') as {
  getActiveConnect: jest.Mock;
  normalizeConnect: jest.Mock;
  toLocalRelative: jest.Mock;
  toDevicePath: jest.Mock;
  healthCheck: jest.Mock;
};
const mpRemoteManager = require('../src/board/MpRemoteManager') as {
  MpRemoteManager: {
    isModuleAvailable: jest.Mock;
    isPythonModuleAvailable: jest.Mock;
    installPackages: jest.Mock;
    detectPythonPath: jest.Mock;
    run: jest.Mock;
  };
};
const fs = require('node:fs') as {
  existsSync: jest.Mock;
  promises: {
    mkdir: jest.Mock;
    readFile: jest.Mock;
    writeFile: jest.Mock;
    unlink: jest.Mock;
  };
};
const mpyClient = require('../src/board/mpyClient') as {
  interrupt: jest.Mock;
  softReset: jest.Mock;
};
const serialManager = require('../src/board/serialManager') as {
  buildReplClientCommand: jest.Mock;
  closeManager: jest.Mock;
  ensureManagerStarted: jest.Mock;
  getManagerStatus: jest.Mock;
  executeInManager: jest.Mock;
  interruptManager: jest.Mock;
  isSerialManagerActive: jest.Mock;
  softResetManager: jest.Mock;
};
const localization = require('../src/core/localization') as {
  showInfo: jest.Mock;
  showError: jest.Mock;
};
const codeCompletion = require('../src/completion/codeCompletion') as {
  codeCompletionManager: {
    getActiveStubPath: jest.Mock;
    getActiveCompletionRoots: jest.Mock;
  };
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
        if (key === 'microPythonWorkBench.baudRate') return 115200;
        if (key === 'microPythonWorkBench.debug') return false;
        return defaultValue;
      }),
    };

    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => globalConfig);
    (vscode.extensions as any).getExtension = jest.fn(() => ({ extensionPath: '/extension' }));
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
    (vscode.window as any).withProgress = jest.fn(async (_options: unknown, task: () => Promise<unknown>) => task());
    (vscode.window as any).activeTextEditor = undefined;
    (vscode.env as any).language = 'en';

    (vscode.commands as any).executeCommand = jest.fn().mockResolvedValue(undefined);

    mpRemoteManager.MpRemoteManager.isModuleAvailable.mockResolvedValue(true);
    mpRemoteManager.MpRemoteManager.isPythonModuleAvailable.mockResolvedValue(true);
    mpRemoteManager.MpRemoteManager.installPackages.mockResolvedValue(undefined);
    mpRemoteManager.MpRemoteManager.detectPythonPath.mockResolvedValue('python3');
    mpyClient.interrupt.mockResolvedValue(undefined);
    mpyClient.softReset.mockResolvedValue(undefined);
    serialManager.ensureManagerStarted.mockResolvedValue({
      device: 'COM4',
      endpoint: { host: '127.0.0.1', port: 50123, token: 'tok' },
    });
    serialManager.getManagerStatus.mockResolvedValue({
      state: 'ready',
      busy: false,
      operation: '',
      clientCount: 2,
      replClientCount: 1,
    });
    serialManager.buildReplClientCommand.mockResolvedValue('python repl-client --endpoint 127.0.0.1:50123 --token tok');
    serialManager.closeManager.mockResolvedValue(undefined);
    serialManager.executeInManager.mockResolvedValue({ stdout: '', stderr: '' });
    serialManager.interruptManager.mockResolvedValue(false);
    serialManager.isSerialManagerActive.mockReturnValue(false);
    serialManager.softResetManager.mockResolvedValue(false);
    fs.existsSync.mockReturnValue(true);
    childProcess.exec.mockImplementation((_cmd: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, '', '');
    });
    mp.getActiveConnect.mockReturnValue('serial:///COM4');
    mp.normalizeConnect.mockImplementation((connect: string) => connect.replace(/^serial:\/\/+/, '').replace(/^\//, ''));
    mp.toLocalRelative.mockImplementation((devicePath: string) => devicePath.replace(/^\//, ''));
    mp.toDevicePath.mockImplementation((localRel: string, rootPath: string) => (rootPath === '/' ? `/${localRel}` : `${rootPath}/${localRel}`));
    mp.healthCheck.mockResolvedValue({ healthy: true, responseTime: 20 });
    fs.promises.readFile.mockResolvedValue('');
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('availability checks and path mapping helpers cover success and fallback', async () => {
    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');

    await expect(commands.checkMpremoteAvailability()).resolves.toBeUndefined();

    mpRemoteManager.MpRemoteManager.isPythonModuleAvailable.mockResolvedValueOnce(false);
    await expect(commands.checkMpremoteAvailability()).rejects.toThrow('pyserial');

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
    expect(vscode.window.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ESP32 REPL',
      hideFromUser: true,
    }));
    expect(serialManager.ensureManagerStarted).toHaveBeenCalledWith('COM4');
    expect(replTerminal.sendText).toHaveBeenCalledWith(expect.stringContaining('repl-client'), true);
    expect(commands.isReplOpen()).toBe(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'microPythonWorkBench.replOpen', true);

    const openPromise = commands.openReplTerminal();
    await jest.runOnlyPendingTimersAsync();
    await openPromise;
    expect(replTerminal.show).toHaveBeenCalled();

    (vscode.commands.executeCommand as jest.Mock).mockClear();
    const restartPromise = commands.restartReplInExistingTerminal({ show: false });
    await jest.runOnlyPendingTimersAsync();
    await restartPromise;
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'microPythonWorkBench.replOpen', true);

    const closePromise = commands.closeReplTerminal(true);
    await jest.runOnlyPendingTimersAsync();
    await closePromise;
    expect(replTerminal.dispose).toHaveBeenCalled();
    expect(serialManager.closeManager).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'microPythonWorkBench.replOpen', false);
  });

  test('opening serial closes a stale REPL before reconnecting the manager', async () => {
    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');
    const replTerminal = await commands.getReplTerminal();
    serialManager.closeManager.mockClear();
    serialManager.ensureManagerStarted.mockClear();

    const reconnectPromise = commands.openSerialConnection();
    await jest.runOnlyPendingTimersAsync();
    await reconnectPromise;

    expect(replTerminal.dispose).toHaveBeenCalled();
    expect(serialManager.closeManager).toHaveBeenCalledTimes(1);
    expect(serialManager.ensureManagerStarted).toHaveBeenCalledWith('COM4');
    expect(serialManager.closeManager.mock.invocationCallOrder[0])
      .toBeLessThan(serialManager.ensureManagerStarted.mock.invocationCallOrder[0]);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'microPythonWorkBench.replOpen', false);
  });

  test('repl terminal starts hidden manager client command', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'microPythonWorkBench.connect') return 'serial:///COM4';
        if (key === 'microPythonWorkBench.baudRate') return 115200;
        if (key === 'microPythonWorkBench.debug') return false;
        return defaultValue;
      }),
    }));
    fs.existsSync.mockReturnValue(true);
    (vscode.extensions as any).getExtension = jest.fn(() => ({ extensionPath: '/extension' }));
    (vscode.extensions as any).all = [];
    mpRemoteManager.MpRemoteManager.isPythonModuleAvailable
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    (vscode.window.showInformationMessage as jest.Mock)
      .mockResolvedValueOnce('Install to this Python')
      .mockResolvedValueOnce(undefined);
    codeCompletion.codeCompletionManager.getActiveStubPath.mockReturnValue('/workspace/stub-overlay');
    codeCompletion.codeCompletionManager.getActiveCompletionRoots.mockReturnValue([
      '/workspace/stub-overlay',
      '/workspace/mpy',
      '/workspace/mpy/lib',
    ]);

    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');
    const replTerminal = await commands.getReplTerminal();

    expect(mpRemoteManager.MpRemoteManager.installPackages).not.toHaveBeenCalled();
    expect(replTerminal.sendText).toHaveBeenCalledWith(expect.stringContaining('repl-client'), true);
    expect(serialManager.ensureManagerStarted).toHaveBeenCalledWith('COM4');
  });

  test('runActiveFile queues a verbatim file run through the REPL client', async () => {
    const filePath = 'C:\\workspace\\中文 demo.py';
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'microPythonWorkBench.connect') return 'serial:///COM4';
        if (key === 'microPythonWorkBench.baudRate') return 115200;
        if (key === 'microPythonWorkBench.debug') return false;
        return defaultValue;
      }),
    }));
    fs.existsSync.mockReturnValue(true);
    (vscode.extensions as any).getExtension = jest.fn(() => ({ extensionPath: '/extension' }));
    (vscode.extensions as any).all = [];

    (vscode.window as any).activeTextEditor = {
      document: {
        uri: { fsPath: filePath },
        save: jest.fn().mockResolvedValue(undefined),
      },
    };

    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');
    const replTerminal = await commands.getReplTerminal();
    fs.promises.writeFile.mockClear();
    (vscode.window.createTerminal as jest.Mock).mockClear();
    serialManager.getManagerStatus
      .mockResolvedValueOnce({ state: 'ready', busy: false, clientCount: 2, replClientCount: 0 })
      .mockResolvedValueOnce({ state: 'ready', busy: false, clientCount: 3, replClientCount: 0 })
      .mockResolvedValueOnce({ state: 'ready', busy: false, clientCount: 3, replClientCount: 1 });

    const runPromise = commands.runActiveFile();
    await jest.advanceTimersByTimeAsync(0);
    expect(replTerminal.sendText).not.toHaveBeenCalledWith(
      expect.stringContaining(':mpy-run-file'),
      true,
    );
    await jest.advanceTimersByTimeAsync(50);
    await runPromise;

    expect(vscode.window.createTerminal).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ESP32 Run File' }),
    );
    expect(replTerminal.show).toHaveBeenCalled();
    expect(replTerminal.sendText).toHaveBeenCalledWith(
      `:mpy-run-file ${JSON.stringify(filePath)}`,
      true,
    );
    expect(serialManager.executeInManager).not.toHaveBeenCalled();

    const closePromise = commands.closeReplTerminal();
    await jest.runOnlyPendingTimersAsync();
    await closePromise;
  });

  test('softReset uses active serial manager when available', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'microPythonWorkBench.connect') return 'serial:///COM4';
        if (key === 'microPythonWorkBench.debug') return false;
        return defaultValue;
      }),
    }));
    fs.existsSync.mockReturnValue(true);
    fs.promises.readFile.mockResolvedValue(JSON.stringify({ sequence: 7, command: 'ready' }));
    serialManager.softResetManager.mockResolvedValueOnce(true);

    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');
    try {
      await commands.softReset();

      expect(childProcess.exec).not.toHaveBeenCalled();
      expect(serialManager.softResetManager).toHaveBeenCalled();
      expect(fs.promises.writeFile).not.toHaveBeenCalled();
      expect(localization.showInfo).toHaveBeenCalledWith('messages.softResetSentViaRepl');
    } finally {
      const closePromise = commands.closeReplTerminal();
      await jest.runOnlyPendingTimersAsync();
      await closePromise;
    }
  });

  test('runActiveFile covers missing editor, missing port, and custom repl execution', async () => {
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
      mp.getActiveConnect.mockReturnValue('auto');
      (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
        get: jest.fn((key: string, defaultValue: unknown) => {
          if (key === 'microPythonWorkBench.connect') return 'auto';
          if (key === 'microPythonWorkBench.debug') return false;
          return defaultValue;
        }),
      }));
      await commands.runActiveFile();
      expect(localization.showError).toHaveBeenCalledWith('messages.selectSpecificPort');

      mp.getActiveConnect.mockReturnValue('serial:///COM4');
      (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
        get: jest.fn((key: string, defaultValue: unknown) => {
          if (key === 'microPythonWorkBench.connect') return 'serial:///COM4';
          if (key === 'microPythonWorkBench.baudRate') return 115200;
          if (key === 'microPythonWorkBench.debug') return false;
          return defaultValue;
        }),
      }));
      fs.existsSync.mockReturnValue(true);
      fs.promises.readFile.mockImplementation(async (candidate: string) => (
        String(candidate).endsWith('.py')
          ? 'print("run")\n'
          : JSON.stringify({ sequence: 1, command: 'ready' })
      ));

      await commands.runActiveFile();
      const runTerminal = ((vscode.window.terminals as unknown) as MockTerminal[]).find(t => t.name === 'ESP32 Run File');
      expect(runTerminal).toBeUndefined();
      const replTerminal = ((vscode.window.terminals as unknown) as MockTerminal[]).find(t => t.name === 'ESP32 REPL');
      expect(replTerminal?.sendText).toHaveBeenCalledWith(':mpy-run-file "/workspace/main.py"', true);
      expect(serialManager.executeInManager).not.toHaveBeenCalled();
      await commands.closeReplTerminal();
    } finally {
      jest.useFakeTimers();
    }
  }, 10000);

  test('softReset uses helper when repl is closed', async () => {
    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');
    fs.existsSync.mockReturnValue(false);

    const resetPromise = commands.softReset();
    await jest.runOnlyPendingTimersAsync();
    await resetPromise;

    expect(mpyClient.softReset).toHaveBeenCalledWith('COM4');
    expect(childProcess.exec).not.toHaveBeenCalled();
    expect(localization.showInfo).toHaveBeenCalledWith('messages.softResetSentViaRepl');
  });

  test('robustInterrupt uses helper when no repl is open', async () => {
    jest.useRealTimers();
    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');

    try {
      mp.healthCheck.mockResolvedValueOnce({ healthy: false, responseTime: 999 });

      await commands.robustInterrupt('COM4');

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Device at COM4 may not be responding properly.');
      expect(mpyClient.interrupt).toHaveBeenCalledWith('COM4');
      expect(mpRemoteManager.MpRemoteManager.run).not.toHaveBeenCalled();
      expect(localization.showInfo).toHaveBeenCalledWith('messages.interruptSentViaRepl');
    } finally {
      jest.useFakeTimers();
    }
  });
});

export {};
