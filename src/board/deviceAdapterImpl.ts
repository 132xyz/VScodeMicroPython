/**
 * Device Adapter Implementation - 设备适配器实现
 *
 * 使用新的 mpy_backend 实现 DeviceAdapter 接口。
 * 提供与旧 mpremote API 兼容的方法。
 */

import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    DeviceAdapter,
    BoardInfo,
    FileEntry,
    FileStat,
    TreeStat,
    BoardFilesResult,
    SerialPortInfo,
    HealthCheckResult,
    ExecuteResult,
} from "./deviceAdapter";
import { getSessionManager, SessionManager, DeviceSession } from "../session";
import { FileEntry as BackendFileEntry } from "../backend";

/**
 * 设备适配器实现类
 *
 * 单例模式，通过 getInstance() 获取实例。
 */
export class DeviceAdapterImpl implements DeviceAdapter {
    private static instance: DeviceAdapterImpl | null = null;

    private sessionManager: SessionManager | null = null;
    private currentSession: DeviceSession | null = null;
    private currentPort: string | null = null;
    private initialized = false;

    private constructor() {}

    /**
     * 获取单例实例
     */
    public static getInstance(): DeviceAdapterImpl {
        if (!DeviceAdapterImpl.instance) {
            DeviceAdapterImpl.instance = new DeviceAdapterImpl();
        }
        return DeviceAdapterImpl.instance;
    }

    /**
     * 初始化适配器
     */
    public async initialize(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) {
            return;
        }

        try {
            this.sessionManager = getSessionManager({
                context,
                debug: vscode.workspace
                    .getConfiguration("microPythonWorkBench")
                    .get<boolean>("debug", false),
            });

            await this.sessionManager.initialize();
            this.initialized = true;
        } catch (error) {
            console.error("[DeviceAdapterImpl] Failed to initialize:", error);
            throw error;
        }
    }

    /**
     * 确保已初始化
     */
    private ensureInitialized(): void {
        if (!this.initialized || !this.sessionManager) {
            throw new Error(
                "DeviceAdapter not initialized. Call initialize() first."
            );
        }
    }

    // ========================================================================
    // 连接管理
    // ========================================================================

    public async connect(port: string, baudrate = 115200): Promise<void> {
        this.ensureInitialized();

        // 如果已连接到同一端口，直接返回
        if (this.currentSession && this.currentPort === port) {
            if (this.currentSession.isConnected) {
                return;
            }
        }

        // 断开现有连接
        if (this.currentSession) {
            await this.disconnect();
        }

        // 创建新会话
        this.currentSession = await this.sessionManager!.createSession({
            port,
            baudrate,
        });

        // 连接
        await this.currentSession.connect();
        this.currentPort = port;
    }

    public async disconnect(): Promise<void> {
        if (this.currentSession) {
            await this.currentSession.disconnect();
            this.currentSession.dispose();
            this.currentSession = null;
            this.currentPort = null;
        }
    }

    public isConnected(): boolean {
        return this.currentSession?.isConnected ?? false;
    }

    public getPort(): string | null {
        return this.currentPort;
    }

    // ========================================================================
    // 文件操作
    // ========================================================================

    public async ls(devicePath: string): Promise<string> {
        await this.ensureConnectedAsync();

        const entries = await this.lsTyped(devicePath);
        return entries.map((e) => (e.isDir ? `${e.name}/` : e.name)).join("\n");
    }

    public async lsTyped(devicePath: string): Promise<FileEntry[]> {
        await this.ensureConnectedAsync();

        const result = await this.currentSession!.listDir(devicePath);
        return result.map((entry: BackendFileEntry) => ({
            name: entry.name,
            isDir: entry.type === "dir",
            size: undefined,
            mtime: undefined,
        }));
    }

    public async mkdir(devicePath: string): Promise<void> {
        await this.ensureConnectedAsync();
        // 使用 execute 来创建目录
        const code = `import os; os.mkdir('${devicePath.replace(/'/g, "\\'")}')`;
        const result = await this.currentSession!.execute(code);
        if (!result.success) {
            throw new Error(`Failed to create directory: ${result.stderr}`);
        }
    }

    public async cpFromDevice(
        devicePath: string,
        localPath: string
    ): Promise<void> {
        await this.ensureConnectedAsync();

        // 读取设备文件
        const fileResult = await this.currentSession!.readFile(devicePath);

        // 确保本地目录存在
        const localDir = path.dirname(localPath);
        await fs.mkdir(localDir, { recursive: true });

        // 解码内容并写入本地文件
        let content: Buffer;
        if (fileResult.encoding === "base64") {
            content = Buffer.from(fileResult.content, "base64");
        } else {
            content = Buffer.from(fileResult.content, "utf-8");
        }
        await fs.writeFile(localPath, content);
    }

    public async cpToDevice(
        localPath: string,
        devicePath: string
    ): Promise<void> {
        await this.ensureConnectedAsync();

        // 读取本地文件
        const content = await fs.readFile(localPath);

        // 写入设备文件 (使用 base64 编码)
        const base64Content = content.toString("base64");
        await this.currentSession!.writeFile(devicePath, base64Content, "base64");
    }

    public async deleteFile(devicePath: string): Promise<void> {
        await this.ensureConnectedAsync();
        const code = `import os; os.remove('${devicePath.replace(/'/g, "\\'")}')`;
        const result = await this.currentSession!.execute(code);
        if (!result.success) {
            throw new Error(`Failed to delete file: ${result.stderr}`);
        }
    }

    public async deleteDirectory(devicePath: string): Promise<void> {
        await this.ensureConnectedAsync();
        // 递归删除目录
        const code = `
import os
def rmdir_recursive(path):
    try:
        for entry in os.listdir(path):
            full_path = path + '/' + entry
            try:
                os.remove(full_path)
            except:
                rmdir_recursive(full_path)
        os.rmdir(path)
    except Exception as e:
        print('Error:', e)
rmdir_recursive('${devicePath.replace(/'/g, "\\'")}')
`;
        const result = await this.currentSession!.execute(code);
        if (!result.success) {
            throw new Error(`Failed to delete directory: ${result.stderr}`);
        }
    }

    public async deleteAny(devicePath: string): Promise<void> {
        await this.ensureConnectedAsync();

        // 检查是文件还是目录
        const exists = await this.fileExists(devicePath);
        if (!exists) {
            return;
        }

        try {
            // 尝试作为文件删除
            await this.deleteFile(devicePath);
        } catch {
            // 如果失败，尝试作为目录删除
            await this.deleteDirectory(devicePath);
        }
    }

    public async fileExists(devicePath: string): Promise<boolean> {
        await this.ensureConnectedAsync();

        try {
            const code = `
import os
try:
    os.stat('${devicePath.replace(/'/g, "\\'")}')
    print('EXISTS')
except:
    print('NOT_EXISTS')
`;
            const result = await this.currentSession!.execute(code);
            return result.stdout.includes("EXISTS");
        } catch {
            return false;
        }
    }

    public async readFile(devicePath: string): Promise<Uint8Array> {
        await this.ensureConnectedAsync();
        const fileResult = await this.currentSession!.readFile(devicePath);
        
        if (fileResult.encoding === "base64") {
            const binaryString = atob(fileResult.content);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
        }
        
        return new TextEncoder().encode(fileResult.content);
    }

    public async writeFile(
        devicePath: string,
        content: Uint8Array | string
    ): Promise<void> {
        await this.ensureConnectedAsync();

        let contentStr: string;
        let encoding: "utf-8" | "base64" = "utf-8";

        if (typeof content === "string") {
            contentStr = content;
        } else {
            // 转换为 base64
            const binaryString = Array.from(content)
                .map(byte => String.fromCharCode(byte))
                .join("");
            contentStr = btoa(binaryString);
            encoding = "base64";
        }

        await this.currentSession!.writeFile(devicePath, contentStr, encoding);
    }

    // ========================================================================
    // 设备控制
    // ========================================================================

    public async reset(): Promise<void> {
        await this.ensureConnectedAsync();
        await this.currentSession!.softReboot();
    }

    public async interrupt(): Promise<void> {
        await this.ensureConnectedAsync();
        await this.currentSession!.interrupt();
    }

    public async execute(code: string): Promise<ExecuteResult> {
        await this.ensureConnectedAsync();

        const startTime = Date.now();
        const result = await this.currentSession!.execute(code);
        const executionTime = Date.now() - startTime;

        return {
            success: result.success,
            stdout: result.stdout,
            stderr: result.stderr,
            executionTime,
        };
    }

    public async healthCheck(port?: string): Promise<HealthCheckResult> {
        const targetPort = port || this.currentPort;

        if (!targetPort) {
            return {
                healthy: false,
                responseTime: 0,
                error: "No port specified",
            };
        }

        const startTime = Date.now();

        try {
            // 如果已连接到目标端口，直接检查
            if (this.isConnected() && this.currentPort === targetPort) {
                // 简单的健康检查：执行空命令
                await this.currentSession!.execute("1");
                return {
                    healthy: true,
                    responseTime: Date.now() - startTime,
                };
            }

            // 否则，尝试临时连接
            const tempSession = await this.sessionManager!.createSession({
                port: targetPort,
                baudrate: 115200,
            });

            try {
                await tempSession.connect();
                await tempSession.execute("1");
                await tempSession.disconnect();
                tempSession.dispose();

                return {
                    healthy: true,
                    responseTime: Date.now() - startTime,
                };
            } catch (error) {
                tempSession.dispose();
                throw error;
            }
        } catch (error: any) {
            return {
                healthy: false,
                responseTime: Date.now() - startTime,
                error: error?.message || String(error),
            };
        }
    }

    // ========================================================================
    // 信息查询
    // ========================================================================

    public async detectBoardInfo(): Promise<BoardInfo | null> {
        // Return null instead of throwing when not connected
        if (!this.currentSession || !this.currentSession.isConnected) {
            return null;
        }

        try {
            const result = await this.currentSession!.execute(`
import sys
import gc
try:
    import machine
    machine_freq = machine.freq()
except:
    machine_freq = 0
print("__BOARD_INFO_START__")
print("machine:", sys.platform)
print("version:", sys.version)
print("implementation:", sys.implementation.name, sys.implementation.version)
gc.collect()
print("free_memory:", gc.mem_free())
print("__BOARD_INFO_END__")
`);

            if (!result.success) {
                return null;
            }

            // 解析输出
            const output = result.stdout;
            const startMarker = "__BOARD_INFO_START__";
            const endMarker = "__BOARD_INFO_END__";

            const startIdx = output.indexOf(startMarker);
            const endIdx = output.indexOf(endMarker);

            if (startIdx === -1 || endIdx === -1) {
                return null;
            }

            const infoText = output.substring(
                startIdx + startMarker.length,
                endIdx
            );
            const lines = infoText.trim().split("\n");

            const info: BoardInfo = {
                machine: "Unknown",
                version: "Unknown",
            };

            for (const line of lines) {
                const colonIdx = line.indexOf(":");
                if (colonIdx === -1) continue;

                const key = line.substring(0, colonIdx).trim();
                const value = line.substring(colonIdx + 1).trim();

                switch (key) {
                    case "machine":
                        info.machine = value;
                        break;
                    case "version":
                        info.version = value;
                        break;
                    case "free_memory":
                        info.freeMemory = parseInt(value, 10);
                        break;
                }
            }

            return info;
        } catch (error) {
            console.error(
                "[DeviceAdapterImpl] Failed to detect board info:",
                error
            );
            return null;
        }
    }

    public async listSerialPorts(): Promise<SerialPortInfo[]> {
        this.ensureInitialized();

        // 通过后端获取串口列表
        // 这需要在后端实现串口枚举功能
        try {
            const ports = await this.sessionManager!.listPorts();
            return ports.map((p) => ({
                port: p.port,
                name: p.description || p.port,
                vendorId: p.vendorId,
                productId: p.productId,
                manufacturer: p.manufacturer,
            }));
        } catch (error) {
            console.error(
                "[DeviceAdapterImpl] Failed to list serial ports:",
                error
            );
            return [];
        }
    }

    // ========================================================================
    // 高级文件操作
    // ========================================================================

    public async rename(srcPath: string, dstPath: string): Promise<void> {
        await this.ensureConnectedAsync();

        const code = `import os; os.rename('${srcPath.replace(/'/g, "\\'")}', '${dstPath.replace(/'/g, "\\'")}')`;
        const result = await this.currentSession!.execute(code);
        if (!result.success) {
            throw new Error(`Failed to rename: ${result.stderr}`);
        }
    }

    public async stat(
        devicePath: string
    ): Promise<FileStat | null> {
        await this.ensureConnectedAsync();

        try {
            const code = `
import os
try:
    s = os.stat('${devicePath.replace(/'/g, "\\'")}')
    mode = s[0]
    size = s[6]
    mtime = s[8] if len(s) > 8 else 0
    isdir = (mode & 0x4000) != 0
    print("__STAT__")
    print("mode:", mode)
    print("size:", size)
    print("mtime:", mtime)
    print("isdir:", 1 if isdir else 0)
except OSError:
    print("__STAT_NOT_FOUND__")
`;
            const result = await this.currentSession!.execute(code);

            if (
                !result.success ||
                result.stdout.includes("__STAT_NOT_FOUND__")
            ) {
                return null;
            }

            const lines = result.stdout.split("\n");
            let mode = 0;
            let size = 0;
            let mtime = 0;
            let isDir = false;

            for (const line of lines) {
                const colonIdx = line.indexOf(":");
                if (colonIdx === -1) continue;

                const key = line.substring(0, colonIdx).trim();
                const value = line.substring(colonIdx + 1).trim();

                switch (key) {
                    case "mode":
                        mode = parseInt(value, 10);
                        break;
                    case "size":
                        size = parseInt(value, 10);
                        break;
                    case "mtime":
                        mtime = parseInt(value, 10);
                        break;
                    case "isdir":
                        isDir = value === "1";
                        break;
                }
            }

            return {
                mode,
                size,
                mtime,
                isDir,
                isReadonly: false,
            };
        } catch {
            return null;
        }
    }

    public async listTreeStats(
        rootPath: string
    ): Promise<TreeStat[]> {
        await this.ensureConnectedAsync();

        // 使用递归遍历获取目录树统计信息
        const code = `
import os
def list_tree(path, results):
    try:
        entries = os.listdir(path)
        for name in entries:
            full = path + '/' + name if path != '/' else '/' + name
            try:
                s = os.stat(full)
                mode = s[0]
                size = s[6]
                mtime = s[8] if len(s) > 8 else 0
                isdir = (mode & 0x4000) != 0
                results.append((full, 1 if isdir else 0, size, mtime))
                if isdir:
                    list_tree(full, results)
            except:
                pass
    except:
        pass

results = []
root = '${rootPath.replace(/'/g, "\\'")}'
try:
    s = os.stat(root)
    mode = s[0]
    size = s[6]
    mtime = s[8] if len(s) > 8 else 0
    isdir = (mode & 0x4000) != 0
    results.append((root, 1 if isdir else 0, size, mtime))
    if isdir:
        list_tree(root, results)
except:
    pass
print("__TREE_START__")
for r in results:
    print(repr(r))
print("__TREE_END__")
`;
        const result = await this.currentSession!.execute(code);

        if (!result.success) {
            return [];
        }

        const output = result.stdout;
        const startIdx = output.indexOf("__TREE_START__");
        const endIdx = output.indexOf("__TREE_END__");

        if (startIdx === -1 || endIdx === -1) {
            return [];
        }

        const treeText = output
            .substring(startIdx + "__TREE_START__".length, endIdx)
            .trim();
        const lines = treeText.split("\n").filter((l) => l.trim());

        const stats: TreeStat[] = [];

        for (const line of lines) {
            // 解析 Python tuple 格式: ('path', isdir, size, mtime)
            const match = line.match(
                /\('([^']*)',\s*(\d+),\s*(\d+),\s*(\d+)\)/
            );
            if (match) {
                stats.push({
                    path: match[1],
                    isDir: match[2] === "1",
                    size: parseInt(match[3], 10),
                    mtime: parseInt(match[4], 10),
                });
            }
        }

        return stats;
    }

    public async getBoardFilesAndSizes(
        rootPath: string
    ): Promise<BoardFilesResult> {
        const treeStats = await this.listTreeStats(rootPath);

        const files = new Map<string, { size: number; isDir: boolean }>();
        const directories = new Set<string>();

        for (const stat of treeStats) {
            if (stat.isDir) {
                directories.add(stat.path);
            } else {
                files.set(stat.path, { size: stat.size, isDir: false });
            }
        }

        return { files, directories };
    }

    public async uploadReplacing(
        localPath: string,
        devicePath: string
    ): Promise<void> {
        await this.ensureConnectedAsync();

        // 先尝试删除目标文件（如果存在）
        try {
            const exists = await this.fileExists(devicePath);
            if (exists) {
                await this.deleteFile(devicePath);
            }
        } catch {
            // 忽略删除错误
        }

        // 上传文件
        await this.cpToDevice(localPath, devicePath);
    }

    public async deleteAllInPath(
        rootPath: string
    ): Promise<{ deleted: string[]; errors: string[] }> {
        await this.ensureConnectedAsync();

        const deleted: string[] = [];
        const errors: string[] = [];

        try {
            const treeStats = await this.listTreeStats(rootPath);
            
            // 按路径长度倒序排列（先删除深层文件）
            const sorted = [...treeStats].sort(
                (a, b) => b.path.length - a.path.length
            );

            for (const stat of sorted) {
                try {
                    if (stat.isDir) {
                        await this.deleteDirectory(stat.path);
                    } else {
                        await this.deleteFile(stat.path);
                    }
                    deleted.push(stat.path);
                } catch (e: any) {
                    errors.push(`${stat.path}: ${e?.message || String(e)}`);
                }
            }
        } catch (e: any) {
            errors.push(`${rootPath}: ${e?.message || String(e)}`);
        }

        return { deleted, errors };
    }

    public async mvOnDevice(src: string, dst: string): Promise<void> {
        await this.rename(src, dst);
    }

    public async mv(src: string, dst: string): Promise<void> {
        await this.rename(src, dst);
    }

    // ========================================================================
    // 调试方法
    // ========================================================================

    public async debugTreeParsing(): Promise<void> {
        console.log("[DeviceAdapterImpl] debugTreeParsing called");
        try {
            const stats = await this.listTreeStats("/");
            console.log("[DeviceAdapterImpl] Tree stats:", JSON.stringify(stats, null, 2));
        } catch (e) {
            console.error("[DeviceAdapterImpl] Tree parsing error:", e);
        }
    }

    public async debugFilesystemStatus(): Promise<void> {
        console.log("[DeviceAdapterImpl] debugFilesystemStatus called");
        try {
            await this.ensureConnectedAsync();
            const result = await this.currentSession!.execute(`
import os
import gc
gc.collect()
print("Free memory:", gc.mem_free())
print("File system info:")
try:
    stat = os.statvfs('/')
    print("  Total:", stat[0] * stat[2], "bytes")
    print("  Free:", stat[0] * stat[3], "bytes")
except:
    print("  statvfs not available")
print("Root directory contents:")
for item in os.listdir('/'):
    try:
        st = os.stat('/' + item)
        is_dir = (st[0] & 0x4000) != 0
        print("  ", item, "(dir)" if is_dir else f"({st[6]} bytes)")
    except:
        print("  ", item, "(error)")
`);
            console.log("[DeviceAdapterImpl] Filesystem status output:", result.stdout);
        } catch (e) {
            console.error("[DeviceAdapterImpl] Filesystem status error:", e);
        }
    }

    // ========================================================================
    // 私有方法
    // ========================================================================

    /**
     * 自动连接到配置的端口（如果尚未连接）
     */
    private async ensureConnectedAsync(): Promise<void> {
        this.ensureInitialized();

        // 如果已连接，直接返回
        if (this.currentSession && this.currentSession.isConnected) {
            return;
        }

        // 获取配置的端口
        const vscode = await import("vscode");
        const configuredPort = vscode.workspace
            .getConfiguration("microPythonWorkBench")
            .get<string>("connect", "auto");

        if (!configuredPort || configuredPort === "auto") {
            throw new Error("No port configured. Please select a serial port first.");
        }

        // 尝试连接
        await this.connect(configuredPort);
    }

    private ensureConnected(): void {
        this.ensureInitialized();

        if (!this.currentSession || !this.currentSession.isConnected) {
            throw new Error("Not connected to device");
        }
    }
}
