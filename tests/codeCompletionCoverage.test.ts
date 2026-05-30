jest.mock('vscode');
jest.mock('path', () => jest.requireActual('path'));
jest.mock('node:fs', () => ({
  existsSync: jest.fn(),
  statSync: jest.fn(),
  readdirSync: jest.fn(),
}));
jest.mock('../src/completion/stubIndex', () => ({
  indexStubPaths: jest.fn(),
  findBestMatch: jest.fn(),
  refreshIndex: jest.fn(),
}));
jest.mock('../src/completion/stubInstaller', () => ({
  installStubPackage: jest.fn(),
}));
jest.mock('../src/completion/stubSupport', () => ({
  buildStubPackageRecommendation: jest.fn(() => ({ basePackage: 'pkg', primary: 'pkg', cleanedRelease: '1.24.0' })),
  detectPyrightConfigOverride: jest.fn(),
  inspectStubRoot: jest.fn(),
}));
jest.mock('../src/completion/stubOverlay', () => ({
  buildOverlayStubRoot: jest.fn(),
}));
jest.mock('../src/completion/completionPythonConfig', () => ({
  applyPythonCompletionConfiguration: jest.fn(async () => ({ appliedTypeshedPath: '/typeshed', settingsChanged: true })),
  restoreManagedMissingModuleSourceOverride: jest.fn(),
}));
jest.mock('../src/board/boardInfoService', () => ({
  boardInfoService: {
    getBoardInfo: jest.fn(() => null),
    setBoardInfo: jest.fn(),
    clearBoardInfo: jest.fn(),
  },
}));

const path = require('path') as typeof import('path');
const vscode = require('vscode') as typeof import('vscode');
const fs = require('node:fs') as {
  existsSync: jest.Mock;
  statSync: jest.Mock;
  readdirSync: jest.Mock;
};
const stubIndex = require('../src/completion/stubIndex') as {
  indexStubPaths: jest.Mock;
  findBestMatch: jest.Mock;
};
const stubSupport = require('../src/completion/stubSupport') as {
  inspectStubRoot: jest.Mock;
  detectPyrightConfigOverride: jest.Mock;
};
const stubOverlay = require('../src/completion/stubOverlay') as {
  buildOverlayStubRoot: jest.Mock;
};
const completionPythonConfig = require('../src/completion/completionPythonConfig') as {
  restoreManagedMissingModuleSourceOverride: jest.Mock;
};
const boardInfoModule = require('../src/board/boardInfoService') as {
  boardInfoService: {
    getBoardInfo: jest.Mock;
    setBoardInfo: jest.Mock;
    clearBoardInfo: jest.Mock;
  };
};

class MockEventEmitter<T> {
  event = jest.fn();
  fire = jest.fn((_value?: T) => undefined);
}

function createStatusBarItem() {
  return {
    command: undefined,
    text: '',
    tooltip: '',
    color: undefined,
    show: jest.fn(),
    hide: jest.fn(),
  };
}

describe('CodeCompletionManager helper coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    (vscode as any).EventEmitter = MockEventEmitter;
    (vscode as any).StatusBarAlignment = { Left: 1, Right: 2 };
    (vscode as any).ConfigurationTarget = { Workspace: 1 };
    (vscode.window as any).createStatusBarItem = jest
      .fn()
      .mockReturnValueOnce(createStatusBarItem())
      .mockReturnValueOnce(createStatusBarItem());
    (vscode.window as any).showErrorMessage = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).showInformationMessage = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).showWarningMessage = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).showQuickPick = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).showInputBox = jest.fn().mockResolvedValue(undefined);
    (vscode.window as any).setStatusBarMessage = jest.fn();
    (vscode.window as any).activeTextEditor = undefined;
    (vscode.extensions as any).getExtension = jest.fn((id: string) => {
      if (id === 'WebForks.mpy') {
        return { extensionPath: '/extension-root' };
      }
      if (id === 'ms-python.vscode-pylance' || id === 'ms-python.python') {
        return { isActive: true, activate: jest.fn() };
      }
      return undefined;
    });
    (vscode.commands as any).registerCommand = jest.fn(() => ({ dispose: jest.fn() }));
    (vscode.commands as any).getCommands = jest.fn().mockResolvedValue(['python.analysis.restartLanguageServer']);
    (vscode.commands as any).executeCommand = jest.fn().mockResolvedValue(undefined);
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.workspace as any).onDidChangeConfiguration = jest.fn(() => ({ dispose: jest.fn() }));
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (section === 'microPythonWorkBench') {
          if (key === 'stubInstallPath') return '.mpy-workbench/pyi';
          if (key === 'codeCompletionExtraPaths') return ['/workspace/extra'];
          if (key === 'enableCodeCompletion') return true;
        }
        if (section === 'python') {
          if (key === 'analysis.stubPath') return '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs';
          if (key === 'analysis.typeshedPaths') return [];
        }
        return defaultValue;
      }),
      update: jest.fn().mockResolvedValue(undefined),
    }));
    (vscode.window as any).onDidChangeActiveTextEditor = jest.fn(() => ({ dispose: jest.fn() }));
    (vscode.env as any).language = 'en';
    boardInfoModule.boardInfoService.clearBoardInfo();
    boardInfoModule.boardInfoService.getBoardInfo.mockReturnValue(null);

    stubSupport.inspectStubRoot.mockImplementation((root: string) => ({ root }));
    stubSupport.detectPyrightConfigOverride.mockReturnValue(undefined);
    stubOverlay.buildOverlayStubRoot.mockImplementation((baseRoot: string) => path.join(baseRoot, 'overlay'));
    stubIndex.indexStubPaths.mockReturnValue([
      {
        name: 'micropython-esp32-stubs',
        path: '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs',
        version: { major: 1, minor: 24, patch: 0 },
      },
    ]);
    stubIndex.findBestMatch.mockReturnValue({
      path: '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs',
      version: { major: 1, minor: 24, patch: 0 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('private helpers parse versions resolve paths and apply overlays', () => {
    const { codeCompletionManager } = require('../src/completion/codeCompletion') as typeof import('../src/completion/codeCompletion');
    const manager = codeCompletionManager as any;

    expect(manager.parseReleaseVersion('1.24.1')).toEqual({ major: 1, minor: 24, patch: 1 });
    expect(manager.parseReleaseVersion('1.24')).toEqual({ major: 1, minor: 24, patch: 0 });
    expect(manager.parseReleaseVersion('bad')).toBeNull();
    expect(manager.compareReleaseVersion({ major: 1, minor: 24, patch: 1 }, { major: 1, minor: 24, patch: 0 })).toBeGreaterThan(0);

    expect(manager.getWorkspaceRoot()).toBe('/workspace');
    expect(manager.getResolvedInstallPath()).toBe(path.join('/workspace', '.mpy-workbench/pyi'));
    expect(manager.getStubSearchPaths()).toEqual([path.join('/workspace', '.mpy-workbench/pyi')]);

    const baseStub = { root: '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs' };
    expect(manager.applyExtraStubOverlay(baseStub)).toEqual({
      root: path.join(baseStub.root, 'overlay'),
    });

    stubOverlay.buildOverlayStubRoot.mockImplementationOnce(() => {
      throw new Error('overlay failed');
    });
    expect(manager.applyExtraStubOverlay(baseStub)).toBe(baseStub);
    expect(vscode.window.setStatusBarMessage).toHaveBeenCalled();
  });

  test('helper methods inspect bundled stubs and pyright overrides', () => {
    const { codeCompletionManager } = require('../src/completion/codeCompletion') as typeof import('../src/completion/codeCompletion');
    const manager = codeCompletionManager as any;

    expect(manager.getBundledStubInspection()).toEqual({
      root: path.join('/extension-root', 'code_completion', 'default'),
    });

    (vscode.env as any).language = 'zh-cn';
    expect(manager.getStubPath()).toBe(path.join('/extension-root', 'code_completion', 'zh-cn'));

    stubSupport.detectPyrightConfigOverride.mockReturnValue({ path: '/workspace/pyrightconfig.json' });
    manager.warnIfPyrightOverrides();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });

  test('status helpers collect module names and format stub labels', () => {
    const { codeCompletionManager } = require('../src/completion/codeCompletion') as typeof import('../src/completion/codeCompletion');
    const manager = codeCompletionManager as any;

    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockImplementation((inputPath: string) => ({
      isDirectory: () => !inputPath.endsWith('.pyi'),
    }));
    fs.readdirSync.mockImplementation((inputPath: string) => {
      if (String(inputPath).includes('extra')) {
        return ['custom_module.pyi'];
      }
      return ['machine', 'network.pyi', '_private.py'];
    });

    expect(manager.getEnabledModulesList()).toEqual(['custom_module', 'machine', 'network']);
    expect(manager.getStubDisplayString()).toBe('micropython-esp32-stubs v1.24.0');
    expect(manager.getStubShortDisplayString()).toBe('micropython-esp…');
    expect(codeCompletionManager.getActiveWorkspaceRoot()).toBe('/workspace');
    expect(codeCompletionManager.getStatus()).toEqual({ isEnabled: false, mode: true });
  });

  test('pickBestInstalledStub returns inspected best match', () => {
    const { codeCompletionManager } = require('../src/completion/codeCompletion') as typeof import('../src/completion/codeCompletion');
    const manager = codeCompletionManager as any;
    const entries = [
      {
        name: 'micropython-esp32-stubs',
        path: '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs',
        version: { major: 1, minor: 24, patch: 0 },
      },
    ];

    const result = manager.pickBestInstalledStub(
      entries,
      { cleanedRelease: '1.24.0' },
      'esp32',
      'ESP32',
      'ESP32'
    );

    expect(stubIndex.findBestMatch).toHaveBeenCalled();
    expect(result).toEqual({ root: '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs' });
  });

  test('initialize registers listeners and hides status bar when not editing python', async () => {
    const { codeCompletionManager } = require('../src/completion/codeCompletion') as typeof import('../src/completion/codeCompletion');
    const manager = codeCompletionManager as any;
    manager.isEnabled = false;

    const workspaceState = {
      get: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const context = {
      workspaceState,
      subscriptions: [] as Array<{ dispose?: () => void }>,
    } as any;

    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (section === 'microPythonWorkBench' && key === 'enableCodeCompletion') {
          return false;
        }
        if (section === 'microPythonWorkBench' && key === 'stubInstallPath') {
          return '.mpy-workbench/pyi';
        }
        return defaultValue;
      }),
      update: jest.fn().mockResolvedValue(undefined),
    }));

    await codeCompletionManager.initialize(context);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'microPythonWorkBench.toggleCodeCompletion',
      expect.any(Function)
    );
    expect(workspaceState.get).toHaveBeenCalledTimes(3);
    expect(context.subscriptions).toHaveLength(5);
    expect(manager.statusBarItem.hide).toHaveBeenCalled();
    expect(manager.stubStatusBarItem.hide).toHaveBeenCalled();
  });

  test('language server restart helpers cover success and failure prompts', async () => {
    const { codeCompletionManager } = require('../src/completion/codeCompletion') as typeof import('../src/completion/codeCompletion');
    const manager = codeCompletionManager as any;

    expect(await manager.tryRestartLanguageServer()).toBe(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('python.analysis.restartLanguageServer');

    (vscode.commands.getCommands as jest.Mock).mockResolvedValueOnce([]);
    expect(await manager.tryRestartLanguageServer()).toBe(false);

    (vscode.extensions.getExtension as jest.Mock).mockImplementationOnce((id: string) => {
      if (id === 'ms-python.python') return undefined;
      return { extensionPath: '/extension-root' };
    });
    await manager.restartPylanceLanguageServer();
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });

  test('entry selection and specific install prompt resolve selected stub', async () => {
    const { codeCompletionManager } = require('../src/completion/codeCompletion') as typeof import('../src/completion/codeCompletion');
    const manager = codeCompletionManager as any;
    const entries = [
      {
        name: 'micropython-esp32-stubs',
        path: '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs',
        version: { major: 1, minor: 24, patch: 0 },
      },
    ];

    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
      label: 'micropython-esp32-stubs (v1.24.0)',
      description: '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs',
    });

    expect(await manager.chooseInstalledEntry(entries, 'pick stub')).toEqual({
      root: '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs',
    });

    manager.installStubPackageAndInspect = jest.fn().mockResolvedValue({ root: '/installed/stubs' });
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('1.25.0');

    expect(await manager.promptSpecificInstall('/install-root', { basePackage: 'micropython-esp32-stubs' })).toEqual({
      root: '/installed/stubs',
    });
    expect(manager.installStubPackageAndInspect).toHaveBeenCalledWith(
      'micropython-esp32-stubs==1.25.0',
      '/install-root'
    );
  });

  test('enable disable and status bar paths update managed state', async () => {
    const { codeCompletionManager } = require('../src/completion/codeCompletion') as typeof import('../src/completion/codeCompletion');
    const manager = codeCompletionManager as any;
    const workspaceState = {
      get: jest.fn((key: string) => {
        if (key === 'mpy.lastStubPath') return '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs';
        if (key === 'mpy.lastTypeshedPath') return '/workspace/.mpy-workbench/pyi/typeshed';
        return undefined;
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    manager.context = { workspaceState };
    manager.lastStubPath = '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs';
    manager.lastBaseStubPath = '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs';
    manager.lastTypeshedPath = '/workspace/.mpy-workbench/pyi/typeshed';
    manager.isEnabled = false;

    const pythonConfig = {
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'analysis.stubPath') return '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs';
        if (key === 'analysis.typeshedPaths') return ['/workspace/.mpy-workbench/pyi/typeshed', '/other/typeshed'];
        if (key === 'analysis.extraPaths') return ['/workspace/.mpy-workbench/pyi', '/workspace/extra'];
        if (key === 'autoComplete.extraPaths') return ['/workspace/.mpy-workbench/pyi'];
        return defaultValue;
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const mpyConfig = {
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'stubInstallPath') return '.mpy-workbench/pyi';
        if (key === 'codeCompletionExtraPaths') return ['/workspace/extra'];
        if (key === 'enableCodeCompletion') return true;
        return defaultValue;
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };

    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => {
      if (section === 'python') return pythonConfig;
      if (section === 'microPythonWorkBench') return mpyConfig;
      return { get: jest.fn(), update: jest.fn().mockResolvedValue(undefined) };
    });

    manager.pickBestInstalledStub = jest.fn().mockReturnValue({ root: '/base-stub' });
    manager.handleVersionMismatch = jest.fn().mockResolvedValue({ root: '/base-stub' });
    manager.applyExtraStubOverlay = jest.fn().mockReturnValue({ root: '/overlay-stub' });
    manager.updatePythonConfiguration = jest.fn().mockResolvedValue(undefined);
    manager.persistAppliedStubState = jest.fn().mockResolvedValue(undefined);
    await manager.enableCodeCompletion();

    expect(manager.isEnabled).toBe(true);
    expect(manager.updatePythonConfiguration).toHaveBeenCalledWith({ root: '/overlay-stub' });
    expect(manager.persistAppliedStubState).toHaveBeenCalledWith({ root: '/base-stub' }, { root: '/overlay-stub' });

    manager.getEnabledModulesList = jest.fn().mockReturnValue(['machine', 'network', 'os']);
    manager.getStubDisplayString = jest.fn().mockReturnValue('micropython-esp32-stubs v1.24.0');
    (vscode.window as any).activeTextEditor = { document: { languageId: 'python' } };
    manager.updateStatusBar();
    expect(manager.statusBarItem.show).toHaveBeenCalled();
    expect(manager.stubStatusBarItem.tooltip).toContain('micropython-esp32-stubs v1.24.0');

    await manager.disableCodeCompletion();
    expect(completionPythonConfig.restoreManagedMissingModuleSourceOverride).toHaveBeenCalled();
    expect(pythonConfig.update).toHaveBeenCalledWith('analysis.stubPath', undefined, vscode.ConfigurationTarget.Workspace);
    expect(pythonConfig.update).toHaveBeenCalledWith('analysis.typeshedPaths', ['/other/typeshed'], vscode.ConfigurationTarget.Workspace);
    expect(manager.isEnabled).toBe(false);
    expect(manager.lastStubPath).toBeUndefined();
  });

  test('handleVersionMismatch warns when device version is newer and early enable path warns without pylance', async () => {
    const { codeCompletionManager } = require('../src/completion/codeCompletion') as typeof import('../src/completion/codeCompletion');
    const manager = codeCompletionManager as any;
    manager.handleVersionMismatch = Object.getPrototypeOf(manager).handleVersionMismatch.bind(manager);
    boardInfoModule.boardInfoService.getBoardInfo.mockReturnValue({
      release: '1.25.0',
      sysname: 'esp32',
      machine: 'ESP32 module',
    } as any);

    const currentStub = { root: '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs' };
    expect(await manager.handleVersionMismatch(
      currentStub,
      [{
        name: 'micropython-esp32-stubs',
        path: '/workspace/.mpy-workbench/pyi/micropython-esp32-stubs',
        version: { major: 1, minor: 24, patch: 0 },
      }],
      { cleanedRelease: '1.25.0' },
      '/install-root'
    )).toBe(currentStub);
    expect(vscode.window.setStatusBarMessage).toHaveBeenCalled();

    (vscode.extensions.getExtension as jest.Mock).mockImplementationOnce((id: string) => {
      if (id === 'ms-python.vscode-pylance') return undefined;
      if (id === 'WebForks.mpy') return { extensionPath: '/extension-root' };
      return { isActive: true, activate: jest.fn() };
    });
    await manager.enableCodeCompletion();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });
});

export {};