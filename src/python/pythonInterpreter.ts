import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MpRemoteManager } from '../board/MpRemoteManager';

const execFileAsync = promisify(execFile);

/**
 * Utility for getting the Python interpreter path configured in VS Code
 */
export class PythonInterpreterManager {
    private static cachedInterpreter: string | null = null;
    private static lastCacheTime = 0;
    private static readonly CACHE_DURATION = 30000; // 30 seconds
    private static lastMpremoteNotification = 0;
    private static readonly NOTIFICATION_COOLDOWN = 300000; // 5 minutes

    /**
     * Get the Python interpreter path configured in VS Code
     * @param workspaceFolder Optional workspace folder to get workspace-specific interpreter
     * @returns Promise<string> The Python interpreter path
     */
    static async getPythonPath(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        // Check cache first (with timeout)
        const now = Date.now();
        if (this.cachedInterpreter && (now - this.lastCacheTime) < this.CACHE_DURATION) {
            return this.cachedInterpreter;
        }

        let pythonPath: string | null = null;

        try {
            // Method 1: Try to get from Python extension API
            pythonPath = await this.getPythonFromExtensionAPI(workspaceFolder);
            if (pythonPath) {
                const validation = await this.validatePythonPath(pythonPath);
                if (validation.valid) {
                    this.cacheResult(pythonPath);
                    return pythonPath;
                } else if (validation.missingMpremote) {
                    // Show mpremote installation notification
                    this.showMpremoteInstallationNotification(pythonPath);
                }
            }
        } catch (error) {
            console.error('Failed to get Python from extension API:', error);
        }

        try {
            // Method 2: Try to get from VS Code configuration
            pythonPath = this.getPythonFromConfiguration(workspaceFolder);
            if (pythonPath) {
                const validation = await this.validatePythonPath(pythonPath);
                if (validation.valid) {
                    this.cacheResult(pythonPath);
                    return pythonPath;
                }
            }
        } catch (error) {
            console.error('Failed to get Python from configuration:', error);
        }

        // Method 3: Try fallback options
        const fallbacks = this.getFallbackPythonPaths();
        for (const fallback of fallbacks) {
            try {
                const validation = await this.validatePythonPath(fallback);
                if (validation.valid) {
                    this.cacheResult(fallback);
                    return fallback;
                }
            } catch (error) {
                // Continue to next fallback
            }
        }

        // If all else fails, return python3 as last resort
        const lastResort = 'python3';
        this.cacheResult(lastResort);
        return lastResort;
    }

    /**
     * Try to get Python interpreter from the Python extension API
     */
    private static async getPythonFromExtensionAPI(workspaceFolder?: vscode.WorkspaceFolder): Promise<string | null> {
        try {
            const pythonExtension = vscode.extensions.getExtension('ms-python.python');
            if (!pythonExtension) {
                return null;
            }

            // Ensure the extension is activated
            if (!pythonExtension.isActive) {
                await pythonExtension.activate();
            }

            const pythonApi = pythonExtension.exports;
            if (!pythonApi) {
                return null;
            }

            // Try different API methods based on Python extension version
            if (pythonApi.settings && pythonApi.settings.getExecutionDetails) {
                // Newer Python extension API
                const uri = workspaceFolder?.uri;
                const executionDetails = pythonApi.settings.getExecutionDetails(uri);
                if (executionDetails && executionDetails.execCommand && executionDetails.execCommand.length > 0) {
                    return executionDetails.execCommand[0];
                }
            }

            if (pythonApi.getActiveInterpreter) {
                // Older Python extension API
                const interpreter = await pythonApi.getActiveInterpreter(workspaceFolder?.uri);
                if (interpreter && interpreter.path) {
                    return interpreter.path;
                }
            }

            return null;
        } catch (error) {
            console.error('Error accessing Python extension API:', error);
            return null;
        }
    }

    /**
     * Get Python interpreter from VS Code configuration
     */
    private static getPythonFromConfiguration(workspaceFolder?: vscode.WorkspaceFolder): string | null {
        // First check MicroPython WorkBench specific override
        const mpyConfig = vscode.workspace.getConfiguration('microPythonWorkBench', workspaceFolder?.uri);
        const mpyPythonPath = mpyConfig.get<string>('pythonPath');
        if (mpyPythonPath && mpyPythonPath.trim()) {
            return mpyPythonPath.trim();
        }

        // Then check Python extension configuration
        const config = vscode.workspace.getConfiguration('python', workspaceFolder?.uri);
        
        // Try different configuration keys
        const configKeys = [
            'defaultInterpreterPath',
            'pythonPath', // Deprecated but still used
        ];

        for (const key of configKeys) {
            const pythonPath = config.get<string>(key);
            if (pythonPath && pythonPath.trim()) {
                return pythonPath.trim();
            }
        }

        return null;
    }

    /**
     * Get fallback Python paths to try
     */
    private static getFallbackPythonPaths(): string[] {
        const isWindows = process.platform === 'win32';
        
        if (isWindows) {
            return [
                'python',
                'python3',
                'py -3',
                'py',
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python39', 'python.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
            ];
        } else {
            return [
                'python3',
                'python',
                '/usr/bin/python3',
                '/usr/local/bin/python3',
                '/opt/homebrew/bin/python3',
                '/usr/bin/python',
                '/usr/local/bin/python',
            ];
        }
    }

    /**
     * Validate that a Python path is valid and has the required modules
     */
    private static async validatePythonPath(pythonPath: string): Promise<{ valid: boolean; missingMpremote: boolean; error?: string }> {
        try {
            // Test if Python executable exists and can run
            await execFileAsync(pythonPath, ['-c', 'import sys; print(sys.version)'], { timeout: 5000 });
            // Check whether mpremote module is available in this Python
            try {
                const available = await MpRemoteManager.isModuleAvailable(pythonPath);
                return { valid: true, missingMpremote: !available };
            } catch (e: any) {
                // If the module check itself failed, treat Python as valid but report mpremote missing
                return { valid: true, missingMpremote: true };
            }
        } catch (error: any) {
            const errorMessage = error.message || String(error);
            // Other Python-related errors
            return { valid: false, missingMpremote: false, error: errorMessage };
        }
    }

    /**
     * Show notification for missing mpremote
     */
    private static showMpremoteInstallationNotification(_pythonPath: string): void {
        // Prompt the user to install mpremote into the selected Python environment.
        // This helper is intentionally synchronous from the caller's perspective;
        // use it sparingly and rely on cooldown to avoid repeated prompts.
        const lang = vscode.env.language || '';
        const zh = lang.startsWith('zh');
        const msg = zh
            ? `未在所选 Python 环境中检测到 mpremote。是否安装到该环境？` 
            : `mpremote is not installed in the selected Python environment. Install into this environment?`;
        // Show a non-blocking prompt
        vscode.window.showInformationMessage(msg, zh ? '安装' : 'Install', zh ? '稍后' : 'Later').then(async choice => {
            if (!choice) return;
            if (choice === (zh ? '安装' : 'Install')) {
                try {
                    const pythonPath = await this.getPythonPath();
                    if (!pythonPath) {
                        vscode.window.showErrorMessage(zh ? '未找到 Python 可执行文件，无法安装 mpremote。' : 'No Python executable found to install mpremote.');
                        return;
                    }
                    await MpRemoteManager.install(pythonPath);
                    const ok = await MpRemoteManager.isModuleAvailable(pythonPath);
                    if (!ok) {
                        vscode.window.showErrorMessage(zh ? `安装完成但验证失败，请手动运行：${pythonPath} -m pip install --upgrade mpremote` : `Installation finished but verification failed. Please run: ${pythonPath} -m pip install --upgrade mpremote`);
                    } else {
                        vscode.window.showInformationMessage(zh ? 'mpremote 已成功安装。' : 'mpremote installed successfully.');
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(zh ? `安装失败：${e?.message || String(e)}。请手动运行：python -m pip install --upgrade mpremote` : `Install failed: ${e?.message || String(e)}. Run: python -m pip install --upgrade mpremote`);
                }
            }
        });
    }

    /**
     * Cache the result for performance
     */
    private static cacheResult(pythonPath: string): void {
        this.cachedInterpreter = pythonPath;
        this.lastCacheTime = Date.now();
    }

    /**
     * Clear the cache (useful when Python configuration changes)
     */
    static clearCache(): void {
        this.cachedInterpreter = null;
        this.lastCacheTime = 0;
    }

    /**
     * Check mpremote availability and show notification if missing
     * This can be called on extension activation to proactively notify users
     */
    static async checkMpremoteAvailability(): Promise<boolean> {
        try {
            const pythonPath = await this.getPythonPath();
            const validation = await this.validatePythonPath(pythonPath);
            if (!validation.valid) return false;
            // Check whether mpremote module is available in the detected Python
            const available = await MpRemoteManager.isModuleAvailable(pythonPath);
            if (!available) {
                // Throttle notifications
                const now = Date.now();
                if ((now - this.lastMpremoteNotification) > this.NOTIFICATION_COOLDOWN) {
                    this.lastMpremoteNotification = now;
                    this.showMpremoteInstallationNotification(pythonPath);
                }
            }
            return available;
        } catch {
            return false;
        }
    }

    /**
     * Get Python command for terminal usage (handles special cases like 'py -3')
     */
    static async getPythonCommandForTerminal(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        const pythonPath = await this.getPythonPath(workspaceFolder);
        
        // If it's a complex command like 'py -3', return as-is
        if (pythonPath.includes(' ')) {
            return pythonPath;
        }
        
        // For simple paths, quote them if they contain spaces
        if (pythonPath.includes(' ') && !pythonPath.startsWith('"') && !pythonPath.startsWith("'")) {
            return `"${pythonPath}"`;
        }
        
        return pythonPath;
    }
}

/**
 * Convenience function to get Python path
 */
export async function getPythonPath(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
    return PythonInterpreterManager.getPythonPath(workspaceFolder);
}

/**
 * Convenience function to get Python command for terminal
 */
export async function getPythonCommandForTerminal(workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
    return PythonInterpreterManager.getPythonCommandForTerminal(workspaceFolder);
}

/**
 * Clear the Python interpreter cache
 */
export function clearPythonCache(): void {
    PythonInterpreterManager.clearCache();
}

/**
 * Check mpremote availability and show notification if missing
 */
export async function checkMpremoteAvailability(): Promise<boolean> {
    return PythonInterpreterManager.checkMpremoteAvailability();
}