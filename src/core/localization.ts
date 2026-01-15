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

    try {
      // 尝试使用传统的 NLS 方式
      const nls = require('../package.nls.json');
      const zhCn = require('../package.nls.zh-cn.json');

      // 检查当前语言环境
      const locale = vscode.env.language;
      let translations = nls; // 默认英文

      if (locale.startsWith('zh')) {
        translations = zhCn;
      }

      let message = translations[key] || nls[key] || defaultTranslations[key] || zhTranslations[key] || key;
    } catch (error) {
      // 如果 require 失败，使用内置翻译
      const locale = vscode.env.language;
      let message = defaultTranslations[key] || key;

      if (locale.startsWith('zh')) {
        message = zhTranslations[key] || defaultTranslations[key] || key;
      }
    }

    let message = defaultTranslations[key] || key;
    if (vscode.env.language.startsWith('zh')) {
      message = zhTranslations[key] || defaultTranslations[key] || key;
    }

    // 简单的参数替换
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