/**
 * Python Detector - Python 检测器
 *
 * 从 MpRemoteManager 提取的 Python 路径检测逻辑。
 * 提供独立的 Python 环境检测功能，供多个模块复用。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

/**
 * Python 检测结果
 */
export interface PythonDetectionResult {
    /** Python 可执行文件路径 */
    pythonPath: string | null;
    /** Python 版本 */
    version: string | null;
    /** 检测来源 */
    source:
        | "vscode-extension"
        | "config"
        | "system"
        | "not-found";
}

/**
 * Python 检测器类
 */
export class PythonDetector {
    private static cachedPath: string | null = null;
    private static cacheTime = 0;
    private static readonly CACHE_TTL = 60000; // 1 分钟缓存

    /**
     * 检测 Python 路径
     *
     * 按以下优先级检测：
     * 1. VS Code Python 扩展
     * 2. 配置文件
     * 3. 系统 PATH
     */
    public static async detectPythonPath(): Promise<string | null> {
        // 检查缓存
        if (
            this.cachedPath &&
            Date.now() - this.cacheTime < this.CACHE_TTL
        ) {
            return this.cachedPath;
        }

        let pythonPath: string | null = null;

        // 1. 尝试 VS Code Python 扩展
        pythonPath = await this.tryVSCodePythonExtension();
        if (pythonPath) {
            this.updateCache(pythonPath);
            return pythonPath;
        }

        // 2. 尝试配置
        pythonPath = this.tryConfig();
        if (pythonPath) {
            this.updateCache(pythonPath);
            return pythonPath;
        }

        // 3. 尝试系统 PATH
        pythonPath = await this.trySystemPath();
        if (pythonPath) {
            this.updateCache(pythonPath);
            return pythonPath;
        }

        return null;
    }

    /**
     * 获取详细的检测结果
     */
    public static async detect(): Promise<PythonDetectionResult> {
        // 1. 尝试 VS Code Python 扩展
        const vscodePath = await this.tryVSCodePythonExtension();
        if (vscodePath) {
            const version = await this.getPythonVersion(vscodePath);
            return {
                pythonPath: vscodePath,
                version,
                source: "vscode-extension",
            };
        }

        // 2. 尝试配置
        const configPath = this.tryConfig();
        if (configPath) {
            const version = await this.getPythonVersion(configPath);
            return {
                pythonPath: configPath,
                version,
                source: "config",
            };
        }

        // 3. 尝试系统 PATH
        const systemPath = await this.trySystemPath();
        if (systemPath) {
            const version = await this.getPythonVersion(systemPath);
            return {
                pythonPath: systemPath,
                version,
                source: "system",
            };
        }

        return {
            pythonPath: null,
            version: null,
            source: "not-found",
        };
    }

    /**
     * 验证 Python 路径是否有效
     */
    public static async validatePythonPath(
        pythonPath: string
    ): Promise<boolean> {
        try {
            await execFileAsync(pythonPath, ["--version"], {
                timeout: 5000,
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 获取 Python 版本
     */
    public static async getPythonVersion(
        pythonPath: string
    ): Promise<string | null> {
        try {
            const { stdout } = await execFileAsync(
                pythonPath,
                ["--version"],
                { timeout: 5000 }
            );
            const match = stdout.match(/Python\s+(\d+\.\d+\.\d+)/);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }

    /**
     * 获取内部 Python 模块根目录
     */
    public static getInternalPythonRoot(): string | null {
        try {
            // 尝试从扩展路径获取
            const ext =
                vscode.extensions.getExtension("WebForks.mpy") ||
                vscode.extensions.all.find((e) =>
                    e.id.toLowerCase().endsWith(".mpy")
                );

            if (ext) {
                const candidate = path.join(
                    ext.extensionPath,
                    "src",
                    "python"
                );
                if (this.verifyPythonRoot(candidate)) {
                    return candidate;
                }
            }

            // 尝试从工作区获取 (开发模式)
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (ws) {
                const candidate = path.join(
                    ws,
                    "VScodeMicroPython",
                    "src",
                    "python"
                );
                if (this.verifyPythonRoot(candidate)) {
                    return candidate;
                }
            }
        } catch (e) {
            console.error(
                "[PythonDetector] Failed to get internal Python root:",
                e
            );
        }

        return null;
    }

    /**
     * 清除缓存
     */
    public static clearCache(): void {
        this.cachedPath = null;
        this.cacheTime = 0;
    }

    // ========================================================================
    // 私有方法
    // ========================================================================

    private static async tryVSCodePythonExtension(): Promise<string | null> {
        try {
            const pythonExtension = vscode.extensions.getExtension(
                "ms-python.python"
            );

            if (pythonExtension && pythonExtension.isActive) {
                const pythonApi = (pythonExtension as any).exports;

                if (
                    pythonApi?.settings?.getExecutionDetails
                ) {
                    const workspaceFolder =
                        vscode.workspace.workspaceFolders?.[0];
                    const executionDetails =
                        pythonApi.settings.getExecutionDetails(
                            workspaceFolder?.uri
                        );

                    if (
                        executionDetails?.execCommand?.length > 0
                    ) {
                        return executionDetails.execCommand[0];
                    }
                }
            }
        } catch (e) {
            // 忽略错误
        }

        return null;
    }

    private static tryConfig(): string | null {
        try {
            const config = vscode.workspace.getConfiguration("python");
            const configuredPath =
                config.get<string>("defaultInterpreterPath") ||
                config.get<string>("pythonPath");

            if (configuredPath) {
                return configuredPath;
            }
        } catch {
            // 忽略错误
        }

        return null;
    }

    private static async trySystemPath(): Promise<string | null> {
        const candidates =
            process.platform === "win32"
                ? ["python", "python3", "py", "py -3"]
                : ["python3", "python"];

        for (const cmd of candidates) {
            try {
                await execFileAsync(cmd, ["--version"], {
                    timeout: 5000,
                });
                return cmd;
            } catch {
                // 继续尝试下一个
            }
        }

        return null;
    }

    private static verifyPythonRoot(candidate: string): boolean {
        try {
            // 检查 mpy_backend 是否存在
            const backendPath = path.join(
                candidate,
                "mpy_backend",
                "__main__.py"
            );
            return fs.existsSync(backendPath);
        } catch {
            return false;
        }
    }

    private static updateCache(pythonPath: string): void {
        this.cachedPath = pythonPath;
        this.cacheTime = Date.now();
    }
}

/**
 * 快捷函数：检测 Python 路径
 */
export async function detectPythonPath(): Promise<string | null> {
    return PythonDetector.detectPythonPath();
}

/**
 * 快捷函数：获取内部 Python 模块根目录
 */
export function getInternalPythonRoot(): string | null {
    return PythonDetector.getInternalPythonRoot();
}

/**
 * 检查 mpremote 可用性（兼容旧代码）
 * 新架构不再需要外部 mpremote，始终返回 true
 * @deprecated 使用 isBackendAvailable 代替
 */
export async function checkMpremoteAvailability(): Promise<boolean> {
    return true;
}

/**
 * 检查后端是否可用
 */
export async function isBackendAvailable(): Promise<boolean> {
    const pythonPath = await PythonDetector.detectPythonPath();
    if (!pythonPath) {
        return false;
    }

    try {
        await execFileAsync(
            pythonPath,
            ["-c", "from mpy_backend import __main__"],
            { timeout: 5000 }
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * 检查 Python 是否可用
 */
export async function isPythonAvailable(): Promise<boolean> {
    const result = await PythonDetector.detect();
    return result.pythonPath !== null;
}
