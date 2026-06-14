import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'node:fs';
import { Localization } from '../core/localization';
import { boardInfoService } from '../board/boardInfoService';
import { indexStubPaths, findBestMatch } from './stubIndex';
import { installStubPackage } from './stubInstaller';
import { refreshIndex } from './stubIndex';
import {
  buildStubPackageRecommendation,
  detectPyrightConfigOverride,
  inspectStubRoot,
  type StubInspection,
  type StubPackageRecommendation,
} from './stubSupport';
import { buildOverlayStubRoot } from './stubOverlay';
import {
  applyPythonCompletionConfiguration,
  restoreManagedMissingModuleSourceOverride,
} from './completionPythonConfig';

/**
 * 代码补全管理器
 * 负责管理 MicroPython 代码补全功能的启用、禁用和配置
 */
export class CodeCompletionManager {
  private static instance: CodeCompletionManager;
  private isEnabled: boolean = false;
  private statusBarItem: vscode.StatusBarItem;
  private stubStatusBarItem: vscode.StatusBarItem;
  private context?: vscode.ExtensionContext;
  private lastStubPath?: string;
  private lastBaseStubPath?: string;
  private lastTypeshedPath?: string;

  private constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'microPythonWorkBench.toggleCodeCompletion';
    this.stubStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.stubStatusBarItem.command = 'microPythonWorkBench.chooseStub';
    // 初始状态不显示，等待初始化
  }

  public static getInstance(): CodeCompletionManager {
    if (!CodeCompletionManager.instance) {
      CodeCompletionManager.instance = new CodeCompletionManager();
    }
    return CodeCompletionManager.instance;
  }

  public getActiveStubPath(): string | undefined {
    return this.lastStubPath;
  }

  public getActiveWorkspaceRoot(): string | undefined {
    return this.getWorkspaceRoot();
  }

  /**
   * 初始化代码补全管理器
   */
  public async initialize(context: vscode.ExtensionContext): Promise<void> {
    this.context = context;
    try { this.lastStubPath = await context.workspaceState.get<string>('mpy.lastStubPath'); } catch {}
    try { this.lastBaseStubPath = await context.workspaceState.get<string>('mpy.lastBaseStubPath'); } catch {}
    try { this.lastTypeshedPath = await context.workspaceState.get<string>('mpy.lastTypeshedPath'); } catch {}
    // 初始化代码补全管理器

    // 注册命令
    context.subscriptions.push(
      vscode.commands.registerCommand('microPythonWorkBench.toggleCodeCompletion', () => {
        this.toggleCodeCompletion();
      })
    );

    // 注册状态栏项
    context.subscriptions.push(this.statusBarItem);
    context.subscriptions.push(this.stubStatusBarItem);

    // 监听配置变化
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('microPythonWorkBench.enableCodeCompletion')) {
          void this.handleConfigurationChange();
          return;
        }

        if (
          this.isEnabled &&
          (
            e.affectsConfiguration('microPythonWorkBench.codeCompletionExtraPaths')
          )
        ) {
          const activeBaseStubPath = this.lastBaseStubPath || this.context?.workspaceState.get<string>('mpy.lastBaseStubPath');
          const activeStub = inspectStubRoot(activeBaseStubPath);
          if (activeStub) {
            void this.refreshAppliedStubOverlay(activeStub);
          }
        }
      })
    );

    // 监听活动编辑器变化
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.updateStatusBar();
      })
    );

    // 初始配置检查
    await this.handleConfigurationChange();
  }

  /**
   * 处理配置变化
   */
  private async handleConfigurationChange(): Promise<void> {
    // 处理配置变化

    const config = vscode.workspace.getConfiguration('microPythonWorkBench');
    const enableCodeCompletion = config.get<boolean>('enableCodeCompletion', false);

    const shouldEnable = enableCodeCompletion;

    if (shouldEnable && !this.isEnabled) {
      await this.enableCodeCompletion();
    } else if (!shouldEnable && this.isEnabled) {
      await this.disableCodeCompletion();
    }

    this.updateStatusBar();
  }

  /**
   * 启用代码补全
   */
  private async enableCodeCompletion(): Promise<void> {
    try {
      // 检查Pylance扩展是否可用
      const pylanceExtension = vscode.extensions.getExtension('ms-python.vscode-pylance');
      if (!pylanceExtension) {
        vscode.window.showWarningMessage(
          Localization.t('messages.pylanceNotInstalled'),
          Localization.t('messages.installPylance')
        ).then(selection => {
          if (selection === Localization.t('messages.installPylance')) {
            vscode.commands.executeCommand('workbench.extensions.search', 'ms-python.vscode-pylance');
          }
        });
        return;
      }

      const config = vscode.workspace.getConfiguration('microPythonWorkBench');
      const searchPaths = this.getStubSearchPaths();
      const resolvedInstall = this.getResolvedInstallPath();
      const boardInfo = boardInfoService.getBoardInfo();
      const recommendation = buildStubPackageRecommendation(boardInfo);
      const boardHint = boardInfo?.machine ? String(boardInfo.machine).split(/\s+with\s+/i)[0] : undefined;
      const auto = vscode.workspace.getConfiguration('microPythonWorkBench').get<boolean>('stubAutoSelect', true);
      this.warnIfPyrightOverrides();

      const entries = indexStubPaths(searchPaths);
      let selectedStub = this.pickBestInstalledStub(
        entries,
        recommendation,
        boardInfo?.sysname,
        boardInfo?.machine,
        boardHint
      );

      if (!selectedStub && entries.length === 0 && boardInfo && auto && recommendation.primary) {
        console.info('[CodeCompletion] no matching stubs found during enable; use MPY: Stub to install or choose one');
      }

      if (!selectedStub) {
        selectedStub = this.getBundledStubInspection();
      }

      if (!selectedStub) {
        vscode.window.setStatusBarMessage('未找到可用的 MicroPython stubs，请使用 MPY: Stub 选择或安装。', 6000);
        return;
      }

      selectedStub = await this.handleVersionMismatch(
        selectedStub,
        refreshIndex(searchPaths),
        recommendation,
        resolvedInstall
      );
      if (!selectedStub) return;

      const baseStub = selectedStub;
      selectedStub = this.applyExtraStubOverlay(baseStub);

      await this.updatePythonConfiguration(selectedStub);
      await this.persistAppliedStubState(baseStub, selectedStub);

      this.isEnabled = true;
    } catch (error) {
      vscode.window.showErrorMessage(
        Localization.t('messages.codeCompletionEnableFailed', error instanceof Error ? error.message : String(error))
      );
    }
  }

  /**
   * 禁用代码补全
   */
  private async disableCodeCompletion(): Promise<void> {
    try {
      const pythonConfig = vscode.workspace.getConfiguration('python');
      const currentStubPath = pythonConfig.get<string>('analysis.stubPath', '');
      const currentTypeshedPaths = pythonConfig.get<string[]>('analysis.typeshedPaths', []) || [];
      await restoreManagedMissingModuleSourceOverride(this.context?.workspaceState, pythonConfig);

      const last = this.lastStubPath || (this.context ? this.context.workspaceState.get<string>('mpy.lastStubPath') : undefined);
      const lastTypeshed = this.lastTypeshedPath || (this.context ? this.context.workspaceState.get<string>('mpy.lastTypeshedPath') : undefined);

      const wsRoot = this.getWorkspaceRoot();
      const installPathCfg = vscode.workspace.getConfiguration('microPythonWorkBench').get<string>('stubInstallPath', '.mpy-workbench/pyi');
      const workspaceInstallRoot = wsRoot ? path.join(wsRoot, installPathCfg) : installPathCfg;

      const isInWorkspaceInstall = (p?: string) => {
        if (!p) return false;
        const normalized = p.replace(/\\/g, '/').toLowerCase();
        if (normalized.includes('.mpy-workbench')) return true;
        if (wsRoot) {
          const rootNorm = wsRoot.replace(/\\/g, '/').toLowerCase();
          if (normalized.startsWith(rootNorm)) return true;
        }
        if (installPathCfg && wsRoot) {
          const expected = workspaceInstallRoot.replace(/\\/g, '/').toLowerCase();
          if (normalized.startsWith(expected)) return true;
        }
        return false;
      };

      let shouldClear = false;
      if (currentStubPath && last && currentStubPath === last) {
        shouldClear = true;
      } else if (currentStubPath && isInWorkspaceInstall(currentStubPath)) {
        const pick = await vscode.window.showWarningMessage(
          '检测到 workspace 的 stubPath 位于扩展安装目录，是否在禁用时清除该 path？',
          'Yes', 'No'
        );
        shouldClear = pick === 'Yes';
      } else if (currentStubPath) {
        const pick = await vscode.window.showWarningMessage(
          '当前 workspace 的 python.analysis.stubPath 似乎不是此扩展设置的。是否强制清除以完全禁用扩展的代码提示？（可能删除用户自定义配置）',
          'Force Clear', 'Keep'
        );
        shouldClear = pick === 'Force Clear';
      }

      if (shouldClear) {
        await pythonConfig.update('analysis.stubPath', undefined, vscode.ConfigurationTarget.Workspace);

        const normalizedLastTypeshed = lastTypeshed ? lastTypeshed.replace(/\\/g, '/') : undefined;
        const filteredTypeshedPaths = currentTypeshedPaths.filter(p => {
          const normalized = p.replace(/\\/g, '/');
          const matchesLast = Boolean(normalizedLastTypeshed) && normalized === normalizedLastTypeshed;
          return !matchesLast && !isInWorkspaceInstall(p);
        });
        if (filteredTypeshedPaths.length !== currentTypeshedPaths.length) {
          await pythonConfig.update(
            'analysis.typeshedPaths',
            filteredTypeshedPaths.length > 0 ? filteredTypeshedPaths : undefined,
            vscode.ConfigurationTarget.Workspace
          );
        }

        // 清理我们可能加入的 extraPaths
        const extra = pythonConfig.get<string[]>('analysis.extraPaths', []) || [];
        const mpyConfig = vscode.workspace.getConfiguration('microPythonWorkBench');
        const userExtraPaths = mpyConfig.get<string[]>('codeCompletionExtraPaths', []) || [];
        const newExtra = extra.filter(p => !(p && (
          p.replace(/\\/g,'/').toLowerCase().includes('.mpy-workbench')
          || p.toLowerCase().includes('code_completion')
          || userExtraPaths.includes(p)
        )));
        if (newExtra.length !== extra.length) {
          await pythonConfig.update('analysis.extraPaths', newExtra, vscode.ConfigurationTarget.Workspace);
        }
        const acExtra = pythonConfig.get<string[]>('autoComplete.extraPaths', []) || [];
        const newAc = acExtra.filter(p => !(p && (p.replace(/\\/g,'/').toLowerCase().includes('.mpy-workbench') || p.toLowerCase().includes('code_completion'))));
        if (newAc.length !== acExtra.length) {
          await pythonConfig.update('autoComplete.extraPaths', newAc, vscode.ConfigurationTarget.Workspace);
        }

        // Clear persisted record
        try { await this.context?.workspaceState.update('mpy.lastStubPath', undefined); } catch {}
        try { await this.context?.workspaceState.update('mpy.lastBaseStubPath', undefined); } catch {}
        try { await this.context?.workspaceState.update('mpy.lastTypeshedPath', undefined); } catch {}
        this.lastStubPath = undefined;
        this.lastBaseStubPath = undefined;
        this.lastTypeshedPath = undefined;
      }

      this.isEnabled = false;
    } catch (error) {
      vscode.window.showErrorMessage(
        Localization.t('messages.codeCompletionDisableFailed', error instanceof Error ? error.message : String(error))
      );
    }
  }

  /**
   * 切换代码补全状态
   */
  private async toggleCodeCompletion(): Promise<void> {
    const config = vscode.workspace.getConfiguration('microPythonWorkBench');
    const currentValue = config.get<boolean>('enableCodeCompletion', false);

    const newValue = !currentValue;

    await config.update('enableCodeCompletion', newValue, vscode.ConfigurationTarget.Workspace);
  }

  /**
   * 获取stub文件路径
   */
  private getStubPath(): string {
    const extension = vscode.extensions.getExtension('WebForks.mpy');
    if (!extension) {
      throw new Error('MicroPython WorkBench extension not found');
    }

    // 自动根据VS Code语言环境选择
    // 如果是中文环境，使用zh-cn，否则使用default
    const language = vscode.env.language && vscode.env.language.startsWith('zh') ? 'zh-cn' : 'default';

    return path.join(extension.extensionPath, 'code_completion', language);
  }

  /**
   * 重启 Pylance 语言服务器以应用更改
   */
  private async tryRestartLanguageServer(): Promise<boolean> {
    const cmd = 'python.analysis.restartLanguageServer';

    // Ensure Python extension exists
    const pythonExt = vscode.extensions.getExtension('ms-python.python');
    if (!pythonExt) {
      console.warn('[CodeCompletion] Python extension not installed; cannot restart language server');
      return false;
    }

    // Try to activate Python extension if needed
    try {
      if (!pythonExt.isActive) {
        await pythonExt.activate();
      }
    } catch (e) {
      console.warn('[CodeCompletion] Failed to activate Python extension:', e);
      return false;
    }

    // Ensure command is registered
    try {
      const commands = await vscode.commands.getCommands(true);
      if (!commands.includes(cmd)) {
        console.warn('[CodeCompletion] Command not available:', cmd);
        return false;
      }
    } catch (e) {
      console.warn('[CodeCompletion] Failed to query commands:', e);
      return false;
    }

    try {
      await vscode.commands.executeCommand(cmd);
      return true;
    } catch (e) {
      console.warn('[CodeCompletion] executeCommand failed:', e);
      return false;
    }
  }

  private async restartPylanceLanguageServer(): Promise<void> {
    const ok = await this.tryRestartLanguageServer();
    if (!ok) {
      vscode.window.showInformationMessage('Pylance 配置已更新，但无法自动重启语言服务。请手动执行 “Python: Restart Language Server”。');
    }
  }

  private async safeRestartLanguageServer(): Promise<void> {
    const ok = await this.tryRestartLanguageServer();
    if (ok) return;
    // 如果第一次失败，等待并重试一次
    await new Promise(r => setTimeout(r, 600));
    const retried = await this.tryRestartLanguageServer();
    if (!retried) {
      vscode.window.showInformationMessage('Pylance 配置已更新，但无法自动重启语言服务。请手动执行 “Python: Restart Language Server”。');
    }
  }

  /**
   * 更新Python配置
   * 同时负责清理可能残留的全局配置
   */
  private async updatePythonConfiguration(stubInfo: StubInspection | null): Promise<void> {
    const extension = vscode.extensions.getExtension('WebForks.mpy');
    const workspaceRoot = this.getWorkspaceRoot();
    const mpyConfig = vscode.workspace.getConfiguration('microPythonWorkBench');
    const stubInstallPath = mpyConfig.get<string>('stubInstallPath', '.mpy-workbench/pyi');
    const userExtraPaths = mpyConfig.get<string[]>('codeCompletionExtraPaths', []) || [];
    const result = await applyPythonCompletionConfiguration({
      stubInfo,
      workspaceState: this.context?.workspaceState,
      extensionPath: extension?.extensionPath,
      workspaceRoot,
      stubInstallPath,
      lastStubPath: this.lastStubPath,
      lastTypeshedPath: this.lastTypeshedPath,
      userExtraPaths,
    });

    this.lastTypeshedPath = result.appliedTypeshedPath;
    try {
      await this.context?.workspaceState.update('mpy.lastTypeshedPath', result.appliedTypeshedPath);
    } catch (e) {
      console.warn('[CodeCompletion] failed to persist lastTypeshedPath', e);
    }
    
    // 近期 Pylance 版本在 stop/restart 上不稳定，这里只写配置，不再强制重启。
    // 若语言服务没有即时刷新，用户仍可手动执行“Python: Restart Language Server”。
    if (result.settingsChanged) {
      vscode.window.setStatusBarMessage('MPY 补全配置已更新；若提示未立即刷新，请手动执行 Python: Restart Language Server。', 6000);
    }
  }

  private async refreshAppliedStubOverlay(baseStub: StubInspection): Promise<void> {
    const appliedStub = this.applyExtraStubOverlay(baseStub);
    await this.updatePythonConfiguration(appliedStub);
    await this.persistAppliedStubState(baseStub, appliedStub);
    this.updateStatusBar();
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getResolvedInstallPath(): string {
    const config = vscode.workspace.getConfiguration('microPythonWorkBench');
    const installPath = config.get<string>('stubInstallPath', '.mpy-workbench/pyi');
    const workspaceRoot = this.getWorkspaceRoot();
    return workspaceRoot ? path.join(workspaceRoot, installPath) : installPath;
  }

  private getStubSearchPaths(): string[] {
    return [this.getResolvedInstallPath()].filter(Boolean);
  }

  private applyExtraStubOverlay(baseStub: StubInspection): StubInspection {
    const mpyConfig = vscode.workspace.getConfiguration('microPythonWorkBench');
    const configuredExtraPaths = mpyConfig.get<string[]>('codeCompletionExtraPaths', []) || [];

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return baseStub;

    try {
      const overlayRoot = buildOverlayStubRoot(baseStub.root, workspaceRoot, configuredExtraPaths);
      if (overlayRoot === baseStub.root) return baseStub;

      const overlayStub = inspectStubRoot(overlayRoot);
      return overlayStub || { ...baseStub, root: overlayRoot };
    } catch (e) {
      console.warn('[CodeCompletion] failed to build extra stub overlay', e);
      vscode.window.setStatusBarMessage('额外 pyi 目录合并失败，已回退到基础 MicroPython stubs。', 6000);
      return baseStub;
    }
  }

  private getBundledStubInspection(): StubInspection | null {
    try {
      return inspectStubRoot(this.getStubPath());
    } catch {
      return null;
    }
  }

  private warnIfPyrightOverrides(): void {
    const override = detectPyrightConfigOverride(this.getWorkspaceRoot());
    if (!override) return;

    void vscode.window.showWarningMessage(
      `检测到 ${path.basename(override.path)} 会覆盖 VS Code 的 python.analysis.* 设置。若代码提示未按预期生效，请在该配置中同步 stubPath/typeshedPath。`
    );
  }

  private parseReleaseVersion(release?: string | undefined): { major: number; minor: number; patch: number } | null {
    if (!release) return null;

    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(release);
    if (!match) return null;

    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3] || '0'),
    };
  }

  private compareReleaseVersion(
    left: { major: number; minor: number; patch: number },
    right: { major: number; minor: number; patch: number }
  ): number {
    if (left.major !== right.major) return left.major - right.major;
    if (left.minor !== right.minor) return left.minor - right.minor;
    return left.patch - right.patch;
  }

  private pickBestInstalledStub(
    entries: ReturnType<typeof indexStubPaths>,
    recommendation: StubPackageRecommendation,
    port?: string,
    machine?: string,
    board?: string
  ): StubInspection | null {
    const best = findBestMatch(entries, {
      release: recommendation.cleanedRelease,
      port,
      machine,
      board,
    });
    return best ? inspectStubRoot(best.path) : null;
  }

  private async chooseInstalledEntry(entries: ReturnType<typeof indexStubPaths>, placeHolder: string): Promise<StubInspection | null> {
    if (!entries || entries.length === 0) return null;

    const items = entries.map(entry => ({
      label: entry.name + (entry.version ? ` (v${entry.version.major}.${entry.version.minor}.${entry.version.patch})` : ''),
      description: entry.path,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder });
    if (!pick) return null;

    const selected = entries.find(entry => pick.description === entry.path || pick.label.startsWith(entry.name));
    return selected ? inspectStubRoot(selected.path) : null;
  }

  private async installStubPackageAndInspect(pkgSpec: string, installRoot: string): Promise<StubInspection> {
    const installedDir = await installStubPackage(pkgSpec, installRoot);
    const inspected = inspectStubRoot(installedDir);
    if (!inspected) {
      throw new Error(`已安装 ${pkgSpec}，但未发现有效的 stub 根：${installedDir}`);
    }
    return inspected;
  }

  private async promptSpecificInstall(
    installRoot: string,
    recommendation: StubPackageRecommendation
  ): Promise<StubInspection | null> {
    const basePackage = recommendation.basePackage;
    const prompt = basePackage
      ? `输入要安装的版本号（如 1.28.0.post3）或完整包规格。留空将安装最新 ${basePackage}`
      : '输入要安装的完整 pip 包规格，例如 micropython-esp32-stubs==1.28.0.post3';
    const value = await vscode.window.showInputBox({
      prompt,
      placeHolder: basePackage || 'micropython-esp32-stubs==1.28.0.post3',
      ignoreFocusOut: true,
    });

    if (value === undefined) return null;

    const trimmed = value.trim();
    let pkgSpec = trimmed;
    if (!pkgSpec && basePackage) {
      pkgSpec = basePackage;
    } else if (pkgSpec && /^\d/.test(pkgSpec) && basePackage) {
      pkgSpec = `${basePackage}==${pkgSpec}`;
    }

    if (!pkgSpec) return null;
    return this.installStubPackageAndInspect(pkgSpec, installRoot);
  }

  private async persistAppliedStubState(baseStubInfo: StubInspection, appliedStubInfo: StubInspection): Promise<void> {
    try {
      if (!this.context) return;
      this.lastBaseStubPath = baseStubInfo.root;
      this.lastStubPath = appliedStubInfo.root;
      await this.context.workspaceState.update('mpy.lastBaseStubPath', baseStubInfo.root);
      await this.context.workspaceState.update('mpy.lastStubPath', appliedStubInfo.root);
    } catch (e) {
      console.warn('[CodeCompletion] failed to persist lastStubPath', e);
    }
  }

  private async handleVersionMismatch(
    currentStub: StubInspection,
    entries: ReturnType<typeof refreshIndex>,
    recommendation: StubPackageRecommendation,
    installRoot: string
  ): Promise<StubInspection | null> {
    const boardInfo = boardInfoService.getBoardInfo();
    const deviceVersion = this.parseReleaseVersion(boardInfo?.release || recommendation.cleanedRelease);
    if (!deviceVersion) return currentStub;

    const currentEntry = entries.find(entry => entry.path === currentStub.root || currentStub.root.startsWith(entry.path));
    if (!currentEntry?.version) return currentStub;
    if (this.compareReleaseVersion(deviceVersion, currentEntry.version) <= 0) {
      return currentStub;
    }

    vscode.window.setStatusBarMessage(
      `设备 MicroPython ${boardInfo?.release || recommendation.cleanedRelease} 高于当前 stub ${currentEntry.name}；将继续使用已安装的最接近版本，如需切换或安装请使用 MPY: Stub。`,
      7000,
    );

    return currentStub;
  }

  /**
   * 获取已启用模块的列表（用于状态栏 tooltip）
   */
  private getEnabledModulesList(): string[] {
    const modules: string[] = [];
    try {
      // 获取主 stub 路径
      const pythonConfig = vscode.workspace.getConfiguration('python');
      const stubPath = pythonConfig.get<string>('analysis.stubPath', '');
      
      // 获取额外路径
      const mpyConfig = vscode.workspace.getConfiguration('microPythonWorkBench');
      const userExtraPaths = mpyConfig.get<string[]>('codeCompletionExtraPaths', []) || [];
      
      // 收集所有路径
      const allPaths = [stubPath, ...userExtraPaths].filter(Boolean);
      
      for (const p of allPaths) {
        try {
          if (!fs.existsSync(p)) continue;
          const stats = fs.statSync(p);
          if (stats.isDirectory()) {
            // 列出目录下的模块
            const items = fs.readdirSync(p);
            for (const item of items) {
              // 忽略隐藏文件和特殊目录
              if (item.startsWith('.') || item.startsWith('_')) continue;
              const itemPath = path.join(p, item);
              const itemStats = fs.statSync(itemPath);
              if (itemStats.isDirectory()) {
                // 目录形式的模块
                modules.push(item);
              } else if (item.endsWith('.pyi') || item.endsWith('.py')) {
                // 单文件模块
                modules.push(item.replace(/\.pyi?$/, ''));
              }
            }
          }
        } catch {
          // 忽略无法访问的路径
        }
      }
    } catch {
      // 忽略错误
    }
    
    // 去重并排序
    return [...new Set(modules)].sort();
  }

  /**
   * 更新状态栏
   */
  private updateStatusBar(): void {
    const activeEditor = vscode.window.activeTextEditor;
    const isPythonFile = activeEditor && activeEditor.document.languageId === 'python';

    // 只有在打开 Python 文件时才显示状态栏
    if (!isPythonFile) {
      this.statusBarItem.hide();
      this.stubStatusBarItem.hide();
      return;
    }

    let text = '';
    let tooltip = '';
    let color = undefined;

    if (this.isEnabled) {
      text = '$(lightbulb)';
      const enabledModules = this.getEnabledModulesList();
      if (enabledModules.length > 0) {
        // 显示前10个模块，超过则显示省略
        const displayModules = enabledModules.slice(0, 10);
        const remaining = enabledModules.length - 10;
        tooltip = Localization.t('messages.codeCompletionEnabled') + '\n\n已启用模块:\n' + displayModules.join(', ');
        if (remaining > 0) {
          tooltip += `\n...及其他 ${remaining} 个模块`;
        }
      } else {
        tooltip = Localization.t('messages.codeCompletionEnabled');
      }
      color = '#00ff00'; // 启用状态显示绿色
    } else {
      text = '$(lightbulb-slash)';
      tooltip = Localization.t('messages.codeCompletionDisabled');
      color = '#888888'; // 禁用状态显示灰色
    }

    // 恢复自动补全按钮为原始文字标签（显示功能而非仅图标）
    const fullLabel = this.getStubDisplayString();
    this.statusBarItem.text = this.isEnabled ? '$(lightbulb) MPY' : '$(lightbulb-slash) MPY';
    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.color = color;
    this.statusBarItem.show();

    // stub 状态栏项显示为功能标签（按钮表明用途），悬停显示详细 stub 名称/版本
    this.stubStatusBarItem.text = 'MPY: Stub';
    this.stubStatusBarItem.tooltip = fullLabel ? `${fullLabel}\n(点击以选择/切换)` : '选择或切换 MicroPython stubs';
    this.stubStatusBarItem.show();
  }

  private getStubDisplayString(): string {
    try {
      const pythonConfig = vscode.workspace.getConfiguration('python');
      const currentStubPath = (pythonConfig.get<string>('analysis.stubPath') || this.lastStubPath || '').trim();
      const displayStubPath = (this.lastBaseStubPath || currentStubPath).trim();
      if (!displayStubPath) return 'no stub';

      const config = vscode.workspace.getConfiguration('microPythonWorkBench');
      const installPath = config.get<string>('stubInstallPath', '.mpy-workbench/pyi');
      const ws = vscode.workspace.workspaceFolders?.[0];
      const root = ws ? ws.uri.fsPath : undefined;
      const resolvedInstall = root ? path.join(root, installPath) : installPath;
      const searchPaths = [resolvedInstall].filter(Boolean) as string[];

      const entries = indexStubPaths(searchPaths);
      const found = entries.find(e => displayStubPath === e.path || displayStubPath.startsWith(e.path));
      if (found) return found.name + (found.version ? ` v${found.version.major}.${found.version.minor}.${found.version.patch}` : '');

      // fallback to base name of path
      try { return path.basename(displayStubPath); } catch { return 'unknown'; }
    } catch (e) {
      return 'unknown';
    }
  }

  private getStubShortDisplayString(): string {
    try {
      const pythonConfig = vscode.workspace.getConfiguration('python');
      const currentStubPath = (pythonConfig.get<string>('analysis.stubPath') || this.lastStubPath || '').trim();
      const displayStubPath = (this.lastBaseStubPath || currentStubPath).trim();
      if (!displayStubPath) return 'MPY:—';

      const config = vscode.workspace.getConfiguration('microPythonWorkBench');
      const installPath = config.get<string>('stubInstallPath', '.mpy-workbench/pyi');
      const ws = vscode.workspace.workspaceFolders?.[0];
      const root = ws ? ws.uri.fsPath : undefined;
      const resolvedInstall = root ? path.join(root, installPath) : installPath;
      const searchPaths = [resolvedInstall].filter(Boolean) as string[];

      const entries = indexStubPaths(searchPaths);
      const found = entries.find(e => displayStubPath === e.path || displayStubPath.startsWith(e.path));
      if (found) {
        const name = found.name || path.basename(found.path || '');
        const ver = found.version ? `${found.version.major}.${found.version.minor}` : '';
        const label = ver ? `${name} ${ver}` : name;
        return label.length > 18 ? label.slice(0, 15) + '…' : label;
      }

      // fallback to base name of path, truncated
      try {
        const b = path.basename(displayStubPath);
        return b.length > 18 ? b.slice(0, 15) + '…' : b;
      } catch { return 'MPY:—'; }
    } catch (e) {
      return 'MPY:—';
    }
  }

  /**
   * 获取当前状态
   */
  public getStatus(): { isEnabled: boolean; mode: boolean } {
    const config = vscode.workspace.getConfiguration('microPythonWorkBench');
    const enableCodeCompletion = config.get<boolean>('enableCodeCompletion', false);

    return {
      isEnabled: this.isEnabled,
      mode: enableCodeCompletion
    };
  }

  /**
   * 从已安装的 stubs 中选择一个用于 workspace 的 stubPath
   */
  public async chooseStub(): Promise<void> {
    try {
      const resolvedInstall = this.getResolvedInstallPath();
      const searchPaths = this.getStubSearchPaths();
      const boardInfo = boardInfoService.getBoardInfo();
      const recommendation = buildStubPackageRecommendation(boardInfo);
      this.warnIfPyrightOverrides();

      let entries = indexStubPaths(searchPaths);
      const actions: vscode.QuickPickItem[] = [];
      if (entries.length > 0) {
        actions.push({ label: 'Use Installed...', description: '从已安装的 pyi 中选择' });
      }
      if (recommendation.primary) {
        actions.push({ label: 'Install Matching Version...', description: `安装推荐版本 ${recommendation.primary}` });
      }
      actions.push({ label: 'Install Specific Version...', description: '安装指定版本或完整包规格' });
      actions.push({ label: 'Refresh Index', description: '刷新已安装 stub 索引' });

      const action = await vscode.window.showQuickPick(actions, { placeHolder: '选择 MicroPython stub 操作' });
      if (!action) return;

      let selectedStub: StubInspection | null = null;
      if (action.label === 'Use Installed...') {
        selectedStub = await this.chooseInstalledEntry(entries, '选择要用于代码补全的 stub');
      } else if (action.label === 'Install Matching Version...') {
        if (!recommendation.primary) {
          vscode.window.showWarningMessage('当前未检测到设备版本，无法推荐安装匹配的 stub。');
          return;
        }
        selectedStub = await this.installStubPackageAndInspect(recommendation.primary, resolvedInstall);
        entries = refreshIndex(searchPaths);
      } else if (action.label === 'Install Specific Version...') {
        selectedStub = await this.promptSpecificInstall(resolvedInstall, recommendation);
        entries = refreshIndex(searchPaths);
      } else if (action.label === 'Refresh Index') {
        entries = refreshIndex(searchPaths);
        selectedStub = await this.chooseInstalledEntry(entries, '选择要用于代码补全的 stub');
      }

      if (!selectedStub) return;

      const baseStub = selectedStub;
      selectedStub = this.applyExtraStubOverlay(baseStub);

      await this.updatePythonConfiguration(selectedStub);
      await this.persistAppliedStubState(baseStub, selectedStub);

      this.updateStatusBar();
    } catch (e) {
      vscode.window.showErrorMessage('选择 stub 失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }
}

// 导出单例实例
export const codeCompletionManager = CodeCompletionManager.getInstance();
