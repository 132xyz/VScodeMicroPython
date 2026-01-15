import * as vscode from 'vscode';
import * as path from 'path';
import { Localization } from '../core/localization';

/**
 * 代码补全管理器
 * 负责管理 MicroPython 代码补全功能的启用、禁用和配置
 */
export class CodeCompletionManager {
  private static instance: CodeCompletionManager;
  private isEnabled: boolean = false;
  private statusBarItem: vscode.StatusBarItem;

  private constructor() {
    console.log('[CodeCompletion] Creating status bar item...');
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'microPythonWorkBench.toggleCodeCompletion';
    console.log('[CodeCompletion] Status bar item created:', this.statusBarItem ? 'success' : 'failed');
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
    console.log('[CodeCompletion] Initializing code completion manager...');

    // 注册命令
    context.subscriptions.push(
      vscode.commands.registerCommand('microPythonWorkBench.toggleCodeCompletion', () => {
        this.toggleCodeCompletion();
      })
    );

    // 注册状态栏项
    context.subscriptions.push(this.statusBarItem);

    // 监听配置变化
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('microPythonWorkBench.enableCodeCompletion')) {
          this.handleConfigurationChange();
        }
      })
    );

    // 监听活动编辑器变化
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        console.log('[CodeCompletion] Active text editor changed:', vscode.window.activeTextEditor?.document.fileName);
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
    console.log('[CodeCompletion] Handling configuration change...');

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

      // 获取stub文件路径
      const stubPath = this.getStubPath();

      // 更新Python配置
      await this.updatePythonConfiguration(stubPath);

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
      // 清除Python配置中的stub路径
      await this.updatePythonConfiguration('');

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
  private async restartPylanceLanguageServer(): Promise<void> {
    try {
        await vscode.commands.executeCommand('python.analysis.restartLanguageServer');
    } catch (e) {
        // 命令可能不存在（如果未安装 Pylance），忽略错误
        console.log('[CodeCompletion] Failed to restart Pylance:', e);
    }
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
    
    // 清理 analysis.extraPaths (只移除我们的路径，不再添加)
    const extraPaths = pythonConfig.get<string[]>('analysis.extraPaths', []);
    const newExtraPaths = extraPaths.filter(p => !isExtensionPath(p) && !oldPaths.includes(p));
    if (newExtraPaths.length !== extraPaths.length) {
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
    
    if (stubPath) {
      // 启用：设置 stubPath
      if (currentStubPath !== stubPath) {
        await pythonConfig.update('analysis.stubPath', stubPath, vscode.ConfigurationTarget.Workspace);
        // 配置修改后重启 Pylance
        await this.restartPylanceLanguageServer();
      }
    } else {
       // 禁用：如果当前 stubPath 是我们的，则清除
       if (isExtensionPath(currentStubPath) || oldPaths.includes(currentStubPath)) {
         await pythonConfig.update('analysis.stubPath', undefined, vscode.ConfigurationTarget.Workspace);
         // 配置修改后重启 Pylance
         await this.restartPylanceLanguageServer();
       }
    }
  }

  /**
   * 更新状态栏
   */
  private updateStatusBar(): void {
    console.log('[CodeCompletion] Updating status bar...');

    const activeEditor = vscode.window.activeTextEditor;
    const isPythonFile = activeEditor && activeEditor.document.languageId === 'python';
    console.log('[CodeCompletion] Active editor:', activeEditor ? activeEditor.document.fileName : 'none');
    console.log('[CodeCompletion] Is Python file:', isPythonFile);
    console.log('[CodeCompletion] Code completion enabled:', this.isEnabled);

    // 只有在打开 Python 文件时才显示状态栏
    if (!isPythonFile) {
      console.log('[CodeCompletion] Hiding status bar: not a Python file');
      this.statusBarItem.hide();
      return;
    }

    let text = '';
    let tooltip = '';
    let color = undefined;

    if (this.isEnabled) {
      text = '$(lightbulb) MPY';
      tooltip = Localization.t('messages.codeCompletionEnabled');
      color = '#00ff00'; // 启用状态显示绿色
    } else {
      text = '$(lightbulb-slash) MPY';
      tooltip = Localization.t('messages.codeCompletionDisabled');
      color = '#888888'; // 禁用状态显示灰色
    }

    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.color = color;
    console.log('[CodeCompletion] Setting status bar - text:', text, 'enabled:', this.isEnabled);
    this.statusBarItem.show();
    console.log('[CodeCompletion] Status bar item shown successfully');
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
}

// 导出单例实例
export const codeCompletionManager = CodeCompletionManager.getInstance();