# MicroPython 后端迁移：旧 mpremote 代码完整移除方案

> **文档版本**: 1.0  
> **创建日期**: 2025-01-XX  
> **目标**: 完全移除旧的 mpremote CLI 包装器代码，统一使用新的 mpy_backend 实现

---

## 📋 目录

1. [项目当前状态分析](#1-项目当前状态分析)
2. [功能清单与替代方案](#2-功能清单与替代方案)
3. [需要移除的代码详解](#3-需要移除的代码详解)
4. [需要新增的功能逻辑](#4-需要新增的功能逻辑)
5. [完整任务清单](#5-完整任务清单)
6. [风险评估与注意事项](#6-风险评估与注意事项)
7. [编程哲学与开发规范](#7-编程哲学与开发规范)

---

## 1. 项目当前状态分析

### 1.1 旧架构（需移除）

```
┌─────────────────────────────────────────────────────────────┐
│                      旧 mpremote 架构                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐    ┌─────────────────┐                 │
│  │  MpRemoteManager │    │  mpremote.ts    │                 │
│  │     (260行)      │    │   (2026行)      │                 │
│  │                  │    │                  │                 │
│  │ • detectPython   │    │ • runMpremote   │                 │
│  │ • run()          │    │ • ls/lsTyped    │                 │
│  │ • spawn()        │    │ • mkdir/rm      │                 │
│  │ • 调用序列化锁    │    │ • cpTo/cpFrom   │                 │
│  │ • 进程管理       │    │ • 文件树缓存     │                 │
│  └────────┬────────┘    └────────┬────────┘                 │
│           │                       │                          │
│           └─────────┬─────────────┘                          │
│                     ▼                                        │
│  ┌─────────────────────────────────────────┐                │
│  │         mpremoteCommands.ts              │                │
│  │              (705行)                     │                │
│  │                                          │                │
│  │  • REPL 终端管理 (replTerminal)          │                │
│  │  • Run 终端管理 (runTerminal)            │                │
│  │  • suspendSerialSessionsForAutoSync     │                │
│  │  • restoreSerialSessionsFromSnapshot    │                │
│  │  • robustInterrupt                      │                │
│  │  • robustInterruptAndReset              │                │
│  └─────────────────────────────────────────┘                │
│                     │                                        │
│                     ▼                                        │
│  ┌─────────────────────────────────────────┐                │
│  │    python -m mpremote <args>             │  ← CLI 调用    │
│  │    (每次操作都启动新进程)                  │                │
│  └─────────────────────────────────────────┘                │
│                                                              │
└─────────────────────────────────────────────────────────────┘

问题:
1. 每次操作启动新 Python 进程，开销大
2. CLI 解析/序列化浪费性能
3. 无法直接处理二进制数据
4. REPL 不支持中文输入 (readline.c 限制)
5. 终端管理分散，状态难以追踪
```

### 1.2 新架构（已实现核心）

```
┌─────────────────────────────────────────────────────────────┐
│                     新 mpy_backend 架构                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐    ┌─────────────────┐                 │
│  │  DeviceAdapter   │    │ SessionManager  │                 │
│  │   (接口定义)     │    │   (会话管理)     │                 │
│  │                  │    │                  │                 │
│  │ • connect()      │    │ • createSession │                 │
│  │ • disconnect()   │    │ • getSession    │                 │
│  │ • ls/lsTyped()   │    │ • closeSession  │                 │
│  │ • read/write()   │    │ • listPorts()   │                 │
│  │ • execute()      │    │ • isBusy()      │                 │
│  └────────┬────────┘    └────────┬────────┘                 │
│           │                       │                          │
│           └─────────┬─────────────┘                          │
│                     ▼                                        │
│  ┌─────────────────────────────────────────┐                │
│  │         DeviceSession                    │                │
│  │         (设备会话)                        │                │
│  │                                          │                │
│  │  • 持久连接管理                           │                │
│  │  • Raw Paste 模式支持                    │                │
│  │  • 二进制数据传输                         │                │
│  │  • 中断/重启控制                          │                │
│  └─────────────────────────────────────────┘                │
│                     │                                        │
│                     ▼                                        │
│  ┌─────────────────────────────────────────┐                │
│  │         mpy_backend (Python)             │  ← 长驻进程    │
│  │                                          │                │
│  │  • JSON-RPC 通信                         │                │
│  │  • 直接串口控制                           │                │
│  │  • Raw Paste 协议                        │                │
│  │  • 高效二进制传输                         │                │
│  └─────────────────────────────────────────┘                │
│                                                              │
└─────────────────────────────────────────────────────────────┘

优势:
1. 单一长驻 Python 进程，避免反复启动
2. JSON-RPC 直接通信，无 CLI 解析开销
3. 原生支持二进制数据 (base64 编码)
4. 客户端编辑实现中文 REPL 支持
5. 集中式连接管理，状态清晰
```

### 1.3 当前完成进度

| 模块 | 状态 | 说明 |
|------|------|------|
| mpy_backend (Python) | ✅ 完成 | 设备通信核心 |
| BackendProcess | ✅ 完成 | Python 进程管理 |
| IPCClient | ✅ 完成 | JSON-RPC 客户端 |
| SessionManager | ✅ 完成 | 会话管理器 |
| DeviceSession | ✅ 完成 | 设备会话封装 |
| MpyPseudoterminal | ✅ 完成 | REPL 伪终端 |
| DeviceAdapter | ✅ 完成 | 适配器接口 |
| DeviceAdapterImpl | ✅ 完成 | 适配器实现 |
| SyncSessionManager | ✅ 完成 | 同步会话管理 |
| PythonDetector | ✅ 完成 | Python 路径检测 |
| SerialPortService | ✅ 完成 | 串口枚举服务 |
| **旧代码替换** | ❌ 待完成 | 需要迁移调用点 |
| **旧代码删除** | ❌ 待完成 | 需要移除文件 |

---

## 2. 功能清单与替代方案

### 2.1 文件操作功能

| 旧函数 (mpremote.ts) | 新函数 (DeviceAdapter) | 实现状态 |
|---------------------|----------------------|---------|
| `ls(path)` | `ls(path)` | ✅ |
| `lsTyped(path)` | `lsTyped(path)` | ✅ |
| `mkdir(path)` | `createDirectory(path)` | ✅ |
| `cpToDevice(local, device)` | `cpToDevice(local, device)` | ✅ |
| `cpFromDevice(device, local)` | `cpFromDevice(device, local)` | ✅ |
| `uploadReplacing(local, device)` | `writeFile(path, content)` | ✅ |
| `deleteFile(path)` | `deleteFile(path)` | ✅ |
| `deleteAny(path)` | `deleteAny(path)` | ✅ |
| `deleteFolderRecursive(path)` | `deleteDirectory(path)` | ✅ |
| `fileExists(path)` | `fileExists(path)` | ✅ |
| `mvOnDevice(src, dst)` | `rename(src, dst)` | ⚠️ 需添加 |
| `getFileInfo(path)` | `stat(path)` | ⚠️ 需添加 |

### 2.2 设备控制功能

| 旧函数 | 新函数 | 实现状态 |
|-------|--------|---------|
| `reset()` | `reset()` / `softReset()` | ✅ |
| `healthCheck(port)` | `healthCheck(port)` | ✅ |
| `cancelAll()` | `interrupt()` | ✅ |
| `runFile(path)` | `execute(code)` + 文件读取 | ⚠️ 需实现 |
| `detectBoardInfo()` | `detectBoardInfo()` | ✅ |
| `listSerialPorts()` | `listPorts()` | ✅ |

### 2.3 终端管理功能

| 旧函数 (mpremoteCommands.ts) | 新实现 | 状态 |
|------------------------------|--------|------|
| `getReplTerminal()` | `MpyPseudoterminal` | ✅ 核心完成 |
| `openReplTerminal()` | 新 REPL 命令 | ⚠️ 需集成 |
| `closeReplTerminal()` | Session.disconnect() | ⚠️ 需集成 |
| `isReplOpen()` | SessionManager.hasActiveSession() | ⚠️ 需实现 |
| `runActiveFile()` | DeviceAdapter.execute() | ⚠️ 需实现 |
| `getRunTerminal()` | 新 Run 终端 | ⚠️ 需实现 |
| `isRunTerminalOpen()` | 终端状态检查 | ⚠️ 需实现 |

### 2.4 自动同步功能

| 旧函数 | 新实现 | 状态 |
|--------|--------|------|
| `suspendSerialSessionsForAutoSync()` | `SyncSessionManager.suspend()` | ✅ |
| `restoreSerialSessionsFromSnapshot()` | `SyncSessionManager.restore()` | ✅ |
| `robustInterrupt()` | `DeviceAdapter.interrupt()` | ⚠️ 需整合 |
| `robustInterruptAndReset()` | interrupt() + reset() | ⚠️ 需整合 |

### 2.5 缓存功能

| 旧功能 | 处理方案 | 说明 |
|--------|---------|------|
| `globalFileTreeCache` | 移至后端或新缓存模块 | 考虑后端缓存 |
| `populateFileTreeCache()` | 后端 listDirRecursive | 后端实现 |
| `clearFileTreeCache()` | 通知后端刷新 | IPC 消息 |
| `refreshFileTreeCache()` | 后端重新获取 | IPC 消息 |
| `getEntriesFromCache()` | 后端查询 | IPC 消息 |

---

## 3. 需要移除的代码详解

### 3.1 需要删除的文件

```
待删除文件:
├── src/board/mpremote.ts          (2026行) - 核心CLI包装器
├── src/board/mpremoteCommands.ts  (705行)  - 终端/REPL管理
├── src/board/MpRemoteManager.ts   (260行)  - Python进程管理
└── src/commands/mpremoteCommands.ts (171行) - mpremote状态命令

总计: 约 3162 行代码需要删除
```

### 3.2 mpremote.ts 详细分析

#### 3.2.1 可直接删除的代码 (无需替代)

```typescript
// ======== 以下代码完全不需要了 ========

// 1. CLI 命令构建 (20-50行)
async function formatMpremoteCmd(args: string[], pythonPath?: string | null)
// 新架构直接 JSON-RPC 通信，无需构建 CLI 命令

// 2. 连接管理器类 (100-200行)
class ConnectionManager {
  private activeConnections: Map<string, { lastUsed: number; isHealthy: boolean }>;
  private healthCheckTimer?: NodeJS.Timeout;
  // ...
}
// 新架构: SessionManager 已经实现连接管理

// 3. runMpremote 核心函数 (200-400行)
async function runMpremote(args: string[], opts?: RunOptions): Promise<{ stdout: string; stderr: string }>
// 这是旧架构的核心，每次启动新进程执行 CLI 命令
// 新架构: 通过 DeviceSession.execute() 直接与后端通信

// 4. 文件树缓存 (400-700行)
let globalFileTreeCache: TreeNode | null = null;
async function populateFileTreeCache(): Promise<void>
function isCacheValid(): boolean
function getEntriesFromCache(targetPath: string): { name: string; isDir: boolean }[] | null
export function clearFileTreeCache(): void
export async function refreshFileTreeCache(): Promise<void>
// 决策: 将缓存逻辑移至后端或创建独立缓存模块

// 5. Tree 解析辅助函数 (700-900行)
function parseTreeLines(stdout: string): ParsedLine[]
function buildTreeFromParsedLines(lines: ParsedLine[]): TreeNode
// 新架构: 后端直接返回结构化数据，无需解析 CLI 输出

// 6. 调试函数 (900-1000行)
export async function debugTreeParsing(): Promise<void>
export async function debugFilesystemStatus(): Promise<void>
export function getFileTreeCacheStats(): { ... }
// 新架构: 后端有自己的调试日志

// 7. 路径归一化 (各处散落)
function normalizeConnect(c: string): string
// 新架构: 端口路径由 SerialPortService 统一处理
```

#### 3.2.2 需要迁移的功能

```typescript
// ======== 以下功能需要迁移到新实现 ========

// 1. 设备根路径映射 (50-100行)
function getEffectiveDeviceRootSync(): string
export function toDevicePath(localRel: string, rootPath: string): string
export function toLocalRelative(devicePath: string, rootPath: string): string | null
// 迁移到: src/utils/pathMapping.ts (新建)

// 2. 文件操作 (1000-1500行) - 已由 DeviceAdapter 实现
export async function ls(p: string): Promise<string>
export async function lsTyped(p: string): Promise<FileEntry[]>
export async function mkdir(p: string): Promise<void>
export async function cpToDevice(localPath: string, remotePath: string): Promise<void>
export async function cpFromDevice(remotePath: string, localPath: string): Promise<void>
export async function deleteFile(p: string): Promise<void>
export async function deleteAny(p: string): Promise<void>
// 状态: ✅ DeviceAdapterImpl 已实现

// 3. 设备信息 (1500-1700行)
export async function listSerialPorts(): Promise<SerialPortInfo[]>
export async function detectBoardInfo(): Promise<BoardInfo | null>
// 状态: ✅ DeviceAdapterImpl 已实现

// 4. 设备控制 (1700-1800行)
export async function reset(): Promise<void>
export async function healthCheck(port?: string): Promise<HealthCheckResult>
// 状态: ✅ DeviceAdapterImpl 已实现

// 5. 高级操作 (1800-2026行)
export async function mvOnDevice(src: string, dst: string): Promise<void>
export async function getBoardFilesAndSizes(rootPath: string): Promise<...>
export async function listTreeStats(root: string): Promise<Array<...>>
// 状态: ⚠️ 部分需要添加到 DeviceAdapter
```

### 3.3 mpremoteCommands.ts 详细分析

#### 3.3.1 REPL 终端管理 (核心，需重写)

```typescript
// ======== 需要用 MpyPseudoterminal 替换 ========

let replTerminal: vscode.Terminal | undefined;
let userClosedRepl = false;

// 创建 REPL 终端
export async function getReplTerminal(
  context?: vscode.ExtensionContext,
  opts?: { interrupt?: boolean }
): Promise<vscode.Terminal>

// 打开 REPL
export async function openReplTerminal()

// 关闭 REPL
export async function closeReplTerminal(userInitiated: boolean = false)

// 检查状态
export function isReplOpen(): boolean

// 重启 REPL
export async function restartReplInExistingTerminal(opts: { show?: boolean } = {})

// 断开但不关闭
export async function disconnectReplTerminal()

// 新实现位置: src/terminal/replCommands.ts (待创建)
```

#### 3.3.2 Run 终端管理 (需重写)

```typescript
// ======== 需要重新实现 ========

let runTerminal: vscode.Terminal | undefined;
let lastRunCommand: LastRunCommand | undefined;

// 获取/创建 Run 终端
function getRunTerminal(): vscode.Terminal

// 运行当前文件
export async function runActiveFile(): Promise<void>

// 检查状态
export function isRunTerminalOpen(): boolean

// 关闭
export async function closeRunTerminal()

// 记住最后命令 (用于恢复)
function rememberLastRunCommand(device: string, filePath: string, cmd: string)

// 重新执行
async function rerunLastRunCommand(info: LastRunCommand): Promise<void>

// 新实现位置: src/terminal/runCommands.ts (待创建)
```

#### 3.3.3 自动同步支持 (已迁移)

```typescript
// ======== 已迁移到 SyncSessionManager ========

export async function suspendSerialSessionsForAutoSync(): Promise<AutoSuspendSnapshot>
export async function restoreSerialSessionsFromSnapshot(
  snapshot: AutoSuspendSnapshot,
  opts?: { ... }
): Promise<void>

// 新实现: src/board/syncSessionManager.ts ✅
```

#### 3.3.4 中断/重置 (需整合)

```typescript
// ======== 需要整合到 DeviceAdapter ========

export async function robustInterrupt(port?: string): Promise<void>
export async function robustInterruptAndReset(port?: string): Promise<void>
export async function softReset(): Promise<void>
export async function serialSendCtrlC(): Promise<void>
export async function stop(): Promise<void>

// 新实现: DeviceAdapter.interrupt() + DeviceAdapter.reset()
// 需要添加: robustInterrupt 的多重尝试逻辑
```

### 3.4 MpRemoteManager.ts 详细分析

```typescript
// ======== 全部可删除 ========

class MpRemoteManagerClass {
  // Python 检测 - 已迁移到 PythonDetector
  async detectPythonPath(): Promise<string | null>
  
  // 内部 Python 路径 - 新架构不需要
  private getInternalPythonRoot(): string | null
  
  // 模块可用性检查 - 新架构不需要
  async isModuleAvailable(pythonPath?: string | null): Promise<boolean>
  
  // 版本检查 - 新架构不需要 mpremote 版本
  async checkVersion(): Promise<VersionInfo>
  
  // CLI 执行 - 完全由后端替代
  async run(args: string[], opts: RunOptions = {}): Promise<...>
  async spawn(args: string[], opts: RunOptions = {}): Promise<ChildProcess>
  
  // 进程管理 - 由 BackendProcess 替代
  private activeChild: ChildProcess | null = null;
  private _lock: Promise<void> = Promise.resolve();
  cancelActive(): void
  isBusy(): boolean
  getActiveConnectionPort(): string | null
}

// 全部功能已由新模块替代，可安全删除
```

### 3.5 commands/mpremoteCommands.ts 详细分析

```typescript
// ======== 全部可删除 ========

export const mpremoteCommands = {
  // 这些功能现在都不需要了，因为 mpremote 已内置
  async checkAndInstallMpremote(silent: boolean = false): Promise<boolean>
  async checkMpremoteAvailability(): Promise<boolean>
  async findMpremoteExecutable(): Promise<string | null>
  async showMpremoteInstallationGuide(): Promise<void>
  async installMpremoteAutomatically(silent: boolean = false): Promise<void>
  async verifyAndHandleInstallation(pythonPath: string, silent: boolean = false): Promise<void>
  async showPathTroubleshootingGuide(pythonPath: string): Promise<void>
  async showManualInstallationInstructions(): Promise<void>
  async showMpremoteInformation(): Promise<void>
}

// 新架构不需要 mpremote 安装管理，完全删除
```

---

## 4. 需要新增的功能逻辑

### 4.1 路径映射模块 (新建)

```typescript
// src/utils/pathMapping.ts

/**
 * 路径映射工具
 * 从 mpremote.ts 迁移并优化
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

/**
 * 获取工作区的设备根目录
 */
export function getEffectiveDeviceRoot(): string { ... }

/**
 * 本地相对路径 → 设备路径
 */
export function toDevicePath(localRel: string, rootPath: string): string { ... }

/**
 * 设备路径 → 本地相对路径
 */
export function toLocalRelative(devicePath: string, rootPath: string): string | null { ... }
```

### 4.2 新 REPL 命令模块 (新建)

```typescript
// src/terminal/replCommands.ts

import * as vscode from 'vscode';
import { getSessionManager } from '../session';
import { MpyPseudoterminal } from './MpyPseudoterminal';

let currentRepl: { terminal: vscode.Terminal; pty: MpyPseudoterminal } | null = null;

/**
 * 打开 REPL 终端
 */
export async function openReplTerminal(context: vscode.ExtensionContext): Promise<vscode.Terminal> {
    // 如果已存在，直接返回
    if (currentRepl && isReplOpen()) {
        currentRepl.terminal.show();
        return currentRepl.terminal;
    }
    
    // 获取当前端口
    const port = vscode.workspace.getConfiguration()
        .get<string>("microPythonWorkBench.connect", "auto");
    
    if (!port || port === "auto") {
        throw new Error("请先选择串口");
    }
    
    // 创建会话
    const sessionManager = getSessionManager({ context });
    const session = await sessionManager.createSession({ port, baudrate: 115200 });
    
    // 创建伪终端
    const pty = new MpyPseudoterminal(session);
    
    // 创建 VS Code 终端
    const terminal = vscode.window.createTerminal({
        name: 'ESP32 REPL',
        pty: pty
    });
    
    currentRepl = { terminal, pty };
    terminal.show();
    
    return terminal;
}

/**
 * 关闭 REPL 终端
 */
export async function closeReplTerminal(userInitiated: boolean = false): Promise<void> { ... }

/**
 * 检查 REPL 是否打开
 */
export function isReplOpen(): boolean { ... }

/**
 * 中断当前执行
 */
export async function interruptRepl(): Promise<void> { ... }

/**
 * 软重启
 */
export async function softResetRepl(): Promise<void> { ... }
```

### 4.3 新 Run 命令模块 (新建)

```typescript
// src/terminal/runCommands.ts

import * as vscode from 'vscode';
import { DeviceAdapterImpl } from '../board/deviceAdapterImpl';

interface RunState {
    terminal: vscode.Terminal;
    lastFile: string;
    lastPort: string;
}

let runState: RunState | null = null;

/**
 * 运行当前活动文件
 */
export async function runActiveFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage("没有打开的文件");
        return;
    }
    
    await editor.document.save();
    
    const adapter = DeviceAdapterImpl.getInstance();
    const filePath = editor.document.uri.fsPath;
    
    // 读取文件内容
    const content = await vscode.workspace.fs.readFile(editor.document.uri);
    const code = new TextDecoder().decode(content);
    
    // 执行代码
    const result = await adapter.execute(code);
    
    // 显示输出
    showRunOutput(result);
}

/**
 * 显示运行输出
 */
function showRunOutput(result: ExecuteResult): void { ... }

/**
 * 关闭 Run 终端
 */
export async function closeRunTerminal(): Promise<void> { ... }

/**
 * 检查 Run 终端是否打开
 */
export function isRunTerminalOpen(): boolean { ... }
```

### 4.4 文件树缓存模块 (新建)

```typescript
// src/cache/fileTreeCache.ts

import * as vscode from 'vscode';
import { DeviceAdapterImpl } from '../board/deviceAdapterImpl';

interface TreeNode {
    name: string;
    isDir: boolean;
    children: TreeNode[];
    fullPath: string;
    size?: number;
    mtime?: number;
}

class FileTreeCache {
    private cache: TreeNode | null = null;
    private lastUpdate: number = 0;
    private readonly CACHE_DURATION = 30000; // 30秒
    
    /**
     * 获取目录内容 (优先从缓存)
     */
    async getEntries(path: string): Promise<{ name: string; isDir: boolean }[]> { ... }
    
    /**
     * 强制刷新缓存
     */
    async refresh(): Promise<void> { ... }
    
    /**
     * 清除缓存
     */
    clear(): void { ... }
    
    /**
     * 检查缓存是否有效
     */
    isValid(): boolean { ... }
    
    /**
     * 递归获取完整文件树
     */
    private async populateCache(): Promise<void> { ... }
}

export const fileTreeCache = new FileTreeCache();
```

### 4.5 健壮中断模块 (新建)

```typescript
// src/device/robustInterrupt.ts

import { DeviceAdapterImpl } from '../board/deviceAdapterImpl';
import { isReplOpen, closeReplTerminal } from '../terminal/replCommands';

/**
 * 健壮的设备中断
 * 多种方式尝试，确保设备响应
 */
export async function robustInterrupt(port?: string): Promise<void> {
    const adapter = DeviceAdapterImpl.getInstance();
    
    // 方式 1: 如果 REPL 打开，通过 REPL 发送中断
    if (isReplOpen()) {
        try {
            // TODO: 通过 MpyPseudoterminal 发送 Ctrl+C
            return;
        } catch (error) {
            console.warn('REPL 中断失败，尝试其他方式');
        }
    }
    
    // 方式 2: 通过 DeviceAdapter 中断
    try {
        await adapter.interrupt();
        return;
    } catch (error) {
        console.warn('DeviceAdapter 中断失败');
    }
    
    // 方式 3: 重新连接并中断
    try {
        await adapter.disconnect();
        await new Promise(r => setTimeout(r, 200));
        await adapter.connect(port || adapter.getPort()!);
        await adapter.interrupt();
    } catch (error) {
        throw new Error(`无法中断设备: ${error}`);
    }
}

/**
 * 健壮的中断并重置
 */
export async function robustInterruptAndReset(port?: string): Promise<void> {
    await robustInterrupt(port);
    await new Promise(r => setTimeout(r, 100));
    await DeviceAdapterImpl.getInstance().reset();
}
```

---

## 5. 完整任务清单

### 阶段 1: 创建新模块 (低风险)

| ID | 任务 | 优先级 | 风险 | 状态 |
|----|------|--------|------|------|
| N-01 | 创建 `src/utils/pathMapping.ts` 路径映射工具 | P0 | 低 | ⬜ |
| N-02 | 创建 `src/cache/fileTreeCache.ts` 文件树缓存 | P1 | 低 | ⬜ |
| N-03 | 创建 `src/terminal/replCommands.ts` REPL 命令 | P0 | 中 | ⬜ |
| N-04 | 创建 `src/terminal/runCommands.ts` Run 命令 | P1 | 中 | ⬜ |
| N-05 | 创建 `src/device/robustInterrupt.ts` 健壮中断 | P1 | 中 | ⬜ |
| N-06 | 扩展 DeviceAdapter 接口添加 `rename()` | P1 | 低 | ⬜ |
| N-07 | 扩展 DeviceAdapter 接口添加 `stat()` | P1 | 低 | ⬜ |
| N-08 | 扩展 DeviceAdapter 接口添加 `listTreeStats()` | P1 | 低 | ⬜ |
| N-09 | 实现 DeviceAdapterImpl.rename() | P1 | 低 | ⬜ |
| N-10 | 实现 DeviceAdapterImpl.stat() | P1 | 低 | ⬜ |
| N-11 | 实现 DeviceAdapterImpl.listTreeStats() | P1 | 低 | ⬜ |

### 阶段 2: 替换调用点 (中风险)

| ID | 任务 | 文件 | 调用数 | 风险 |
|----|------|------|--------|------|
| R-01 | 替换 boardOperations.ts 中的 mp.* 调用 | boardOperations.ts | 15+ | 中 |
| R-02 | 替换 extension.ts 中的 mp.* 调用 | extension.ts | 10+ | 中 |
| R-03 | 替换 syncOperations.ts 中的 mp.* 调用 | syncOperations.ts | 5+ | 中 |
| R-04 | 替换 utilityOperations.ts 中的 mp 动态导入 | utilityOperations.ts | 1 | 低 |
| R-05 | 替换 pythonInterpreter.ts 中的 MpRemoteManager | pythonInterpreter.ts | 1 | 低 |
| R-06 | 更新 extension.ts 中的 mpremoteCommands 导入 | extension.ts | 10+ | 中 |
| R-07 | 更新所有 suspendSerialSessionsForAutoSync 调用 | 多文件 | 3+ | 高 |
| R-08 | 更新所有 restoreSerialSessionsFromSnapshot 调用 | 多文件 | 3+ | 高 |
| R-09 | 替换 toDevicePath/toLocalRelative 调用 | 多文件 | 5+ | 低 |
| R-10 | 更新测试文件中的 mp.* 调用 | tests/*.ts | 3+ | 低 |

### 阶段 3: 终端管理迁移 (高风险)

| ID | 任务 | 描述 | 风险 |
|----|------|------|------|
| T-01 | 用新 replCommands 替换 getReplTerminal | 需要确保行为一致 | 高 |
| T-02 | 用新 replCommands 替换 openReplTerminal | 需要确保行为一致 | 高 |
| T-03 | 用新 replCommands 替换 closeReplTerminal | 需要确保行为一致 | 高 |
| T-04 | 用新 replCommands 替换 isReplOpen | 需要确保行为一致 | 中 |
| T-05 | 用新 runCommands 替换 runActiveFile | 需要确保行为一致 | 高 |
| T-06 | 用新 runCommands 替换 getRunTerminal | 需要确保行为一致 | 中 |
| T-07 | 用新 runCommands 替换 closeRunTerminal | 需要确保行为一致 | 中 |
| T-08 | 更新终端关闭事件监听器 | 需要处理 userClosedRepl | 中 |
| T-09 | 更新上下文键 microPythonWorkBench.replOpen | 需要保持 UI 状态一致 | 低 |

### 阶段 4: 删除旧文件 (最后执行)

| ID | 任务 | 文件 | 行数 |
|----|------|------|------|
| D-01 | 删除 src/board/mpremote.ts | mpremote.ts | 2026 |
| D-02 | 删除 src/board/mpremoteCommands.ts | mpremoteCommands.ts | 705 |
| D-03 | 删除 src/board/MpRemoteManager.ts | MpRemoteManager.ts | 260 |
| D-04 | 删除 src/commands/mpremoteCommands.ts | mpremoteCommands.ts | 171 |
| D-05 | 更新 tsconfig.json 排除已删除文件 | tsconfig.json | - |
| D-06 | 清理未使用的导入 | 所有文件 | - |

### 阶段 5: 验证与测试

| ID | 任务 | 描述 |
|----|------|------|
| V-01 | 编译验证 - 无 TypeScript 错误 | `npm run compile` |
| V-02 | 单元测试通过 | `npm run test` |
| V-03 | 手动测试 - 文件浏览器 | 列出/创建/删除文件 |
| V-04 | 手动测试 - REPL 终端 | 打开/关闭/中文输入 |
| V-05 | 手动测试 - 运行文件 | 运行 Python 脚本 |
| V-06 | 手动测试 - 自动同步 | 保存时同步文件 |
| V-07 | 手动测试 - 端口切换 | 切换不同设备 |
| V-08 | 性能测试 - 文件操作 | 比较新旧速度 |

---

## 6. 风险评估与注意事项

### 6.1 高风险区域

#### 🔴 REPL 终端迁移

**风险描述**: 
- 旧实现使用 `vscode.window.createTerminal()` 创建真实终端
- 新实现使用 `Pseudoterminal` 接口
- 行为差异可能导致用户困惑

**缓解措施**:
1. 保持终端名称一致 ("ESP32 REPL")
2. 保持快捷键/菜单行为一致
3. 添加详细的迁移日志
4. 提供回滚选项（配置开关）

#### 🔴 自动同步会话挂起/恢复

**风险描述**:
- 旧实现关闭/重开终端以释放串口
- 新实现通过会话管理器控制连接
- 时序差异可能导致端口冲突

**缓解措施**:
1. 添加足够的延迟和重试
2. 使用信号量确保串行访问
3. 添加详细的调试日志
4. 测试各种边界情况

#### 🔴 文件操作状态管理

**风险描述**:
- 旧实现每次操作都是独立的进程
- 新实现共享单一后端连接
- 并发操作可能导致状态混乱

**缓解措施**:
1. 在 SessionManager 中实现操作队列
2. 使用互斥锁保护关键操作
3. 添加超时机制
4. 实现操作取消功能

### 6.2 中风险区域

#### 🟡 路径映射

**风险描述**:
- 不同操作系统路径格式不同
- 设备根路径配置可能不一致

**缓解措施**:
1. 完整迁移现有路径映射逻辑
2. 添加单元测试覆盖各种情况
3. 保持向后兼容的配置格式

#### 🟡 文件树缓存

**风险描述**:
- 缓存失效可能显示过期数据
- 大型项目缓存可能占用内存

**缓解措施**:
1. 实现智能缓存失效策略
2. 添加缓存大小限制
3. 提供手动刷新选项

### 6.3 低风险区域

#### 🟢 简单文件操作

- ls, mkdir, read, write 等操作
- DeviceAdapter 已有完整实现
- 只需要替换调用点

#### 🟢 mpremote 安装相关

- commands/mpremoteCommands.ts
- 这些功能现在完全不需要
- 可以直接删除

---

## 7. 编程哲学与开发规范

### 7.1 核心原则

```
┌─────────────────────────────────────────────────────────────┐
│                     开发哲学金字塔                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│                    ┌───────────┐                            │
│                    │  正确性   │                            │
│                    │ Correctness│                           │
│                    └─────┬─────┘                            │
│                          │                                   │
│                 ┌────────┴────────┐                         │
│                 │    可维护性     │                         │
│                 │ Maintainability │                         │
│                 └────────┬────────┘                         │
│                          │                                   │
│            ┌─────────────┴─────────────┐                    │
│            │       可调试性            │                    │
│            │    Debuggability          │                    │
│            └─────────────┬─────────────┘                    │
│                          │                                   │
│       ┌──────────────────┴──────────────────┐               │
│       │           一致性                     │               │
│       │        Consistency                   │               │
│       └──────────────────┬──────────────────┘               │
│                          │                                   │
│  ┌───────────────────────┴───────────────────────┐          │
│  │                 性能                           │          │
│  │              Performance                       │          │
│  └───────────────────────────────────────────────┘          │
│                                                              │
└─────────────────────────────────────────────────────────────┘

优先级: 正确性 > 可维护性 > 可调试性 > 一致性 > 性能
```

### 7.2 正确性 (Correctness)

#### 原则
1. **先测试，后代码**: 编写测试用例验证预期行为
2. **边界条件优先**: 先处理边界情况，再处理正常情况
3. **失败是默认**: 假设操作会失败，设计恢复策略
4. **类型是文档**: 使用 TypeScript 类型表达意图

#### 实践
```typescript
// ❌ 不好的做法
async function readFile(path: string) {
  const content = await device.read(path);
  return content;
}

// ✅ 好的做法
async function readFile(path: string): Promise<Result<Uint8Array, FileError>> {
  // 验证输入
  if (!path || typeof path !== 'string') {
    return Err(new FileError('INVALID_PATH', '路径不能为空'));
  }
  
  // 检查连接状态
  if (!this.isConnected()) {
    return Err(new FileError('NOT_CONNECTED', '设备未连接'));
  }
  
  try {
    const content = await this.session.readFile(path);
    return Ok(content);
  } catch (error) {
    // 分类错误
    if (isNotFoundError(error)) {
      return Err(new FileError('NOT_FOUND', `文件不存在: ${path}`));
    }
    if (isPermissionError(error)) {
      return Err(new FileError('PERMISSION_DENIED', `无权限: ${path}`));
    }
    // 未知错误
    return Err(new FileError('UNKNOWN', `读取失败: ${error}`));
  }
}
```

### 7.3 可维护性 (Maintainability)

#### 原则
1. **单一职责**: 每个模块/类/函数只做一件事
2. **显式依赖**: 通过构造函数或参数注入依赖
3. **无魔法数字**: 所有常量都有名字
4. **自文档代码**: 代码本身说明意图，注释说明原因

#### 实践
```typescript
// ❌ 不好的做法
async function sync() {
  await sleep(300);  // 魔法数字
  const files = await mp.ls("/");  // 隐式依赖
  for (const f of files) {
    if (f.endsWith(".py")) {  // 硬编码规则
      await upload(f);
    }
  }
}

// ✅ 好的做法
// 常量定义
const SYNC_DELAY_MS = 300;
const SYNC_FILE_PATTERN = /\.py$/;

interface SyncOptions {
  delay?: number;
  pattern?: RegExp;
}

class FileSynchronizer {
  constructor(
    private readonly adapter: DeviceAdapter,  // 显式依赖
    private readonly options: SyncOptions = {}
  ) {}
  
  async sync(): Promise<SyncResult> {
    const delay = this.options.delay ?? SYNC_DELAY_MS;
    const pattern = this.options.pattern ?? SYNC_FILE_PATTERN;
    
    await this.waitForDevice(delay);  // 有意义的方法名
    
    const files = await this.adapter.listDir("/");
    const targets = files.filter(f => pattern.test(f.name));
    
    return this.uploadFiles(targets);
  }
  
  // 原因注释
  private async waitForDevice(ms: number): Promise<void> {
    // 设备在重连后需要短暂延迟才能稳定接受命令
    // 参见 issue #123
    await sleep(ms);
  }
}
```

### 7.4 可调试性 (Debuggability)

#### 原则
1. **结构化日志**: 使用统一的日志格式
2. **追踪上下文**: 每个操作都有唯一标识符
3. **状态可见**: 关键状态变化都有日志
4. **错误链路**: 保留完整的错误堆栈

#### 实践
```typescript
// ❌ 不好的做法
async function connect(port: string) {
  console.log("connecting...");
  try {
    await doConnect(port);
    console.log("connected");
  } catch (e) {
    console.log("error", e);
    throw e;
  }
}

// ✅ 好的做法
import { Logger } from '../utils/logger';

const log = new Logger('DeviceSession');

async function connect(port: string): Promise<void> {
  const operationId = generateId();
  const ctx = { port, operationId };
  
  log.info('Connection started', ctx);
  
  try {
    log.debug('Attempting raw connection', ctx);
    await this.rawConnect(port);
    
    log.debug('Sending handshake', ctx);
    await this.handshake();
    
    log.info('Connection established', { ...ctx, latency: Date.now() - start });
    
  } catch (error) {
    log.error('Connection failed', {
      ...ctx,
      error: serializeError(error),
      duration: Date.now() - start
    });
    
    // 包装错误，保留原始堆栈
    throw new ConnectionError(
      `Failed to connect to ${port}: ${error.message}`,
      { cause: error, port, operationId }
    );
  }
}
```

#### 日志级别规范

| 级别 | 用途 | 示例 |
|------|------|------|
| ERROR | 需要立即关注的问题 | 连接失败、写入错误 |
| WARN | 可恢复的异常情况 | 重试成功、降级处理 |
| INFO | 重要的业务事件 | 连接建立、同步完成 |
| DEBUG | 开发调试信息 | 函数进入/退出、中间状态 |
| TRACE | 详细追踪信息 | 数据包内容、循环迭代 |

### 7.5 一致性 (Consistency)

#### 命名规范

```typescript
// 文件命名: camelCase.ts
deviceAdapter.ts
sessionManager.ts
fileTreeCache.ts

// 类命名: PascalCase
class DeviceAdapter {}
class SessionManager {}
class FileTreeCache {}

// 接口命名: PascalCase，不加 I 前缀
interface DeviceAdapter {}  // ✅
interface IDeviceAdapter {} // ❌

// 常量命名: UPPER_SNAKE_CASE
const MAX_RETRY_COUNT = 3;
const DEFAULT_TIMEOUT_MS = 5000;

// 函数/方法命名: camelCase，动词开头
function createSession() {}
function isConnected() {}
function handleError() {}

// 私有成员: 前缀下划线或 private 关键字
class Foo {
  private _internal: string;  // 方式1
  private internal: string;   // 方式2 (推荐)
}

// 布尔变量: is/has/can/should 前缀
const isConnected = true;
const hasPermission = false;
const canWrite = true;
const shouldRetry = false;
```

#### 代码组织规范

```typescript
// 文件结构顺序
// 1. 导入语句 (按类型分组)
import * as vscode from 'vscode';           // VS Code API
import * as path from 'node:path';          // Node.js 内置
import { DeviceAdapter } from './adapter';  // 本地模块

// 2. 类型定义
interface Options { ... }
type Result = Success | Failure;

// 3. 常量
const DEFAULT_TIMEOUT = 5000;

// 4. 类/函数定义
export class SessionManager { ... }

// 5. 导出
export { SessionManager, Options };
```

#### 错误处理规范

```typescript
// 定义领域错误类
class DeviceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'DeviceError';
  }
}

// 使用 Result 类型 (可选)
type Result<T, E = Error> = 
  | { success: true; value: T }
  | { success: false; error: E };

// 错误边界: 在模块边界处理错误
export async function publicApi(): Promise<Result<Data>> {
  try {
    const result = await internalOperation();
    return { success: true, value: result };
  } catch (error) {
    // 转换为领域错误
    if (error instanceof InternalError) {
      return { 
        success: false, 
        error: new DeviceError('Operation failed', 'DEVICE_ERROR', error)
      };
    }
    // 未知错误重新抛出
    throw error;
  }
}
```

### 7.6 性能 (Performance)

#### 原则
1. **测量优先**: 先测量，后优化
2. **热路径优化**: 只优化频繁执行的代码
3. **避免过早优化**: 除非有明确的性能问题
4. **资源意识**: 注意内存和连接泄漏

#### 实践
```typescript
// ❌ 不好的做法: 过早优化
function processFiles(files: string[]) {
  // 预分配数组 - 除非处理百万级数据，否则不需要
  const result = new Array(files.length);
  for (let i = 0; i < files.length; i++) {
    result[i] = process(files[i]);
  }
  return result;
}

// ✅ 好的做法: 清晰优先
function processFiles(files: string[]): ProcessedFile[] {
  return files.map(file => process(file));
}

// ✅ 好的做法: 必要时才优化
async function uploadLargeFile(path: string, content: Uint8Array): Promise<void> {
  // 大文件分块上传，避免内存峰值
  const CHUNK_SIZE = 4096;
  
  for (let offset = 0; offset < content.length; offset += CHUNK_SIZE) {
    const chunk = content.slice(offset, offset + CHUNK_SIZE);
    await this.uploadChunk(path, chunk, offset);
    
    // 报告进度
    this.emit('progress', { offset, total: content.length });
  }
}
```

### 7.7 代码审查清单

每次提交前检查:

- [ ] 所有公共 API 都有 JSDoc 注释
- [ ] 错误情况都有适当处理
- [ ] 没有硬编码的魔法数字
- [ ] 日志级别使用正确
- [ ] 资源（连接、文件句柄）正确释放
- [ ] 异步操作有超时机制
- [ ] 类型定义完整，没有 `any`
- [ ] 测试覆盖关键路径
- [ ] 变量/函数命名清晰

---

## 附录 A: 文件变更总结

### 需要删除的文件
```
src/board/mpremote.ts          (2026行)
src/board/mpremoteCommands.ts  (705行)
src/board/MpRemoteManager.ts   (260行)
src/commands/mpremoteCommands.ts (171行)
----------------------------------------
总计删除: 3162行
```

### 需要新建的文件
```
src/utils/pathMapping.ts       (~100行)
src/cache/fileTreeCache.ts     (~200行)
src/terminal/replCommands.ts   (~200行)
src/terminal/runCommands.ts    (~150行)
src/device/robustInterrupt.ts  (~100行)
----------------------------------------
总计新增: ~750行
```

### 需要修改的文件
```
src/core/extension.ts          (移除旧导入，添加新导入)
src/board/boardOperations.ts   (替换 mp.* 调用)
src/sync/syncOperations.ts     (替换 mp.* 调用)
src/core/utilityOperations.ts  (替换 mp 动态导入)
src/python/pythonInterpreter.ts (移除 MpRemoteManager)
src/board/deviceAdapter.ts     (添加新方法)
src/board/deviceAdapterImpl.ts (实现新方法)
tests/pathMapping.test.ts      (更新测试)
----------------------------------------
总计修改: 8个文件
```

---

## 附录 B: 回滚策略

如果迁移出现严重问题，需要回滚:

1. **Git 标签**: 在开始迁移前创建标签 `pre-mpremote-removal`
2. **配置开关**: 添加 `microPythonWorkBench.useLegacyBackend` 配置
3. **兼容层**: 保留旧代码但禁用，通过配置开关启用
4. **渐进式迁移**: 分阶段发布，每阶段独立可回滚

```typescript
// 回滚开关示例
const useLegacy = vscode.workspace
  .getConfiguration('microPythonWorkBench')
  .get<boolean>('useLegacyBackend', false);

if (useLegacy) {
  // 使用旧的 mpremote 实现
  return await mp.ls(path);
} else {
  // 使用新的 DeviceAdapter
  return await adapter.ls(path);
}
```

---

**文档完成日期**: 2025-01-XX  
**作者**: GitHub Copilot  
**审核状态**: 待审核
