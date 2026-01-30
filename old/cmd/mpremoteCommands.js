"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mpremoteCommands = void 0;
const vscode = require("vscode");
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const MpRemoteManager_1 = require("../board/MpRemoteManager");
const execAsync = (0, node_util_1.promisify)(node_child_process_1.exec);
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
/**
 * Mpremote installation and management commands
 */
exports.mpremoteCommands = {
    /**
     * Check if mpremote is available and show installation guide if not
     */
    async checkAndInstallMpremote(silent = false) {
        // mpremote 已内置，无需安装或检查外部依赖。
        return true;
    },
    /**
     * Check mpremote availability using python -m mpremote method
     */
    async checkMpremoteAvailability() {
        try {
            // Delegate to MpRemoteManager
            return await MpRemoteManager_1.MpRemoteManager.isModuleAvailable();
        }
        catch {
            return false;
        }
    },
    /**
     * Find mpremote executable in common installation locations
     */
    async findMpremoteExecutable() {
        return MpRemoteManager_1.MpRemoteManager.findExecutable();
    },
    /**
     * Show comprehensive mpremote installation guide
     */
    async showMpremoteInstallationGuide() {
        await vscode.window.showInformationMessage('mpremote 已内置，无需安装。');
    },
    /**
     * Automatically install mpremote using detected Python environment
     */
    async installMpremoteAutomatically(silent = false) {
        if (!silent)
            await vscode.window.showInformationMessage('mpremote 已内置，无需安装。');
    },
    /**
     * Verify installation and handle PATH issues
     */
    async verifyAndHandleInstallation(pythonPath, silent = false) {
        // Delegate verification to manager
        const isAvailable = await MpRemoteManager_1.MpRemoteManager.isModuleAvailable(pythonPath);
        if (!isAvailable) {
            if (!silent) {
                vscode.window.showErrorMessage('mpremote installation verification failed. The package may not be properly installed.', 'Get Help').then(choice => {
                    if (choice === 'Get Help')
                        this.showPathTroubleshootingGuide(pythonPath);
                });
            }
            throw new Error('Installation verification failed');
        }
    },
    /**
     * Show troubleshooting guide for PATH issues
     */
    async showPathTroubleshootingGuide(pythonPath) {
        await vscode.window.showInformationMessage('无需配置 PATH：扩展已内置 mpremote。');
    },
    /**
     * Show manual installation instructions
     */
    async showManualInstallationInstructions() {
        await vscode.window.showInformationMessage('mpremote 已内置，无需额外安装。');
    },
    /**
     * Show information about mpremote
     */
    async showMpremoteInformation() {
        const info = `**关于 mpremote**

mpremote 是与 MicroPython 开发板通信的命令行工具。本扩展已内置 mpremote，无需额外安装。

功能包括：
- 浏览开发板文件
- 上传/下载文件
- 访问 REPL 终端
- 直接运行脚本
- 管理开发板文件系统

如遇到问题，请确保已安装 Python 3.x。

详情访问：https://docs.micropython.org/en/latest/reference/mpremote.html`;
        await vscode.window.showInformationMessage('关于 mpremote', { modal: true, detail: info }, '访问文档').then(choice => {
            if (choice === '访问文档') {
                vscode.env.openExternal(vscode.Uri.parse('https://docs.micropython.org/en/latest/reference/mpremote.html'));
            }
        });
    },
    /**
     * Detect Python path for installation
     */
    async detectPythonPath() {
        return MpRemoteManager_1.MpRemoteManager.detectPythonPath();
    },
    /**
     * Check if pip is available for the given Python executable
     */
    async checkPipAvailability(pythonPath) {
        try {
            await execFileAsync(pythonPath, ['-m', 'pip', '--version'], { timeout: 5000 });
            return true;
        }
        catch {
            return false;
        }
    },
    /**
     * Check mpremote version and compatibility
     */
    async checkMpremoteVersion() {
        const info = await MpRemoteManager_1.MpRemoteManager.checkVersion();
        return { version: info.version, compatible: info.compatible };
    },
    /**
     * Check if mpremote version is compatible
     */
    isVersionCompatible(version) {
        const parts = version.split('.').map(Number);
        if (parts.length < 2)
            return false;
        const major = parts[0];
        const minor = parts[1];
        // Require at least version 1.20
        return major > 1 || (major === 1 && minor >= 20);
    },
    /**
     * Show status bar item for mpremote status
     */
    createStatusBarItem() {
        const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusBarItem.hide();
        return statusBarItem;
    },
    /**
     * Update status bar item based on mpremote availability
     */
    async updateStatusBarItem(statusBarItem) {
        statusBarItem.hide();
    }
};
//# sourceMappingURL=mpremoteCommands.js.map