jest.mock('vscode');
jest.mock('node:path', () => jest.requireActual('node:path'));
jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));
jest.mock('../src/board/MpRemoteManager', () => ({
  MpRemoteManager: {
    isModuleAvailable: jest.fn(),
    isPythonModuleAvailable: jest.fn(),
    installPackages: jest.fn().mockResolvedValue(undefined),
  },
}));

const vscode = require('vscode') as typeof import('vscode');
const childProcess = require('node:child_process') as {
  execFile: jest.Mock;
};
const mpRemoteManager = require('../src/board/MpRemoteManager') as {
  MpRemoteManager: {
    isModuleAvailable: jest.Mock;
    isPythonModuleAvailable: jest.Mock;
    installPackages: jest.Mock;
  };
};

function setupExecFileSuccess() {
  childProcess.execFile.mockImplementation((_python: string, _args: string[], _options: { timeout: number }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, '3.11.0', '');
  });
}

describe('pythonInterpreter coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupExecFileSuccess();

    (vscode.env as any).language = 'en';
    (vscode.extensions as any).getExtension = jest.fn(() => ({
      isActive: true,
      activate: jest.fn().mockResolvedValue(undefined),
      exports: {
        settings: {
          getExecutionDetails: jest.fn(() => ({ execCommand: ['/venv/python'] })),
        },
        getActiveInterpreter: jest.fn().mockResolvedValue({ path: '/venv/python' }),
      },
    }));
    (vscode.window as any).showInformationMessage = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).showErrorMessage = jest.fn();
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => ({
      get: jest.fn((key: string) => {
        if (section === 'microPythonWorkBench' && key === 'pythonPath') return '/custom/python';
        if (section === 'python' && key === 'defaultInterpreterPath') return '/python/from/config';
        if (section === 'python' && key === 'pythonPath') return '/legacy/python';
        return undefined;
      }),
    }));

    mpRemoteManager.MpRemoteManager.isPythonModuleAvailable.mockResolvedValue(true);
  });

  test('getPythonPath prefers extension API and caches result', async () => {
    const module = require('../src/python/pythonInterpreter') as typeof import('../src/python/pythonInterpreter');
    module.clearPythonCache();
    const manager = module.PythonInterpreterManager as any;
    manager.getPythonFromExtensionAPI = jest.fn().mockResolvedValue('/venv/python');
    manager.validatePythonPath = jest.fn().mockResolvedValue({ valid: true, missingPyserial: false });

    await expect(module.getPythonPath()).resolves.toBe('/venv/python');
    await expect(module.getPythonPath()).resolves.toBe('/venv/python');
    expect(manager.getPythonFromExtensionAPI).toHaveBeenCalledTimes(1);
  });

  test('falls back to configuration and last resort paths when needed', async () => {
    const module = require('../src/python/pythonInterpreter') as typeof import('../src/python/pythonInterpreter');
    module.clearPythonCache();
    const manager = module.PythonInterpreterManager as any;
    manager.getPythonFromExtensionAPI = jest.fn().mockResolvedValue(null);
    manager.getPythonFromConfiguration = jest.fn().mockReturnValue('/custom/python');
    manager.validatePythonPath = jest.fn().mockResolvedValue({ valid: true, missingPyserial: false });

    await expect(module.getPythonPath()).resolves.toBe('/custom/python');

    manager.getPythonFromConfiguration = jest.fn().mockReturnValue(null);
    manager.getFallbackPythonPaths = jest.fn().mockReturnValue(['fallback-python']);
    manager.validatePythonPath = jest.fn().mockResolvedValue({ valid: false, missingPyserial: false, error: 'missing' });
    module.clearPythonCache();
    await expect(module.getPythonPath()).resolves.toBe('python3');
  });

  test('notification and pyserial availability flows are covered', async () => {
    const module = require('../src/python/pythonInterpreter') as typeof import('../src/python/pythonInterpreter');
    module.clearPythonCache();
    const manager = module.PythonInterpreterManager as any;

    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Install').mockResolvedValueOnce(undefined);
    manager.getPythonPath = jest.fn().mockResolvedValue('/venv/python');
    mpRemoteManager.MpRemoteManager.isPythonModuleAvailable.mockResolvedValue(true);

    manager.showPyserialInstallationNotification('/venv/python');
    await Promise.resolve();
    await Promise.resolve();
    expect(mpRemoteManager.MpRemoteManager.installPackages).toHaveBeenCalledWith(['pyserial'], '/venv/python');
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();

    manager.validatePythonPath = jest.fn().mockResolvedValue({ valid: true, missingPyserial: true });
    mpRemoteManager.MpRemoteManager.isPythonModuleAvailable.mockResolvedValue(false);
    expect(await module.checkMpremoteAvailability()).toBe(false);
  });

  test('getPythonCommandForTerminal and wrapper exports return expected values', async () => {
    const module = require('../src/python/pythonInterpreter') as typeof import('../src/python/pythonInterpreter');
    module.clearPythonCache();
    const manager = module.PythonInterpreterManager as any;
    manager.getPythonPath = jest.fn().mockResolvedValue('/venv/python');

    expect(await module.getPythonCommandForTerminal()).toBe('/venv/python');

    manager.getPythonPath = jest.fn().mockResolvedValue('py -3');
    module.clearPythonCache();
    expect(await module.getPythonCommandForTerminal()).toBe('py -3');

    manager.validatePythonPath = jest.fn().mockResolvedValue({ valid: true, missingPyserial: false });
    expect(await module.checkMpremoteAvailability()).toBe(true);
  });
});

export {};
