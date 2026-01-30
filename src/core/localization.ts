import * as vscode from 'vscode';

/**
 * 本地化工具函数
 * 使用 VS Code 的内置本地化 API (NLS)
 */
export class Localization {
  /**
   * 获取本地化字符串
   * @param key 本地化键
   * @param args 格式化参数
   * @returns 本地化后的字符串
   */
  static t(key: string, ...args: any[]): string {
    // 内置的翻译映射，避免 require 路径问题
    const defaultTranslations: { [key: string]: string } = {
      'messages.codeCompletionEnabled': 'Code completion enabled',
      'messages.codeCompletionDisabled': 'Code completion disabled',
      'messages.pylanceNotInstalled': 'Pylance extension is not installed',
      'messages.installPylance': 'Install Pylance',
      'messages.codeCompletionEnableFailed': 'Failed to enable code completion: {0}',
      'messages.codeCompletionDisableFailed': 'Failed to disable code completion: {0}'
    };

    const zhTranslations: { [key: string]: string } = {
      'messages.codeCompletionEnabled': '代码补全已启用',
      'messages.codeCompletionDisabled': '代码补全已禁用',
      'messages.pylanceNotInstalled': '未安装 Pylance 扩展',
      'messages.installPylance': '安装 Pylance',
      'messages.codeCompletionEnableFailed': '启用代码补全失败: {0}',
      'messages.codeCompletionDisableFailed': '禁用代码补全失败: {0}'
    };

    // Try to load package-level translations; fall back to embedded defaults
    let translations: { [key: string]: string } | undefined;
    try {
      // Attempt several relative paths depending on runtime location
      let nls: any;
      try { nls = require('../../package.nls.json'); } catch { try { nls = require('../package.nls.json'); } catch { nls = undefined; } }
      let zhCn: any;
      try { zhCn = require('../../package.nls.zh-cn.json'); } catch { try { zhCn = require('../package.nls.zh-cn.json'); } catch { zhCn = undefined; } }
      const locale = (vscode.env && vscode.env.language) ? vscode.env.language : 'en';
      if (locale.startsWith('zh') && zhCn) translations = zhCn;
      else if (nls) translations = nls;
    } catch (e) {
      translations = undefined;
    }

    // Resolve message with better fallbacks:
    // 1. translation file (if present)
    // 2. if VS Code language is Chinese -> embedded `zhTranslations` (prefer Chinese)
    // 3. defaultTranslations (English)
    // 4. finally the key
    let message: string;
    if (translations && translations[key]) {
      message = String(translations[key]);
    } else if ((vscode.env && typeof vscode.env.language === 'string') && vscode.env.language.startsWith('zh')) {
      message = String(zhTranslations[key] || defaultTranslations[key] || key);
    } else {
      message = String(defaultTranslations[key] || (translations && translations[key]) || key);
    }

    // Lightweight debug: if debug enabled, print where the localization came from
    try {
      const enabled = vscode.workspace.getConfiguration().get<boolean>('microPythonWorkBench.debug', false);
      if (enabled) {
        const src = (translations && translations[key]) ? 'package.nls*' : (vscode.env.language.startsWith('zh') && zhTranslations[key]) ? 'embedded zh' : (defaultTranslations[key] ? 'embedded en-default' : 'missing');
        console.debug(`[Localization] key=${key} locale=${vscode.env.language} source=${src} msg=${message}`);
      }
    } catch {}

    // If no translation and args provided, include args in fallback message for context
    if (message === key && args.length > 0) {
      return `${key}: ${args.map(a => String(a)).join(' ')}`;
    }

    // Simple placeholder replacement
    if (args.length > 0) {
      args.forEach((arg, index) => {
        message = message.replace(new RegExp(`\\{${index}\\}`, 'g'), String(arg));
      });
    }

    return message;
  }

  /**
   * 显示本地化的信息消息
   * @param key 本地化键
   * @param args 格式化参数
   */
  static showInfo(key: string, ...args: any[]): Thenable<string | undefined> {
    return vscode.window.showInformationMessage(this.t(key, ...args));
  }

  /**
   * 显示本地化的错误消息
   * @param key 本地化键
   * @param args 格式化参数
   */
  static showError(key: string, ...args: any[]): Thenable<string | undefined> {
    return vscode.window.showErrorMessage(this.t(key, ...args));
  }

  /**
   * 显示本地化的警告消息
   * @param key 本地化键
   * @param args 格式化参数
   */
  static showWarning(key: string, ...args: any[]): Thenable<string | undefined> {
    return vscode.window.showWarningMessage(this.t(key, ...args));
  }
}

// 导出便捷函数
export const t = Localization.t;
export const showInfo = Localization.showInfo;
export const showError = Localization.showError;
export const showWarning = Localization.showWarning;