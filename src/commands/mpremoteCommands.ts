import * as vscode from "vscode";
import * as path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { MpRemoteManager } from "../board/MpRemoteManager";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Mpremote installation and management commands
 */
export const mpremoteCommands = {
  /**
   * Check if mpremote is available and show installation guide if not
   */
  async checkAndInstallMpremote(silent: boolean = false): Promise<boolean> {
    try {
      const lang = vscode.env.language || '';
      const zh = lang.startsWith('zh');
      const pythonPath = await MpRemoteManager.detectPythonPath();
      if (!pythonPath) {
        if (!silent) vscode.window.showErrorMessage(zh ? '未检测到 Python 解释器，无法安装 mpremote。' : 'No Python interpreter detected; cannot install mpremote.');
        return false;
      }

      const available = await MpRemoteManager.isModuleAvailable(pythonPath);
      if (available) return true;

      if (silent) return false;

      const installLabel = zh ? '安装到此 Python' : 'Install to this Python';
      const showPathLabel = zh ? '显示 Python 路径' : 'Show Python Path';
      const cancelLabel = zh ? '取消' : 'Cancel';

      const choice = await vscode.window.showInformationMessage(
        zh ? `mpremote 未安装在检测到的 Python：${pythonPath}` : `mpremote is not installed in detected Python: ${pythonPath}`,
        installLabel,
        showPathLabel,
        cancelLabel
      );

      if (choice === installLabel) {
        return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: zh ? '正在安装 mpremote...' : 'Installing mpremote...' }, async () => {
          try {
            await MpRemoteManager.install(pythonPath);
            const ok = await MpRemoteManager.isModuleAvailable(pythonPath);
            if (ok) {
              vscode.window.showInformationMessage(zh ? 'mpremote 已成功安装。' : 'mpremote installed successfully.');
              return true;
            } else {
              const msg = zh ? `安装完成但验证失败。请手动在此 Python 环境安装：${pythonPath}` : `Installation finished but verification failed. Please install manually for Python: ${pythonPath}`;
              const openTerm = zh ? '打开终端并复制命令' : 'Open terminal with command';
              const res = await vscode.window.showErrorMessage(msg, openTerm, 'OK');
              if (res === openTerm) {
                const term = vscode.window.createTerminal({ name: 'mpremote-install' });
                term.show(true);
                term.sendText(`${pythonPath} -m pip install --upgrade mpremote`, true);
              }
              return false;
            }
          } catch (e: any) {
            const errMsg = String(e?.message || e);
            const msg = zh ? `自动安装失败：${errMsg}\n请手动运行：${pythonPath} -m pip install --upgrade mpremote` : `Automatic install failed: ${errMsg}\nPlease run manually: ${pythonPath} -m pip install --upgrade mpremote`;
            const openTerm = zh ? '打开终端并复制命令' : 'Open terminal with command';
            const res = await vscode.window.showErrorMessage(msg, openTerm, 'OK');
            if (res === openTerm) {
              const term = vscode.window.createTerminal({ name: 'mpremote-install' });
              term.show(true);
              term.sendText(`${pythonPath} -m pip install --upgrade mpremote`, true);
            }
            return false;
          }
        });
      }

      if (choice === showPathLabel) {
        await vscode.window.showInformationMessage(zh ? `Python 路径：${pythonPath}` : `Python path: ${pythonPath}`);
        return false;
      }

      return false;
    } catch (e) {
      return false;
    }
  },

  /**
   * Check mpremote availability using python -m mpremote method
   */
  async checkMpremoteAvailability(): Promise<boolean> {
    try {
      // Delegate to MpRemoteManager
      return await MpRemoteManager.isModuleAvailable();
    } catch {
      return false;
    }
  },

  /**
   * Find mpremote executable in common installation locations
   */
  async findMpremoteExecutable(): Promise<string | null> {
    return MpRemoteManager.findExecutable();
  },

  /**
   * Show comprehensive mpremote installation guide
   */
  async showMpremoteInstallationGuide(): Promise<void> {
    const lang = vscode.env.language || '';
    const zh = lang.startsWith('zh');
    const msg = zh
      ? 'mpremote 是本扩展所需的命令行工具。请在所选 Python 环境中运行：`python -m pip install --upgrade mpremote`。或使用扩展的安装命令自动安装。'
      : 'mpremote is required by this extension. Run `python -m pip install --upgrade mpremote` in the desired Python environment, or use the extension install command to install it automatically.';
    await vscode.window.showInformationMessage(msg);
  },

  /**
   * Automatically install mpremote using detected Python environment
   */
  async installMpremoteAutomatically(silent: boolean = false): Promise<void> {
    const pythonPath = await MpRemoteManager.detectPythonPath();
    if (!pythonPath) {
      if (!silent) vscode.window.showErrorMessage('No Python detected to install mpremote into.');
      return;
    }
    try {
      await MpRemoteManager.install(pythonPath);
      const ok = await MpRemoteManager.isModuleAvailable(pythonPath);
      if (!ok && !silent) {
        vscode.window.showErrorMessage(`mpremote installation failed for Python: ${pythonPath}`);
      }
    } catch (e: any) {
      if (!silent) vscode.window.showErrorMessage(`mpremote installation failed: ${e?.message || String(e)}`);
    }
  },

  /**
   * Verify installation and handle PATH issues
   */
  async verifyAndHandleInstallation(pythonPath: string, silent: boolean = false): Promise<void> {
    // Delegate verification to manager
    const isAvailable = await MpRemoteManager.isModuleAvailable(pythonPath);
    if (!isAvailable) {
      if (!silent) {
        vscode.window.showErrorMessage('mpremote installation verification failed. The package may not be properly installed.', 'Get Help').then(choice => {
          if (choice === 'Get Help') this.showPathTroubleshootingGuide(pythonPath);
        });
      }
      throw new Error('Installation verification failed');
    }
  },

  /**
   * Show troubleshooting guide for PATH issues
   */
  async showPathTroubleshootingGuide(pythonPath: string): Promise<void> {
    const lang = vscode.env.language || '';
    const zh = lang.startsWith('zh');
    const msg = zh
      ? `请确保在此 Python 环境中安装 mpremote：\n${pythonPath} -m pip install --upgrade mpremote`
      : `Ensure mpremote is installed in this Python environment:\n${pythonPath} -m pip install --upgrade mpremote`;
    await vscode.window.showInformationMessage(msg);
  },

  /**
   * Show manual installation instructions
   */
  async showManualInstallationInstructions(): Promise<void> {
    const lang = vscode.env.language || '';
    const zh = lang.startsWith('zh');
    const msg = zh
      ? '手动安装 mpremote：在命令行运行 `python -m pip install --upgrade mpremote`，或在虚拟环境中激活后运行相同命令。'
      : 'To install mpremote manually run `python -m pip install --upgrade mpremote` in the desired Python environment.';
    await vscode.window.showInformationMessage(msg);
  },

  /**
   * Show information about mpremote
   */
  async showMpremoteInformation(): Promise<void> {
    const info = `**关于 mpremote**

mpremote 是与 MicroPython 开发板通信的命令行工具。请在您希望扩展使用的 Python 环境中安装 mpremote，或使用扩展的安装功能进行自动安装。

功能包括：
- 浏览开发板文件
- 上传/下载文件
- 访问 REPL 终端
- 直接运行脚本
- 管理开发板文件系统

如遇到问题，请确保已安装 Python 3.x 并在该环境中安装 mpremote。

详情访问：https://docs.micropython.org/en/latest/reference/mpremote.html`;

    await vscode.window.showInformationMessage(
      '关于 mpremote',
      { modal: true, detail: info },
      '访问文档'
    ).then(choice => {
      if (choice === '访问文档') {
        vscode.env.openExternal(vscode.Uri.parse('https://docs.micropython.org/en/latest/reference/mpremote.html'));
      }
    });
  },

  /**
   * Detect Python path for installation
   */
  async detectPythonPath(): Promise<string | null> {
    return MpRemoteManager.detectPythonPath();
  },

  /**
   * Check if pip is available for the given Python executable
   */
  async checkPipAvailability(pythonPath: string): Promise<boolean> {
    try {
      await execFileAsync(pythonPath, ['-m', 'pip', '--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Check mpremote version and compatibility
   */
  async checkMpremoteVersion(): Promise<{ version: string | null; compatible: boolean }> {
    const info = await MpRemoteManager.checkVersion();
    return { version: info.version, compatible: info.compatible };
  },

  /**
   * Check if mpremote version is compatible
   */
  isVersionCompatible(version: string): boolean {
    const parts = version.split('.').map(Number);
    if (parts.length < 2) return false;

    const major = parts[0];
    const minor = parts[1];

    // Require at least version 1.20
    return major > 1 || (major === 1 && minor >= 20);
  },

  /**
   * Show status bar item for mpremote status
   */
  createStatusBarItem(): vscode.StatusBarItem {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.hide();
    return statusBarItem;
  },

  /**
   * Update status bar item based on mpremote availability
   */
  async updateStatusBarItem(statusBarItem: vscode.StatusBarItem): Promise<void> {
    statusBarItem.hide();
  }
};