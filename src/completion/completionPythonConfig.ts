import * as path from 'path';
import * as vscode from 'vscode';
import type { StubInspection } from './stubSupport';

const ABSENT_DIAGNOSTIC_OVERRIDE = '__absent__';

export interface ApplyPythonCompletionConfigOptions {
  stubInfo: StubInspection | null;
  workspaceState?: vscode.Memento;
  extensionPath?: string;
  workspaceRoot?: string;
  stubInstallPath: string;
  lastStubPath?: string;
  lastTypeshedPath?: string;
  userExtraPaths: string[];
}

export interface ApplyPythonCompletionConfigResult {
  appliedTypeshedPath?: string;
  settingsChanged: boolean;
}

function getDiagnosticSeverityOverrides(pythonConfig: vscode.WorkspaceConfiguration): Record<string, string> {
  const raw = pythonConfig.get<Record<string, unknown>>('analysis.diagnosticSeverityOverrides', {}) || {};
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      overrides[key] = value;
    }
  }
  return overrides;
}

async function clearManagedMissingModuleSourceState(workspaceState?: vscode.Memento): Promise<void> {
  try {
    await workspaceState?.update('mpy.managedMissingModuleSourceDiagnostic', undefined);
    await workspaceState?.update('mpy.previousMissingModuleSourceDiagnostic', undefined);
  } catch (e) {
    console.warn('[CodeCompletion] failed to clear managed diagnostic state', e);
  }
}

async function ensureMissingModuleSourceSuppression(
  workspaceState: vscode.Memento | undefined,
  pythonConfig: vscode.WorkspaceConfiguration
): Promise<boolean> {
  const overrides = getDiagnosticSeverityOverrides(pythonConfig);
  const managed = workspaceState?.get<boolean>('mpy.managedMissingModuleSourceDiagnostic', false) ?? false;
  const currentValue = overrides.reportMissingModuleSource;

  if (managed) {
    if (currentValue === 'none') {
      return false;
    }
    overrides.reportMissingModuleSource = 'none';
    await pythonConfig.update('analysis.diagnosticSeverityOverrides', overrides, vscode.ConfigurationTarget.Workspace);
    return true;
  }

  if (currentValue === 'none') {
    return false;
  }

  const previousValue = Object.prototype.hasOwnProperty.call(overrides, 'reportMissingModuleSource')
    ? currentValue
    : ABSENT_DIAGNOSTIC_OVERRIDE;

  try {
    await workspaceState?.update('mpy.previousMissingModuleSourceDiagnostic', previousValue);
    await workspaceState?.update('mpy.managedMissingModuleSourceDiagnostic', true);
  } catch (e) {
    console.warn('[CodeCompletion] failed to persist managed diagnostic state', e);
  }

  overrides.reportMissingModuleSource = 'none';
  await pythonConfig.update('analysis.diagnosticSeverityOverrides', overrides, vscode.ConfigurationTarget.Workspace);
  return true;
}

export async function restoreManagedMissingModuleSourceOverride(
  workspaceState: vscode.Memento | undefined,
  pythonConfig: vscode.WorkspaceConfiguration
): Promise<boolean> {
  const managed = workspaceState?.get<boolean>('mpy.managedMissingModuleSourceDiagnostic', false) ?? false;
  if (!managed) {
    return false;
  }

  const previousValue = workspaceState?.get<string>('mpy.previousMissingModuleSourceDiagnostic');
  const overrides = getDiagnosticSeverityOverrides(pythonConfig);
  const currentValue = overrides.reportMissingModuleSource;
  let changed = false;

  if (previousValue === ABSENT_DIAGNOSTIC_OVERRIDE || previousValue === undefined) {
    if (Object.prototype.hasOwnProperty.call(overrides, 'reportMissingModuleSource')) {
      delete overrides.reportMissingModuleSource;
      changed = true;
    }
  } else if (currentValue !== previousValue) {
    overrides.reportMissingModuleSource = previousValue;
    changed = true;
  }

  if (changed) {
    await pythonConfig.update(
      'analysis.diagnosticSeverityOverrides',
      Object.keys(overrides).length > 0 ? overrides : undefined,
      vscode.ConfigurationTarget.Workspace
    );
  }

  await clearManagedMissingModuleSourceState(workspaceState);
  return changed;
}

function normalizePath(value?: string): string {
  return (value || '').replace(/\\/g, '/').toLowerCase();
}

function isExtensionPath(value: string): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().replace(/\\/g, '/');
  return (normalized.includes('webforks.mpy') || normalized.includes('vscodemicropython'))
    && normalized.includes('code_completion');
}

function getLegacyExtensionPaths(extensionPath?: string): string[] {
  if (!extensionPath) return [];
  return [
    path.join(extensionPath, 'code_completion', 'default'),
    path.join(extensionPath, 'code_completion', 'zh-cn'),
  ];
}

export async function applyPythonCompletionConfiguration(
  options: ApplyPythonCompletionConfigOptions
): Promise<ApplyPythonCompletionConfigResult> {
  const pythonConfig = vscode.workspace.getConfiguration('python');
  const globalPythonConfig = vscode.workspace.getConfiguration('python', null);
  const stubPath = options.stubInfo?.root ?? '';
  const workspaceInstallRoot = options.workspaceRoot
    ? path.join(options.workspaceRoot, options.stubInstallPath)
    : options.stubInstallPath;
  const oldPaths = getLegacyExtensionPaths(options.extensionPath);

  const isWorkspaceInstallPath = (value?: string) => {
    if (!value) return false;
    const normalized = normalizePath(value);
    return normalized.includes('.mpy-workbench') || normalized.startsWith(normalizePath(workspaceInstallRoot));
  };

  const isOwnedPath = (value?: string) => {
    if (!value) return false;
    const normalized = normalizePath(value);
    return isExtensionPath(value)
      || isWorkspaceInstallPath(value)
      || normalized === normalizePath(options.lastStubPath)
      || normalized === normalizePath(options.lastTypeshedPath);
  };

  const globalExtraPaths = globalPythonConfig.get<string[]>('analysis.extraPaths', []) || [];
  const newGlobalExtraPaths = globalExtraPaths.filter(value => !isExtensionPath(value));
  if (newGlobalExtraPaths.length !== globalExtraPaths.length) {
    await globalPythonConfig.update('analysis.extraPaths', newGlobalExtraPaths, vscode.ConfigurationTarget.Global);
  }

  const globalAutoCompletePaths = globalPythonConfig.get<string[]>('autoComplete.extraPaths', []) || [];
  const newGlobalAutoCompletePaths = globalAutoCompletePaths.filter(value => !isExtensionPath(value));
  if (newGlobalAutoCompletePaths.length !== globalAutoCompletePaths.length) {
    await globalPythonConfig.update('autoComplete.extraPaths', newGlobalAutoCompletePaths, vscode.ConfigurationTarget.Global);
  }

  const globalStubPath = globalPythonConfig.get<string>('analysis.stubPath', '');
  if (isExtensionPath(globalStubPath)) {
    await globalPythonConfig.update('analysis.stubPath', undefined, vscode.ConfigurationTarget.Global);
  }

  const globalTypeshedPaths = globalPythonConfig.get<string[]>('analysis.typeshedPaths', []) || [];
  const newGlobalTypeshedPaths = globalTypeshedPaths.filter(value => !isOwnedPath(value));
  if (newGlobalTypeshedPaths.length !== globalTypeshedPaths.length) {
    await globalPythonConfig.update(
      'analysis.typeshedPaths',
      newGlobalTypeshedPaths.length > 0 ? newGlobalTypeshedPaths : undefined,
      vscode.ConfigurationTarget.Global
    );
  }

  const extraPaths = pythonConfig.get<string[]>('analysis.extraPaths', []) || [];
  const newExtraPaths = extraPaths.filter(
    value => !isExtensionPath(value) && !oldPaths.includes(value) && !options.userExtraPaths.includes(value)
  );
  const extraChanged = extraPaths.length !== newExtraPaths.length
    || extraPaths.some((value, index) => value !== newExtraPaths[index]);
  if (extraChanged) {
    await pythonConfig.update('analysis.extraPaths', newExtraPaths, vscode.ConfigurationTarget.Workspace);
  }

  const autoCompleteExtraPaths = pythonConfig.get<string[]>('autoComplete.extraPaths', []) || [];
  const newAutoCompleteExtraPaths = autoCompleteExtraPaths.filter(value => !isExtensionPath(value) && !oldPaths.includes(value));
  const autoCompleteChanged = newAutoCompleteExtraPaths.length !== autoCompleteExtraPaths.length
    || autoCompleteExtraPaths.some((value, index) => value !== newAutoCompleteExtraPaths[index]);
  if (newAutoCompleteExtraPaths.length !== autoCompleteExtraPaths.length) {
    await pythonConfig.update('autoComplete.extraPaths', newAutoCompleteExtraPaths, vscode.ConfigurationTarget.Workspace);
  }

  const currentStubPath = pythonConfig.get<string>('analysis.stubPath', '');
  let settingsChanged = false;
  if (stubPath) {
    if (currentStubPath !== stubPath) {
      await pythonConfig.update('analysis.stubPath', stubPath, vscode.ConfigurationTarget.Workspace);
      settingsChanged = true;
    }
  } else if (isExtensionPath(currentStubPath) || oldPaths.includes(currentStubPath)) {
    await pythonConfig.update('analysis.stubPath', undefined, vscode.ConfigurationTarget.Workspace);
    settingsChanged = true;
  }

  const currentTypeshedPaths = pythonConfig.get<string[]>('analysis.typeshedPaths', []) || [];
  const userManagedTypeshedPaths = currentTypeshedPaths.filter(value => !isOwnedPath(value));
  let appliedTypeshedPath: string | undefined;
  if (options.stubInfo?.hasTypeshedRoot && stubPath) {
    const alreadyApplied = currentTypeshedPaths.length === 1 && normalizePath(currentTypeshedPaths[0]) === normalizePath(stubPath);
    if (alreadyApplied || userManagedTypeshedPaths.length === 0) {
      if (!alreadyApplied) {
        await pythonConfig.update('analysis.typeshedPaths', [stubPath], vscode.ConfigurationTarget.Workspace);
        settingsChanged = true;
      }
      appliedTypeshedPath = stubPath;
    } else {
      vscode.window.showWarningMessage('检测到工作区已有自定义 python.analysis.typeshedPaths。已保留原配置；如需 MicroPython 标准库提示，请手动将当前 stub 根设为首个 typeshed path。');
    }
  } else {
    const filteredTypeshedPaths = currentTypeshedPaths.filter(value => !isOwnedPath(value));
    const typeshedChanged = filteredTypeshedPaths.length !== currentTypeshedPaths.length
      || currentTypeshedPaths.some((value, index) => value !== filteredTypeshedPaths[index]);
    if (typeshedChanged) {
      await pythonConfig.update(
        'analysis.typeshedPaths',
        filteredTypeshedPaths.length > 0 ? filteredTypeshedPaths : undefined,
        vscode.ConfigurationTarget.Workspace
      );
      settingsChanged = true;
    }
  }

  const diagnosticChanged = stubPath
    ? await ensureMissingModuleSourceSuppression(options.workspaceState, pythonConfig)
    : await restoreManagedMissingModuleSourceOverride(options.workspaceState, pythonConfig);

  return {
    appliedTypeshedPath,
    settingsChanged: settingsChanged || extraChanged || autoCompleteChanged || diagnosticChanged,
  };
}