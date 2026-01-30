/**
 * Sync Session Manager - 同步会话管理器
 *
 * 管理自动同步期间的会话挂起和恢复。
 * 替代旧的 suspendSerialSessionsForAutoSync 和 restoreSerialSessionsFromSnapshot。
 */

import * as vscode from "vscode";
import { getSessionManager, SessionManager } from "../session";

/**
 * 会话快照
 */
export interface SessionSnapshot {
    /** 是否有活动的 REPL 终端 */
    replWasOpen: boolean;
    /** 是否有活动的运行终端 */
    runWasOpen: boolean;
    /** 最后运行的命令 */
    lastRunCommand?: {
        device: string;
        filePath: string;
        cmd: string;
    };
    /** 活动会话的端口列表 */
    activePorts: string[];
    /** 时间戳 */
    timestamp: number;
}

/**
 * 恢复行为
 */
export type RestoreBehavior =
    | "runChanged"
    | "executeBootMain"
    | "openReplEmpty"
    | "none";

/**
 * 调试日志
 */
const debugLog = (...args: any[]) => {
    try {
        const enabled = vscode.workspace
            .getConfiguration()
            .get<boolean>("microPythonWorkBench.debug", false);
        if (enabled) console.debug("[SyncSessionManager]", ...args);
    } catch {}
};

/**
 * 同步会话管理器类
 */
export class SyncSessionManager {
    private static instance: SyncSessionManager | null = null;

    private sessionManager: SessionManager | null = null;
    private currentSnapshot: SessionSnapshot | null = null;
    private suspended = false;

    private constructor() {}

    /**
     * 获取单例实例
     */
    public static getInstance(): SyncSessionManager {
        if (!SyncSessionManager.instance) {
            SyncSessionManager.instance = new SyncSessionManager();
        }
        return SyncSessionManager.instance;
    }

    /**
     * 初始化
     */
    public initialize(sessionManager: SessionManager): void {
        this.sessionManager = sessionManager;
    }

    /**
     * 挂起所有串口会话以进行自动同步
     */
    public async suspend(): Promise<SessionSnapshot> {
        if (this.suspended) {
            debugLog("Already suspended, returning existing snapshot");
            return this.currentSnapshot!;
        }

        debugLog("Suspending serial sessions for auto-sync");

        const snapshot: SessionSnapshot = {
            replWasOpen: false,
            runWasOpen: false,
            activePorts: [],
            timestamp: Date.now(),
        };

        if (!this.sessionManager) {
            debugLog("SessionManager not initialized");
            this.currentSnapshot = snapshot;
            this.suspended = true;
            return snapshot;
        }

        // 获取所有活动会话
        const sessions = this.sessionManager.getAllSessions();
        for (const session of sessions) {
            if (session.isConnected) {
                snapshot.activePorts.push(session.port);
                snapshot.replWasOpen = true;

                // 断开连接
                try {
                    await session.disconnect();
                    debugLog(`Disconnected session on port ${session.port}`);
                } catch (error) {
                    debugLog(
                        `Failed to disconnect session on port ${session.port}:`,
                        error
                    );
                }
            }
        }

        // 等待端口释放
        if (snapshot.activePorts.length > 0) {
            await this.delay(300);
        }

        this.currentSnapshot = snapshot;
        this.suspended = true;

        debugLog("Suspend complete, snapshot:", snapshot);
        return snapshot;
    }

    /**
     * 从快照恢复会话
     */
    public async restore(
        snapshot?: SessionSnapshot,
        options: {
            behavior?: RestoreBehavior;
            resumeCommand?: string;
        } = {}
    ): Promise<void> {
        const snap = snapshot || this.currentSnapshot;
        if (!snap) {
            debugLog("No snapshot to restore from");
            return;
        }

        const { behavior = "openReplEmpty" } = options;

        if (behavior === "none") {
            debugLog("Restore behavior is 'none', skipping restore");
            this.suspended = false;
            this.currentSnapshot = null;
            return;
        }

        debugLog("Restoring sessions, behavior:", behavior);

        if (!this.sessionManager) {
            debugLog("SessionManager not initialized");
            this.suspended = false;
            this.currentSnapshot = null;
            return;
        }

        // 重新连接之前活动的会话
        for (const port of snap.activePorts) {
            try {
                const session = await this.sessionManager.createSession({
                    port,
                    baudrate: 115200,
                });
                await session.connect();
                debugLog(`Reconnected session on port ${port}`);

                // 根据行为执行操作
                if (behavior === "executeBootMain") {
                    await this.delay(400);
                    await session.softReboot();
                    debugLog("Sent soft reset to device");
                } else if (
                    behavior === "runChanged" &&
                    options.resumeCommand
                ) {
                    await this.delay(600);
                    await session.execute(options.resumeCommand);
                    debugLog("Sent resume command:", options.resumeCommand);
                }
            } catch (error) {
                debugLog(`Failed to restore session on port ${port}:`, error);
            }
        }

        this.suspended = false;
        this.currentSnapshot = null;

        debugLog("Restore complete");
    }

    /**
     * 检查是否已挂起
     */
    public isSuspended(): boolean {
        return this.suspended;
    }

    /**
     * 获取当前快照
     */
    public getSnapshot(): SessionSnapshot | null {
        return this.currentSnapshot;
    }

    /**
     * 取消挂起（不恢复）
     */
    public cancel(): void {
        this.suspended = false;
        this.currentSnapshot = null;
        debugLog("Suspend cancelled without restore");
    }

    // ========================================================================
    // 私有方法
    // ========================================================================

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

/**
 * 快捷函数：挂起会话
 */
export async function suspendSerialSessions(): Promise<SessionSnapshot> {
    return SyncSessionManager.getInstance().suspend();
}

/**
 * 快捷函数：恢复会话
 */
export async function restoreSerialSessions(
    snapshot?: SessionSnapshot,
    options?: {
        behavior?: RestoreBehavior;
        resumeCommand?: string;
    }
): Promise<void> {
    return SyncSessionManager.getInstance().restore(snapshot, options);
}

/**
 * 兼容函数：suspendSerialSessionsForAutoSync
 * 用于兼容旧代码
 */
export async function suspendSerialSessionsForAutoSync(): Promise<SessionSnapshot> {
    return suspendSerialSessions();
}

/**
 * 兼容函数：restoreSerialSessionsFromSnapshot
 * 用于兼容旧代码
 */
export async function restoreSerialSessionsFromSnapshot(
    snapshot: SessionSnapshot,
    options?: {
        resumeReplCommand?: string;
        replBehavior?: RestoreBehavior;
    }
): Promise<void> {
    return restoreSerialSessions(snapshot, {
        behavior: options?.replBehavior,
        resumeCommand: options?.resumeReplCommand,
    });
}
