jest.unmock('path');
jest.unmock('node:path');
jest.resetModules();
jest.mock('vscode');

const path = jest.requireActual('path') as typeof import('path');
const vscode = require('vscode') as typeof import('vscode');
(vscode as any).ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
};

const {
  applyPythonCompletionConfiguration,
  restoreManagedMissingModuleSourceOverride,
} = require('../src/completion/completionPythonConfig') as typeof import('../src/completion/completionPythonConfig');

type Store = Record<string, unknown>;

function createConfiguration(initialState: Store = {}) {
  const store: Store = { ...initialState };
  return {
    store,
    get: jest.fn((key: string, defaultValue?: unknown) => (key in store ? store[key] : defaultValue)),
    update: jest.fn(async (key: string, value: unknown) => {
      if (value === undefined) {
        delete store[key];
        return;
      }
      store[key] = value;
    }),
  };
}

function createMemento(initialState: Store = {}) {
  const store: Store = { ...initialState };
  return {
    store,
    get: jest.fn((key: string, defaultValue?: unknown) => (key in store ? store[key] : defaultValue)),
    update: jest.fn(async (key: string, value: unknown) => {
      if (value === undefined) {
        delete store[key];
        return;
      }
      store[key] = value;
    }),
  };
}

describe('completionPythonConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
  });

  it('applies workspace stub configuration and removes managed extra paths', async () => {
    const extensionPath = path.join('C:', 'Users', 'test', '.vscode', 'extensions', 'WebForks.mpy');
    const overlayStubRoot = path.join('C:', 'workspace', '.mpy-workbench', 'code-completion-overlay', 'esp32-stubs');
    const workspaceConfig = createConfiguration({
      'analysis.extraPaths': ['C:/user/keep', 'C:/extra/typings', 'C:/workspace/old-mpy'],
      'autoComplete.extraPaths': [path.join(extensionPath, 'code_completion', 'default')],
      'analysis.stubPath': '',
      'analysis.typeshedPaths': [],
      'analysis.diagnosticSeverityOverrides': {},
    });
    const globalConfig = createConfiguration({
      'analysis.extraPaths': [path.join(extensionPath, 'code_completion', 'default'), 'C:/global/keep'],
      'autoComplete.extraPaths': [path.join(extensionPath, 'code_completion', 'zh-cn')],
      'analysis.stubPath': path.join(extensionPath, 'code_completion', 'default'),
      'analysis.typeshedPaths': [overlayStubRoot, 'C:/global/typeshed'],
    });
    const workspaceState = createMemento();

    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section: string, scope?: unknown) => {
      if (section !== 'python') {
        throw new Error(`unexpected configuration section: ${section}`);
      }
      return scope === null ? globalConfig : workspaceConfig;
    });

    const result = await applyPythonCompletionConfiguration({
      stubInfo: {
        root: overlayStubRoot,
        hasTypeshedRoot: false,
        availableCoreModules: ['machine.pyi'],
      },
      workspaceState: workspaceState as any,
      extensionPath,
      workspaceRoot: path.join('C:', 'workspace'),
      stubInstallPath: '.mpy-workbench/pyi',
      lastStubPath: overlayStubRoot,
      lastTypeshedPath: undefined,
      userExtraPaths: ['C:/extra/typings'],
      managedExtraPaths: ['C:/workspace/mpy', 'C:/workspace/mpy/lib'],
      lastManagedExtraPaths: ['C:/workspace/old-mpy'],
    });

    expect(result).toEqual({
      appliedTypeshedPath: undefined,
      settingsChanged: true,
    });
    expect(workspaceConfig.store['analysis.extraPaths']).toEqual([
      'C:/user/keep',
      'C:/workspace/mpy',
      'C:/workspace/mpy/lib',
    ]);
    expect(workspaceConfig.store['analysis.stubPath']).toBe(overlayStubRoot);
    expect(workspaceConfig.store['analysis.diagnosticSeverityOverrides']).toEqual({
      reportMissingModuleSource: 'none',
    });
    expect(globalConfig.store['analysis.extraPaths']).toEqual(['C:/global/keep']);
    expect(globalConfig.store['analysis.stubPath']).toBeUndefined();
    expect(globalConfig.store['analysis.typeshedPaths']).toEqual(['C:/global/typeshed']);
    expect(workspaceState.store['mpy.managedMissingModuleSourceDiagnostic']).toBe(true);
  });

  it('restores the previous missing-module diagnostic override', async () => {
    const workspaceConfig = createConfiguration({
      'analysis.diagnosticSeverityOverrides': {
        reportMissingModuleSource: 'none',
        reportUnusedImport: 'warning',
      },
    });
    const workspaceState = createMemento({
      'mpy.managedMissingModuleSourceDiagnostic': true,
      'mpy.previousMissingModuleSourceDiagnostic': 'error',
    });

    const changed = await restoreManagedMissingModuleSourceOverride(workspaceState as any, workspaceConfig as any);

    expect(changed).toBe(true);
    expect(workspaceConfig.store['analysis.diagnosticSeverityOverrides']).toEqual({
      reportMissingModuleSource: 'error',
      reportUnusedImport: 'warning',
    });
    expect(workspaceState.store['mpy.managedMissingModuleSourceDiagnostic']).toBeUndefined();
    expect(workspaceState.store['mpy.previousMissingModuleSourceDiagnostic']).toBeUndefined();
  });
});

export {};
