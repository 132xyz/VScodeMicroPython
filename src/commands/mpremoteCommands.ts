import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MpRemoteManager } from "../board/MpRemoteManager";

const execFileAsync = promisify(execFile);

/**
 * Python dependency management commands for the custom MicroPython transport.
 */
export const mpremoteCommands = {
  /**
   * Check if pyserial is available and show installation guide if not.
   */
  async checkAndInstallMpremote(silent: boolean = false): Promise<boolean> {
    try {
      const lang = vscode.env.language || '';
      const zh = lang.startsWith('zh');
      const pythonPath = await MpRemoteManager.detectPythonPath();
      if (!pythonPath) {
        if (!silent) vscode.window.showErrorMessage(zh ? '未检测到 Python 解释器，无法安装 pyserial。' : 'No Python interpreter detected; cannot install pyserial.');
        return false;
      }

      const available = await MpRemoteManager.isPythonModuleAvailable('serial', pythonPath);
      if (available) return true;

      if (silent) return false;

      const installLabel = zh ? '安装到此 Python' : 'Install to this Python';
      const showPathLabel = zh ? '显示 Python 路径' : 'Show Python Path';
      const cancelLabel = zh ? '取消' : 'Cancel';

      const choice = await vscode.window.showInformationMessage(
        zh ? `pyserial 未安装在检测到的 Python：${pythonPath}` : `pyserial is not installed in detected Python: ${pythonPath}`,
        installLabel,
        showPathLabel,
        cancelLabel
      );

      if (choice === installLabel) {
        return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: zh ? '正在安装 pyserial...' : 'Installing pyserial...' }, async () => {
          try {
            await MpRemoteManager.installPackages(['pyserial'], pythonPath);
            const ok = await MpRemoteManager.isPythonModuleAvailable('serial', pythonPath);
            if (ok) {
              vscode.window.showInformationMessage(zh ? 'pyserial 已成功安装。' : 'pyserial installed successfully.');
              return true;
            } else {
              const msg = zh ? `安装完成但验证失败。请手动在此 Python 环境安装：${pythonPath}` : `Installation finished but verification failed. Please install manually for Python: ${pythonPath}`;
              const openTerm = zh ? '打开终端并复制命令' : 'Open terminal with command';
              const res = await vscode.window.showErrorMessage(msg, openTerm, 'OK');
              if (res === openTerm) {
                const term = vscode.window.createTerminal({
                  name: 'mpremote-install',
                  shellPath: process.platform === 'win32' ? 'powershell.exe' : undefined
                });
                term.show(true);
                const pipCmd = process.platform === 'win32' 
                  ? `& "${pythonPath}" -m pip install --upgrade pyserial`
                  : `${pythonPath} -m pip install --upgrade pyserial`;
                term.sendText(pipCmd, true);
              }
              return false;
            }
          } catch (e: any) {
            const errMsg = String(e?.message || e);
            const msg = zh ? `自动安装失败：${errMsg}\n请手动运行：${pythonPath} -m pip install --upgrade pyserial` : `Automatic install failed: ${errMsg}\nPlease run manually: ${pythonPath} -m pip install --upgrade pyserial`;
            const openTerm = zh ? '打开终端并复制命令' : 'Open terminal with command';
            const res = await vscode.window.showErrorMessage(msg, openTerm, 'OK');
            if (res === openTerm) {
              const term = vscode.window.createTerminal({
                name: 'mpremote-install',
                shellPath: process.platform === 'win32' ? 'powershell.exe' : undefined
              });
              term.show(true);
              const pipCmd = process.platform === 'win32' 
                ? `& "${pythonPath}" -m pip install --upgrade pyserial`
                : `${pythonPath} -m pip install --upgrade pyserial`;
              term.sendText(pipCmd, true);
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
   * Check pyserial availability.
   */
  async checkMpremoteAvailability(): Promise<boolean> {
    try {
      const pythonPath = await MpRemoteManager.detectPythonPath();
      if (!pythonPath) return false;
      return await MpRemoteManager.isPythonModuleAvailable('serial', pythonPath);
    } catch {
      return false;
    }
  },

  /**
   * External mpremote executable lookup is no longer used.
   */
  async findMpremoteExecutable(): Promise<string | null> {
    return null;
  },

  /**
   * Show pyserial installation guide.
   */
  async showMpremoteInstallationGuide(): Promise<void> {
    const lang = vscode.env.language || '';
    const zh = lang.startsWith('zh');
    const msg = zh
      ? '自定义 MicroPython 传输需要 pyserial。请在所选 Python 环境中运行：`python -m pip install --upgrade pyserial`。或使用扩展的安装命令自动安装。'
      : 'The custom MicroPython transport requires pyserial. Run `python -m pip install --upgrade pyserial` in the desired Python environment, or use the extension install command.';
    await vscode.window.showInformationMessage(msg);
  },

  /**
   * Automatically install pyserial using detected Python environment.
   */
  async installMpremoteAutomatically(silent: boolean = false): Promise<void> {
    const pythonPath = await MpRemoteManager.detectPythonPath();
    if (!pythonPath) {
      if (!silent) vscode.window.showErrorMessage('No Python detected to install pyserial into.');
      return;
    }
    try {
      await MpRemoteManager.installPackages(['pyserial'], pythonPath);
      const ok = await MpRemoteManager.isPythonModuleAvailable('serial', pythonPath);
      if (!ok && !silent) {
        vscode.window.showErrorMessage(`pyserial installation failed for Python: ${pythonPath}`);
      }
    } catch (e: any) {
      if (!silent) vscode.window.showErrorMessage(`pyserial installation failed: ${e?.message || String(e)}`);
    }
  },

  /**
   * Verify installation and handle PATH issues
   */
  async verifyAndHandleInstallation(pythonPath: string, silent: boolean = false): Promise<void> {
    // Delegate verification to manager
    const isAvailable = await MpRemoteManager.isPythonModuleAvailable('serial', pythonPath);
    if (!isAvailable) {
      if (!silent) {
        vscode.window.showErrorMessage('pyserial installation verification failed. The package may not be properly installed.', 'Get Help').then(choice => {
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
      ? `请确保在此 Python 环境中安装 pyserial：\n${pythonPath} -m pip install --upgrade pyserial`
      : `Ensure pyserial is installed in this Python environment:\n${pythonPath} -m pip install --upgrade pyserial`;
    await vscode.window.showInformationMessage(msg);
  },

  /**
   * Show manual installation instructions
   */
  async showManualInstallationInstructions(): Promise<void> {
    const lang = vscode.env.language || '';
    const zh = lang.startsWith('zh');
    const msg = zh
      ? '手动安装 pyserial：在命令行运行 `python -m pip install --upgrade pyserial`，或在虚拟环境中激活后运行相同命令。'
      : 'To install pyserial manually run `python -m pip install --upgrade pyserial` in the desired Python environment.';
    await vscode.window.showInformationMessage(msg);
  },

  /**
   * Show information about the custom transport.
   */
  async showMpremoteInformation(): Promise<void> {
    const info = `**关于自定义 MicroPython 传输**

扩展现在通过内置 mpyrepl helper 与 MicroPython 开发板通信。主功能不再依赖 mpremote, 但所选 Python 环境需要 pyserial 用于串口访问。

功能包括：
- 浏览开发板文件
- 上传/下载文件
- 访问 REPL 终端
- 直接运行脚本
- 管理开发板文件系统

如遇到问题，请确保已安装 Python 3.x 并在该环境中安装 pyserial。`;

    await vscode.window.showInformationMessage(
      '关于自定义 MicroPython 传输',
      { modal: true, detail: info },
    );
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
    return { version: null, compatible: true };
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
