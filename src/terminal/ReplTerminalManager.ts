/**
 * REPL Terminal Manager
 *
 * 管理 MicroPython REPL 终端的生命周期。
 * 使用 Pseudoterminal API 提供客户端编辑功能。
 */

import * as vscode from "vscode";
import { MpyPseudoterminal } from "./MpyPseudoterminal";
import { HistoryManager } from "./HistoryManager";
import {
    getSessionManager,
    SessionManager,
    DeviceSession,
} from "../session";
import { getDeviceAdapter } from "../board/deviceAdapter";
import { toDevicePath } from "../utils/pathMapping";
import { Localization } from "../core/localization";

/**
 * 会话快照，用于暂停/恢复
 */
export interface SessionSnapshot {
    /** 是否有活动的 REPL */
    wasReplOpen: boolean;
    /** REPL 所在的端口 */
    port: string | null;
    /** 用户是否主动关闭了 REPL */
    userClosed: boolean;
}

/**
 * REPL 终端管理器
 *
 * 单例模式，提供：
 * - REPL 终端的创建和管理
 * - 与 DeviceSession 的集成
 * - 暂停/恢复用于自动同步
 * - 运行文件功能
 */
export class ReplTerminalManager {
    private static instance: ReplTerminalManager | null = null;

    private context: vscode.ExtensionContext | null = null;
    private terminal: vscode.Terminal | null = null;
    private pseudoterminal: MpyPseudoterminal | null = null;
    private session: DeviceSession | null = null;
    private historyManager: HistoryManager = new HistoryManager();
    private currentPort: string | null = null;
    private userClosedRepl = false;

    private constructor() {}

    /**
     * 获取单例实例
     */
    public static getInstance(): ReplTerminalManager {
        if (!ReplTerminalManager.instance) {
            ReplTerminalManager.instance = new ReplTerminalManager();
        }
        return ReplTerminalManager.instance;
    }

    /**
     * 初始化管理器
     */
    public initialize(context: vscode.ExtensionContext): void {
        this.context = context;

        // 监听终端关闭事件
        context.subscriptions.push(
            vscode.window.onDidCloseTerminal((term) => {
                if (term === this.terminal) {
                    this.handleTerminalClosed();
                }
            })
        );
    }

    /**
     * 打开或获取 REPL 终端
     */
    public async open(port?: string): Promise<vscode.Terminal> {
        // 确定端口
        const targetPort = port ?? this.getConfiguredPort();
        if (!targetPort) {
            throw new Error("No port configured. Please select a device first.");
        }

        // 如果已有终端且端口相同，直接返回
        if (this.terminal && this.currentPort === targetPort) {
            this.terminal.show();
            return this.terminal;
        }

        // 关闭现有终端
        await this.close();

        // 创建会话
        const sessionManager = getSessionManager();
        this.session = await sessionManager.createSession({
            port: targetPort,
            baudrate: this.getConfiguredBaudrate(),
        });

        // 连接设备
        await this.session.connect();

        // 创建 Pseudoterminal
        this.pseudoterminal = new MpyPseudoterminal({
            session: this.session,
            historyManager: this.historyManager,
        });

        // 创建终端
        this.terminal = vscode.window.createTerminal({
            name: "ESP32 REPL",
            pty: this.pseudoterminal,
        });

        this.currentPort = targetPort;
        this.userClosedRepl = false;

        this.terminal.show();
        return this.terminal;
    }

    /**
     * 关闭 REPL 终端
     */
    public async close(force = false): Promise<void> {
        if (!force && !this.terminal) {
            return;
        }

        if (this.terminal) {
            this.terminal.dispose();
            this.terminal = null;
        }

        if (this.session) {
            try {
                await this.session.disconnect();
            } catch {
                // 忽略断开连接错误
            }
            this.session.dispose();
            this.session = null;
        }

        this.pseudoterminal = null;
        this.currentPort = null;
    }

    /**
     * 检查 REPL 是否打开
     */
    public isOpen(): boolean {
        return this.terminal !== null && this.session?.isConnected === true;
    }

    /**
     * 获取当前终端
     */
    public getTerminal(): vscode.Terminal | null {
        return this.terminal;
    }

    /**
     * 获取当前端口
     */
    public getPort(): string | null {
        return this.currentPort;
    }

    /**
     * 发送中断信号 (Ctrl+C)
     */
    public async sendInterrupt(): Promise<void> {
        if (this.session?.isConnected) {
            await this.session.interrupt();
        }
    }

    /**
     * 软复位设备
     */
    public async softReset(): Promise<void> {
        if (this.session?.isConnected) {
            await this.session.softReboot();
        }
    }

    /**
     * 停止当前执行
     */
    public async stop(): Promise<void> {
        await this.sendInterrupt();
    }

    /**
     * 运行活动文件
     */
    public async runActiveFile(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            Localization.showWarning("messages.noActiveFile");
            return;
        }

        const doc = editor.document;
        if (doc.languageId !== "python") {
            Localization.showWarning("messages.notPythonFile");
            return;
        }

        // 保存文件
        if (doc.isDirty) {
            await doc.save();
        }

        // 确保有连接
        const port = this.getConfiguredPort();
        if (!port) {
            Localization.showError("messages.noPortSelected");
            return;
        }

        // 获取设备适配器
        const adapter = getDeviceAdapter();

        // 确保已连接
        if (!adapter.isConnected()) {
            await adapter.connect(port);
        }

        // 获取工作区路径
        const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
        if (!ws) {
            Localization.showError("messages.noWorkspace");
            return;
        }

        // 计算设备路径
        const rootPath = vscode.workspace
            .getConfiguration()
            .get<string>("microPythonWorkBench.rootPath", "/");
        const relativePath = vscode.workspace
            .asRelativePath(doc.uri.fsPath)
            .replace(/\\/g, "/");
        const devicePath = toDevicePath(relativePath, rootPath);

        try {
            // 上传文件
            await adapter.cpToDevice(doc.uri.fsPath, devicePath);

            // 在 REPL 中运行
            const code = `exec(open('${devicePath}').read())`;
            
            // 如果 REPL 打开，使用 REPL 执行
            if (this.session?.isConnected) {
                const result = await this.session.execute(code);
                if (!result.success && result.stderr) {
                    Localization.showError("messages.runError", result.stderr);
                }
            } else {
                // 否则使用 DeviceAdapter 执行
                const result = await adapter.execute(code);
                if (!result.success && result.stderr) {
                    Localization.showError("messages.runError", result.stderr);
                }
            }

            Localization.showInfo("messages.fileExecuted", relativePath);
        } catch (error: any) {
            Localization.showError(
                "messages.runError",
                error?.message || String(error)
            );
        }
    }

    /**
     * 暂停 REPL 会话（用于自动同步）
     */
    public suspend(): SessionSnapshot {
        const snapshot: SessionSnapshot = {
            wasReplOpen: this.isOpen(),
            port: this.currentPort,
            userClosed: this.userClosedRepl,
        };

        // 暂时断开连接，但不销毁终端
        if (this.session?.isConnected) {
            // 发送中断确保设备空闲
            this.session.interrupt().catch(() => {});
        }

        return snapshot;
    }

    /**
     * 恢复 REPL 会话
     */
    public async restore(
        snapshot: SessionSnapshot,
        options?: {
            resumeReplCommand?: string;
            replBehavior?: "runChanged" | "executeBootMain" | "openReplEmpty" | "none";
        }
    ): Promise<void> {
        const behavior = options?.replBehavior ?? "none";

        // 如果用户主动关闭了 REPL，不恢复
        if (snapshot.userClosed) {
            return;
        }

        // 根据行为决定是否恢复
        if (behavior === "none") {
            return;
        }

        // 如果之前没有打开 REPL，不恢复
        if (!snapshot.wasReplOpen) {
            return;
        }

        // 恢复 REPL
        if (snapshot.port) {
            try {
                await this.open(snapshot.port);

                // 执行恢复命令
                if (behavior === "runChanged" && options?.resumeReplCommand) {
                    await this.session?.execute(options.resumeReplCommand);
                } else if (behavior === "executeBootMain") {
                    await this.softReset();
                }
            } catch (error) {
                console.error("[ReplTerminalManager] Failed to restore:", error);
            }
        }
    }

    /**
     * 处理终端关闭
     */
    private handleTerminalClosed(): void {
        this.userClosedRepl = true;
        this.terminal = null;
        this.pseudoterminal = null;

        if (this.session) {
            this.session.disconnect().catch(() => {});
            this.session.dispose();
            this.session = null;
        }

        this.currentPort = null;
    }

    /**
     * 获取配置的端口
     */
    private getConfiguredPort(): string | null {
        const connect = vscode.workspace
            .getConfiguration()
            .get<string>("microPythonWorkBench.connect", "auto");

        if (!connect || connect === "auto") {
            return null;
        }

        // 处理 serial://COM3 格式
        if (connect.startsWith("serial://")) {
            return connect.slice(9);
        }

        return connect;
    }

    /**
     * 获取配置的波特率
     */
    private getConfiguredBaudrate(): number {
        return vscode.workspace
            .getConfiguration()
            .get<number>("microPythonWorkBench.baudrate", 115200);
    }
}

// 导出便捷函数
export const replTerminalManager = ReplTerminalManager.getInstance();

/**
 * 获取 REPL 终端
 */
export async function getReplTerminal(
    context?: vscode.ExtensionContext
): Promise<vscode.Terminal> {
    if (context) {
        replTerminalManager.initialize(context);
    }
    return replTerminalManager.open();
}

/**
 * 打开 REPL 终端
 */
export async function openReplTerminal(
    port?: string
): Promise<vscode.Terminal> {
    return replTerminalManager.open(port);
}

/**
 * 关闭 REPL 终端
 */
export async function closeReplTerminal(force = false): Promise<void> {
    await replTerminalManager.close(force);
}

/**
 * 检查 REPL 是否打开
 */
export function isReplOpen(): boolean {
    return replTerminalManager.isOpen();
}

/**
 * 发送 Ctrl+C
 */
export async function serialSendCtrlC(): Promise<void> {
    await replTerminalManager.sendInterrupt();
}

/**
 * 停止执行
 */
export async function stop(): Promise<void> {
    await replTerminalManager.stop();
}

/**
 * 软复位
 */
export async function softReset(): Promise<void> {
    await replTerminalManager.softReset();
}

/**
 * 运行活动文件
 */
export async function runActiveFile(): Promise<void> {
    await replTerminalManager.runActiveFile();
}

/**
 * 暂停会话用于自动同步
 */
export function suspendSerialSessionsForAutoSync(): SessionSnapshot {
    return replTerminalManager.suspend();
}

/**
 * 恢复会话
 */
export async function restoreSerialSessionsFromSnapshot(
    snapshot: SessionSnapshot,
    options?: {
        resumeReplCommand?: string;
        replBehavior?: "runChanged" | "executeBootMain" | "openReplEmpty" | "none";
    }
): Promise<void> {
    await replTerminalManager.restore(snapshot, options);
}

/**
 * 断开 REPL 终端
 */
export async function disconnectReplTerminal(): Promise<void> {
    await replTerminalManager.close();
}
