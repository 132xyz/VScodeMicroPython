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
const localization = require('../src/core/localization') as {
  showInfo: jest.Mock;
  showError: jest.Mock;
};
const codeCompletion = require('../src/completion/codeCompletion') as {
  codeCompletionManager: {
    getActiveStubPath: jest.Mock;
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
        if (key === 'microPythonWorkBench.interruptOnConnect') return true;
        if (key === 'microPythonWorkBench.strictConnect') return true;
        if (key === 'microPythonWorkBench.experimentalCustomRepl') return true;
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
    expect(vscode.window.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ name: 'ESP32 REPL' }));
    expect(replTerminal.sendText).toHaveBeenCalledWith(expect.stringContaining('async-repl'), true);
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
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'microPythonWorkBench.replOpen', false);
  });

  test('experimental custom repl prompts to install pyserial when serial module is missing', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'microPythonWorkBench.connect') return 'serial:///COM4';
        if (key === 'microPythonWorkBench.interruptOnConnect') return true;
        if (key === 'microPythonWorkBench.strictConnect') return true;
        if (key === 'microPythonWorkBench.experimentalCustomRepl') return true;
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

    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');
    const replTerminal = await commands.getReplTerminal();

    expect(mpRemoteManager.MpRemoteManager.installPackages).toHaveBeenCalledWith(['pyserial'], 'python3');
    expect(replTerminal.sendText).toHaveBeenCalledWith(expect.stringContaining('async-repl'), true);
    expect(replTerminal.sendText).toHaveBeenCalledWith(expect.stringContaining('--stub-root /workspace/stub-overlay'), true);
  });

  test('runActiveFile uses custom repl control exec when experimental repl is enabled', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'microPythonWorkBench.connect') return 'serial:///COM4';
        if (key === 'microPythonWorkBench.interruptOnConnect') return true;
        if (key === 'microPythonWorkBench.strictConnect') return true;
        if (key === 'microPythonWorkBench.experimentalCustomRepl') return true;
        if (key === 'microPythonWorkBench.baudRate') return 115200;
        if (key === 'microPythonWorkBench.debug') return false;
        return defaultValue;
      }),
    }));
    fs.existsSync.mockReturnValue(true);
    fs.promises.readFile.mockResolvedValue('print("中文")\n');
    (vscode.extensions as any).getExtension = jest.fn(() => ({ extensionPath: '/extension' }));
    (vscode.extensions as any).all = [];

    (vscode.window as any).activeTextEditor = {
      document: {
        uri: { fsPath: '/workspace/main.py' },
        save: jest.fn().mockResolvedValue(undefined),
      },
    };

    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');
    const replTerminal = await commands.getReplTerminal();
    fs.promises.writeFile.mockClear();
    (vscode.window.createTerminal as jest.Mock).mockClear();

    await commands.runActiveFile();

    expect(fs.promises.readFile).toHaveBeenCalledWith('/workspace/main.py', 'utf8');
    expect(vscode.window.createTerminal).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ESP32 Run File' }),
    );
    expect(replTerminal.show).toHaveBeenCalled();

    const writeCalls = fs.promises.writeFile.mock.calls;
    const writeCall = writeCalls[writeCalls.length - 1];
    expect(writeCall).toBeDefined();
    const payload = JSON.parse(writeCall[1]);
    expect(payload.command).toBe('exec');
    expect(payload.source).toBe('print("中文")\n');
    expect(payload.label).toBe('main.py');

    const closePromise = commands.closeReplTerminal();
    await jest.runOnlyPendingTimersAsync();
    await closePromise;
  });

  test('softReset reattaches to existing custom repl control file after extension reload', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'microPythonWorkBench.connect') return 'serial:///COM4';
        if (key === 'microPythonWorkBench.experimentalCustomRepl') return true;
        if (key === 'microPythonWorkBench.debug') return false;
        return defaultValue;
      }),
    }));
    fs.existsSync.mockReturnValue(true);
    fs.promises.readFile.mockResolvedValue(JSON.stringify({ sequence: 7, command: 'ready' }));

    const commands = require('../src/board/mpremoteCommands') as typeof import('../src/board/mpremoteCommands');
    try {
      await commands.softReset();

      expect(childProcess.exec).not.toHaveBeenCalled();
      const writeCalls = fs.promises.writeFile.mock.calls;
      const writeCall = writeCalls[writeCalls.length - 1];
      expect(writeCall).toBeDefined();
      const payload = JSON.parse(writeCall[1]);
      expect(payload.sequence).toBe(8);
      expect(payload.command).toBe('soft-reset');
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
          if (key === 'microPythonWorkBench.interruptOnConnect') return true;
          if (key === 'microPythonWorkBench.strictConnect') return true;
          if (key === 'microPythonWorkBench.experimentalCustomRepl') return true;
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
      const writeCall = fs.promises.writeFile.mock.calls.find(call => String(call[1]).includes('"command":"exec"'));
      expect(writeCall).toBeDefined();
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
