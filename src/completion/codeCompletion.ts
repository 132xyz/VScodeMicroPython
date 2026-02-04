import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'node:fs';
import { Localization } from '../core/localization';
import { boardInfoService } from '../board/boardInfoService';
import { indexStubPaths, findBestMatch } from './stubIndex';
import { installStubPackage } from './stubInstaller';
import { refreshIndex } from './stubIndex';

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

  /**
   * 初始化代码补全管理器
   */
  public async initialize(context: vscode.ExtensionContext): Promise<void> {
    this.context = context;
    try { this.lastStubPath = await context.workspaceState.get<string>('mpy.lastStubPath'); } catch {}
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
        if (e.affectsConfiguration('microPythonWorkBench.enableCodeCompletion') ||
            e.affectsConfiguration('microPythonWorkBench.codeCompletionExtraPaths')) {
          this.handleConfigurationChange();
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

      // 查找已安装的 stubs（只在启用时查找一次）
      // 注意：codeCompletionExtraPaths 不用于搜索可选 stub，而是直接加入 Pylance 搜索路径
      const config = vscode.workspace.getConfiguration('microPythonWorkBench');
      const installPath = config.get<string>('stubInstallPath', '.mpy-workbench/pyi');
      const ws = vscode.workspace.workspaceFolders?.[0];
      const root = ws ? ws.uri.fsPath : undefined;
      const resolvedInstall = root ? path.join(root, installPath) : installPath;
      const searchPaths = [resolvedInstall].filter(Boolean);

      const entries = indexStubPaths(searchPaths);
      let chosenPath: string | null = null;

      const boardInfo = boardInfoService.getBoardInfo();
      // normalize release (strip -preview and any suffix after '-') and prefer sysname as port
      const normalizeToKebab = (s?: string) => {
        if (!s) return '';
        return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      };

      let cleanedRelease: string | undefined = undefined;
      if (boardInfo && boardInfo.release) {
        cleanedRelease = String(boardInfo.release).split('-')[0];
      }

      if (boardInfo) {
        const portForMatch = boardInfo.sysname || boardInfo.machine;
        const best = findBestMatch(entries, { release: cleanedRelease, machine: portForMatch });
        if (best) chosenPath = best.path;
      }

      // If nothing found and auto-select enabled, prompt to install
      const auto = vscode.workspace.getConfiguration('microPythonWorkBench').get<boolean>('stubAutoSelect', true);
      let finalStubPath: string | null = null;

      if (!chosenPath) {
        if (entries.length === 0 && boardInfo && auto) {
          // build candidate package names using sysname as port and board extracted from machine
          const portRaw = boardInfo.sysname || boardInfo.machine || '';
          // try to extract board name from machine info e.g. 'ESP32-S3-AMOLED with ESP32S3' -> 'ESP32-S3-AMOLED'
          const boardRaw = boardInfo.machine ? String(boardInfo.machine).split(/\s+with\s+/i)[0] : '';
          const portNorm = normalizeToKebab(portRaw);
          const boardNorm = normalizeToKebab(boardRaw);
          const versionSpec = cleanedRelease ? (() => {
            const m = /^(\d+)\.(\d+)/.exec(cleanedRelease!);
            return m ? `==${m[1]}.${m[2]}.*` : '';
          })() : '';

          // Prefer port-only package (e.g. micropython-esp32-stubs==1.28.*).
          const primary = `micropython-${portNorm}-stubs${versionSpec}`;
          // Board-specific candidate as secondary (e.g. micropython-esp32-esp32-s3-amoled-stubs==...)
          const secondary = boardNorm ? `micropython-${portNorm}-${boardNorm}-stubs${versionSpec}` : undefined;

          const install = await vscode.window.showInformationMessage(
            secondary
              ? `未找到匹配的 MicroPython stubs，是否安装 ${primary} 到工作区? (备选: ${secondary})`
              : `未找到匹配的 MicroPython stubs，是否安装 ${primary} 到工作区?`,
            'Install', 'Cancel'
          );
          if (install === 'Install') {
            const ws = vscode.workspace.workspaceFolders?.[0];
            const installPathResolved = ws ? path.join(ws.uri.fsPath, installPath) : installPath;
            try {
              const installedDir = await installStubPackage(primary, installPathResolved);
              // re-index including the installed subdir
              const reEntries = indexStubPaths([installedDir, installPathResolved]);
              const best = findBestMatch(reEntries, { release: cleanedRelease, machine: boardInfo.sysname || boardInfo.machine });
              if (best) finalStubPath = best.path;
              else finalStubPath = installedDir;
            } catch (e) {
              vscode.window.showErrorMessage('安装 stubs 失败: ' + (e instanceof Error ? e.message : String(e)));
            }
          }
        }
      }

      // fallback to chosenPath or bundled path
      let stubPath = finalStubPath || chosenPath || this.getStubPath();

      // Ensure stubPath points to a directory that actually contains core pyi files (e.g. machine.pyi).
      const ensureContainsCore = (p: string | undefined | null): string | null => {
        if (!p) return null;
        try {
          if (fs.existsSync(path.join(p, 'machine.pyi')) || fs.existsSync(path.join(p, 'umachine.pyi')) || fs.existsSync(path.join(p, 'micropython.pyi'))) {
            return p;
          }
          // search one level down for candidate directories containing machine.pyi
          const items = fs.readdirSync(p, { withFileTypes: true });
          for (const it of items) {
            if (!it.isDirectory()) continue;
            const sub = path.join(p, it.name);
            if (fs.existsSync(path.join(sub, 'machine.pyi')) || fs.existsSync(path.join(sub, 'umachine.pyi')) || fs.existsSync(path.join(sub, 'micropython.pyi'))) {
              return sub;
            }
          }
        } catch (e) {
          // ignore
        }
        return null;
      };

      const validated = ensureContainsCore(stubPath);
      if (validated) stubPath = validated;

      // Version mismatch handling: if device mpy version > stub version, prompt user
      try {
        const boardInfoNow = boardInfoService.getBoardInfo();
        if (boardInfoNow && boardInfoNow.release) {
          const parseRel = (r: string) => {
            const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(r);
            if (!m) return null;
            return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || '0') };
          };
          const deviceVer = parseRel(boardInfoNow.release);
          if (deviceVer) {
            // find entry corresponding to stubPath
            const allEntries = refreshIndex(searchPaths);
            const currentEntry = allEntries.find(e => e.path === stubPath) || allEntries.find(e => stubPath.includes(e.name));
            if (currentEntry && currentEntry.version) {
              const cmp = (a: any, b: any) => {
                if (a.major !== b.major) return a.major - b.major;
                if (a.minor !== b.minor) return a.minor - b.minor;
                return a.patch - b.patch;
              };
              if (cmp(deviceVer, currentEntry.version) > 0) {
                // device newer than stub
                const choice = await vscode.window.showQuickPick([
                  { label: 'Use Latest Available', description: '选择已安装的最新可用 pyi' },
                  { label: 'Choose Installed...', description: '从已安装的 pyi 中选择' },
                  { label: 'Keep Current', description: '继续使用当前选择（可能不完全兼容）' }
                ], { placeHolder: `设备 MicroPython ${boardInfoNow.release} 高于选中 stub ${currentEntry.name}（v${currentEntry.version.major}.${currentEntry.version.minor}.${currentEntry.version.patch}），请选择回退策略` });

                if (choice && choice.label === 'Use Latest Available') {
                  const withVer = allEntries.filter(e => e.version).sort((a, b) => (b.version!.major - a.version!.major) || (b.version!.minor - a.version!.minor) || (b.version!.patch - a.version!.patch));
                  if (withVer.length > 0) stubPath = withVer[0].path;
                } else if (choice && choice.label === 'Choose Installed...') {
                  const pick = await vscode.window.showQuickPick(allEntries.map(e => ({ label: e.name, description: e.path })), { placeHolder: '选择已安装的 stub' });
                  if (pick) {
                    const sel = allEntries.find(e => e.name === pick.label);
                    if (sel) stubPath = sel.path;
                  }
                } else {
                  // Keep current
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('[CodeCompletion] version mismatch handling failed', e);
      }

      await this.updatePythonConfiguration(stubPath);

      // Persist the stubPath we just applied so we can reliably clear it on disable.
      try {
        if (this.context && stubPath) {
          this.lastStubPath = stubPath;
          await this.context.workspaceState.update('mpy.lastStubPath', stubPath);
        }
      } catch (e) {
        console.warn('[CodeCompletion] failed to persist lastStubPath', e);
      }

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

      const last = this.lastStubPath || (this.context ? this.context.workspaceState.get<string>('mpy.lastStubPath') : undefined);

      const ws = vscode.workspace.workspaceFolders?.[0];
      const wsRoot = ws ? ws.uri.fsPath : undefined;
      const installPathCfg = vscode.workspace.getConfiguration('microPythonWorkBench').get<string>('stubInstallPath', '.mpy-workbench/pyi');

      const isInWorkspaceInstall = (p?: string) => {
        if (!p) return false;
        const normalized = p.replace(/\\/g, '/').toLowerCase();
        if (normalized.includes('.mpy-workbench')) return true;
        if (wsRoot) {
          const rootNorm = wsRoot.replace(/\\/g, '/').toLowerCase();
          if (normalized.startsWith(rootNorm)) return true;
        }
        if (installPathCfg && wsRoot) {
          const expected = path.join(wsRoot, installPathCfg).replace(/\\/g, '/').toLowerCase();
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

        // 清理我们可能加入的 extraPaths
        const extra = pythonConfig.get<string[]>('analysis.extraPaths', []) || [];
        const newExtra = extra.filter(p => !(p && (p.replace(/\\/g,'/').toLowerCase().includes('.mpy-workbench') || p.toLowerCase().includes('code_completion'))));
        if (newExtra.length !== extra.length) {
          await pythonConfig.update('analysis.extraPaths', newExtra, vscode.ConfigurationTarget.Workspace);
        }
        const acExtra = pythonConfig.get<string[]>('autoComplete.extraPaths', []) || [];
        const newAc = acExtra.filter(p => !(p && (p.replace(/\\/g,'/').toLowerCase().includes('.mpy-workbench') || p.toLowerCase().includes('code_completion'))));
        if (newAc.length !== acExtra.length) {
          await pythonConfig.update('autoComplete.extraPaths', newAc, vscode.ConfigurationTarget.Workspace);
        }

        // Restart language server robustly
        await this.safeRestartLanguageServer();

        // Clear persisted record
        try { await this.context?.workspaceState.update('mpy.lastStubPath', undefined); } catch {}
        this.lastStubPath = undefined;
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
    await this.tryRestartLanguageServer();
  }

  private async safeRestartLanguageServer(): Promise<void> {
    const ok = await this.tryRestartLanguageServer();
    if (ok) return;
    // 如果第一次失败，等待并重试一次
    await new Promise(r => setTimeout(r, 600));
    await this.tryRestartLanguageServer();
  }

  /**
   * 更新Python配置
   * 同时负责清理可能残留的全局配置
   */
  private async updatePythonConfiguration(stubPath: string): Promise<void> {
    const pythonConfig = vscode.workspace.getConfiguration('python');
    const extension = vscode.extensions.getExtension('WebForks.mpy');
    
    // 获取可能的旧路径以便清理
    // 我们不仅要清理当前版本，还要尝试清理可能存在的旧版本路径
    // 简单的判断逻辑：路径中包含 'webforks.mpy' 或 'VScodeMicroPython' 且包含 'code_completion'
    const isExtensionPath = (p: string) => {
        if (!p) return false;
        const normalized = p.toLowerCase().replace(/\\/g, '/');
        return (normalized.includes('webforks.mpy') || normalized.includes('vscodemicropython')) && 
               normalized.includes('code_completion');
    };

    let oldPaths: string[] = [];
    if (extension) {
        oldPaths = [
            path.join(extension.extensionPath, 'code_completion', 'default'),
            path.join(extension.extensionPath, 'code_completion', 'zh-cn')
        ];
    }

    // --- 1. 清理 Global (User)配置 ---
    // 这是一个防御性措施，防止以前的版本或者单文件模式下意外污染了全局配置
    // 导致当项目内配置被禁用（或对项目外文件无效）时，回退到全局的错误配置
    const globalPythonConfig = vscode.workspace.getConfiguration('python', null);
    
    // 清理全局 analysis.extraPaths
    const globalExtraPaths = globalPythonConfig.get<string[]>('analysis.extraPaths', []) || [];
    const newGlobalExtraPaths = globalExtraPaths.filter(p => !isExtensionPath(p));
    if (newGlobalExtraPaths.length !== globalExtraPaths.length) {
      await globalPythonConfig.update('analysis.extraPaths', newGlobalExtraPaths, vscode.ConfigurationTarget.Global);
    }

    // 清理全局 autoComplete.extraPaths
    const globalAutoCompletePaths = globalPythonConfig.get<string[]>('autoComplete.extraPaths', []) || [];
    const newGlobalAutoCompletePaths = globalAutoCompletePaths.filter(p => !isExtensionPath(p));
    if (newGlobalAutoCompletePaths.length !== globalAutoCompletePaths.length) {
      await globalPythonConfig.update('autoComplete.extraPaths', newGlobalAutoCompletePaths, vscode.ConfigurationTarget.Global);
    }

    // 清理全局 analysis.stubPath
    const globalStubPath = globalPythonConfig.get<string>('analysis.stubPath', '');
    if (isExtensionPath(globalStubPath)) {
      await globalPythonConfig.update('analysis.stubPath', undefined, vscode.ConfigurationTarget.Global);
    }


    // --- 2. 更新 Workspace 配置 ---
    
    // 获取用户配置的 codeCompletionExtraPaths
    const mpyConfig = vscode.workspace.getConfiguration('microPythonWorkBench');
    const userExtraPaths = mpyConfig.get<string[]>('codeCompletionExtraPaths', []) || [];
    
    // 清理 analysis.extraPaths：移除扩展旧路径，保留用户其他路径
    const extraPaths = pythonConfig.get<string[]>('analysis.extraPaths', []) || [];
    let newExtraPaths = extraPaths.filter(p => !isExtensionPath(p) && !oldPaths.includes(p));
    
    // 如果启用（stubPath 非空），将用户配置的 codeCompletionExtraPaths 加入
    if (stubPath && userExtraPaths.length > 0) {
      for (const p of userExtraPaths) {
        if (p && !newExtraPaths.includes(p)) {
          newExtraPaths.push(p);
        }
      }
    }
    
    // 如果有变化则更新
    const extraChanged = extraPaths.length !== newExtraPaths.length || 
      extraPaths.some((p, i) => p !== newExtraPaths[i]);
    if (extraChanged) {
      await pythonConfig.update('analysis.extraPaths', newExtraPaths, vscode.ConfigurationTarget.Workspace);
    }

    // 清理 autoComplete.extraPaths
    const autoCompleteExtraPaths = pythonConfig.get<string[]>('autoComplete.extraPaths', []);
    const newAutoCompleteExtraPaths = autoCompleteExtraPaths.filter(p => !isExtensionPath(p) && !oldPaths.includes(p));
    if (newAutoCompleteExtraPaths.length !== autoCompleteExtraPaths.length) {
      await pythonConfig.update('autoComplete.extraPaths', newAutoCompleteExtraPaths, vscode.ConfigurationTarget.Workspace);
    }

    // 更新 analysis.stubPath
    const currentStubPath = pythonConfig.get<string>('analysis.stubPath', '');
    
    let needRestart = false;
    if (stubPath) {
      // 启用：设置 stubPath
      if (currentStubPath !== stubPath) {
        await pythonConfig.update('analysis.stubPath', stubPath, vscode.ConfigurationTarget.Workspace);
        needRestart = true;
      }
    } else {
       // 禁用：如果当前 stubPath 是我们的，则清除
       if (isExtensionPath(currentStubPath) || oldPaths.includes(currentStubPath)) {
         await pythonConfig.update('analysis.stubPath', undefined, vscode.ConfigurationTarget.Workspace);
         needRestart = true;
       }
    }
    
    // 配置修改后重启 Pylance（仅需一次）
    if (needRestart || extraChanged) {
      await this.restartPylanceLanguageServer();
    }
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
      if (!currentStubPath) return 'no stub';

      const config = vscode.workspace.getConfiguration('microPythonWorkBench');
      const installPath = config.get<string>('stubInstallPath', '.mpy-workbench/pyi');
      const ws = vscode.workspace.workspaceFolders?.[0];
      const root = ws ? ws.uri.fsPath : undefined;
      const resolvedInstall = root ? path.join(root, installPath) : installPath;
      const searchPaths = [resolvedInstall].filter(Boolean) as string[];

      const entries = indexStubPaths(searchPaths);
      const found = entries.find(e => currentStubPath === e.path || currentStubPath.startsWith(e.path));
      if (found) return found.name + (found.version ? ` v${found.version.major}.${found.version.minor}.${found.version.patch}` : '');

      // fallback to base name of path
      try { return path.basename(currentStubPath); } catch { return 'unknown'; }
    } catch (e) {
      return 'unknown';
    }
  }

  private getStubShortDisplayString(): string {
    try {
      const pythonConfig = vscode.workspace.getConfiguration('python');
      const currentStubPath = (pythonConfig.get<string>('analysis.stubPath') || this.lastStubPath || '').trim();
      if (!currentStubPath) return 'MPY:—';

      const config = vscode.workspace.getConfiguration('microPythonWorkBench');
      const installPath = config.get<string>('stubInstallPath', '.mpy-workbench/pyi');
      const ws = vscode.workspace.workspaceFolders?.[0];
      const root = ws ? ws.uri.fsPath : undefined;
      const resolvedInstall = root ? path.join(root, installPath) : installPath;
      const searchPaths = [resolvedInstall].filter(Boolean) as string[];

      const entries = indexStubPaths(searchPaths);
      const found = entries.find(e => currentStubPath === e.path || currentStubPath.startsWith(e.path));
      if (found) {
        const name = found.name || path.basename(found.path || '');
        const ver = found.version ? `${found.version.major}.${found.version.minor}` : '';
        const label = ver ? `${name} ${ver}` : name;
        return label.length > 18 ? label.slice(0, 15) + '…' : label;
      }

      // fallback to base name of path, truncated
      try {
        const b = path.basename(currentStubPath);
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
      const config = vscode.workspace.getConfiguration('microPythonWorkBench');
      const installPath = config.get<string>('stubInstallPath', '.mpy-workbench/pyi');
      const ws = vscode.workspace.workspaceFolders?.[0];
      const root = ws ? ws.uri.fsPath : undefined;
      const resolvedInstall = root ? path.join(root, installPath) : installPath;
      const searchPaths = [resolvedInstall].filter(Boolean) as string[];

      let entries = indexStubPaths(searchPaths);
      if (!entries || entries.length === 0) {
        const pick = await vscode.window.showInformationMessage('未发现已安装的 MicroPython stubs。是否刷新索引或安装匹配的 stubs?', 'Refresh', 'Install', 'Cancel');
        if (pick === 'Refresh') {
          refreshIndex(searchPaths);
          entries = indexStubPaths(searchPaths);
        } else if (pick === 'Install') {
          // try to build a sensible candidate from detected board info
          const boardInfo = boardInfoService.getBoardInfo();
          const normalizeToKebab = (s?: string) => {
            if (!s) return '';
            return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
          };
          const cleanedRelease = boardInfo && boardInfo.release ? String(boardInfo.release).split('-')[0] : undefined;
          const portRaw = boardInfo?.sysname || boardInfo?.machine || '';
          const boardRaw = boardInfo?.machine ? String(boardInfo.machine).split(/\s+with\s+/i)[0] : '';
          const portNorm = normalizeToKebab(portRaw);
          const boardNorm = normalizeToKebab(boardRaw);
          const versionSpec = cleanedRelease ? (() => {
            const m = /^(\d+)\.(\d+)/.exec(cleanedRelease!);
            return m ? `==${m[1]}.${m[2]}.*` : '';
          })() : '';
          const primary = `micropython-${portNorm}-stubs${versionSpec}`;
          const secondary = boardNorm ? `micropython-${portNorm}-${boardNorm}-stubs${versionSpec}` : undefined;
          const install = await vscode.window.showInformationMessage(
            secondary
              ? `未找到匹配的 MicroPython stubs，是否安装 ${primary} 到工作区? (备选: ${secondary})`
              : `未找到匹配的 MicroPython stubs，是否安装 ${primary} 到工作区?`,
            'Install', 'Cancel'
          );
          if (install === 'Install') {
            try {
              const installedDir = await installStubPackage(primary, resolvedInstall);
              // reindex including installed dir
              refreshIndex([installedDir, resolvedInstall]);
              entries = indexStubPaths([installedDir, resolvedInstall]);
            } catch (e) {
              vscode.window.showErrorMessage('安装 stubs 失败: ' + (e instanceof Error ? e.message : String(e)));
              return;
            }
          } else return;
        } else {
          return;
        }
      }

      if (!entries || entries.length === 0) {
        vscode.window.showInformationMessage('没有可用的 stub 可供选择');
        return;
      }

      const items = entries.map(e => ({ label: e.name + (e.version ? ` (v${e.version.major}.${e.version.minor}.${e.version.patch})` : ''), description: e.path }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: '选择要用于代码补全的 stub' });
      if (!pick) return;

      const selected = entries.find(e => pick.description === e.path || pick.label.startsWith(e.name));
      if (!selected) return;

      // ensure contains core pyi
      const ensureContainsCore = (p: string | undefined | null): string | null => {
        if (!p) return null;
        try {
          if (fs.existsSync(path.join(p, 'machine.pyi')) || fs.existsSync(path.join(p, 'umachine.pyi')) || fs.existsSync(path.join(p, 'micropython.pyi'))) {
            return p;
          }
          const items = fs.readdirSync(p, { withFileTypes: true });
          for (const it of items) {
            if (!it.isDirectory()) continue;
            const sub = path.join(p, it.name);
            if (fs.existsSync(path.join(sub, 'machine.pyi')) || fs.existsSync(path.join(sub, 'umachine.pyi')) || fs.existsSync(path.join(sub, 'micropython.pyi'))) {
              return sub;
            }
          }
        } catch (e) {}
        return null;
      };

      let stubPath = selected.path;
      const validated = ensureContainsCore(stubPath);
      if (validated) stubPath = validated;

      await this.updatePythonConfiguration(stubPath);

      // Persist
      try {
        if (this.context && stubPath) {
          this.lastStubPath = stubPath;
          await this.context.workspaceState.update('mpy.lastStubPath', stubPath);
        }
      } catch (e) {
        console.warn('[CodeCompletion] failed to persist lastStubPath', e);
      }

      // restart LS robustly
      await this.safeRestartLanguageServer();
      this.updateStatusBar();
    } catch (e) {
      vscode.window.showErrorMessage('选择 stub 失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }
}

// 导出单例实例
export const codeCompletionManager = CodeCompletionManager.getInstance();