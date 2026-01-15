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
    // 使用传统的 NLS 方式，通过 package.nls.*.json 文件
    const nls = require('../package.nls.json');
    const zhCn = require('../package.nls.zh-cn.json');

    // 检查当前语言环境
    const locale = vscode.env.language;
    let translations = nls; // 默认英文

    if (locale.startsWith('zh')) {
      translations = zhCn;
    }

    let message = translations[key] || nls[key] || key;

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