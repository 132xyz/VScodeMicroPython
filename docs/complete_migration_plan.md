# MicroPython WorkBench 完整迁移计划

## 文档信息

| 项目 | 内容 |
|------|------|
| 版本 | v1.0 |
| 日期 | 2026-01-20 |
| 状态 | 执行阶段 |
| 目标 | 完全移除 mpremote 依赖，使用新的 mpy_backend |

---

## 第一部分：现状分析

### 1.1 待移除的旧模块

| 文件 | 行数 | 职责 | 替代方案 |
|------|------|------|----------|
| `src/board/mpremote.ts` | 2026 | 核心设备通信 | DeviceAdapterImpl |
| `src/board/mpremoteCommands.ts` | 705 | REPL终端管理 | 新 replTerminal 模块 |
| `src/board/MpRemoteManager.ts` | 260 | Python进程管理 | mpy_backend + BackendProcess |
| `src/board/mpremoteOperations.ts` | ~100 | 占位符模块 | 删除 |
| `src/commands/mpremoteCommands.ts` | 171 | 命令导出 | pythonDetector |

### 1.2 依赖 mpremote 的文件

| 文件 | 依赖类型 | 迁移复杂度 |
|------|----------|-----------|
| `src/core/extension.ts` | 全部类型 | 高 |
| `src/board/boardOperations.ts` | 文件操作+会话管理 | 高 |
| `src/board/esp32Fs.ts` | 目录列表 | 低 |
| `src/commands/fileCommands.ts` | 文件操作+路径映射 | 中 |
| `src/commands/syncCommands.ts` | 文件操作 | 中 |
| `src/commands/boardCommands.ts` | 设备控制 | 低 |
| `src/commands/replCommands.ts` | REPL操作 | 中 |
| `src/commands/debugCommands.ts` | 缓存/调试 | 低 |
| `src/core/utilityOperations.ts` | 缓存操作 | 低 |
| `src/python/pythonInterpreter.ts` | Python路径 | 低 |

### 1.3 已完成的新模块

| 文件 | 职责 | 状态 |
|------|------|------|
| `src/utils/pathMapping.ts` | 路径映射 | ✅ 已完成 |
| `src/cache/fileTreeCache.ts` | 文件树缓存 | ✅ 已完成 |
| `src/board/deviceAdapter.ts` | 设备适配器接口 | ✅ 已完成 |
| `src/board/deviceAdapterImpl.ts` | 设备适配器实现 | ✅ 已完成 |
| `src/backend/BackendProcess.ts` | 后端进程管理 | ✅ 已完成 |
| `src/backend/IPCClient.ts` | IPC通信 | ✅ 已完成 |
| `src/session/SessionManager.ts` | 会话管理 | ✅ 已完成 |
| `src/session/DeviceSession.ts` | 设备会话 | ✅ 已完成 |
| `src/terminal/MpyPseudoterminal.ts` | 虚拟终端 | ✅ 已完成 |

---

## 第二部分：迁移映射表

### 2.1 文件操作函数映射

| 旧函数 (mpremote.ts) | 新函数 (DeviceAdapter) | 状态 |
|---------------------|----------------------|------|
| `mp.ls(path)` | `deviceAdapter.ls(path)` | ✅ 已实现 |
| `mp.lsTyped(path)` | `deviceAdapter.lsTyped(path)` | ✅ 已实现 |
| `mp.mkdir(path)` | `deviceAdapter.mkdir(path)` | ✅ 已实现 |
| `mp.cpFromDevice(src, dst)` | `deviceAdapter.cpFromDevice(src, dst)` | ✅ 已实现 |
| `mp.cpToDevice(src, dst)` | `deviceAdapter.cpToDevice(src, dst)` | ✅ 已实现 |
| `mp.deleteFile(path)` | `deviceAdapter.deleteFile(path)` | ✅ 已实现 |
| `mp.deleteAny(path)` | `deviceAdapter.deleteAny(path)` | ✅ 已实现 |
| `mp.deleteDirectory(path)` | `deviceAdapter.deleteDirectory(path)` | ✅ 已实现 |
| `mp.fileExists(path)` | `deviceAdapter.fileExists(path)` | ✅ 已实现 |
| `mp.readFile(path)` | `deviceAdapter.readFile(path)` | ✅ 已实现 |
| `mp.writeFile(path, content)` | `deviceAdapter.writeFile(path, content)` | ✅ 已实现 |
| `mp.rename(src, dst)` | `deviceAdapter.rename(src, dst)` | ✅ 已实现 |
| `mp.mv(src, dst)` | `deviceAdapter.mv(src, dst)` | ✅ 已实现 |
| `mp.mvOnDevice(src, dst)` | `deviceAdapter.mvOnDevice(src, dst)` | ✅ 已实现 |
| `mp.stat(path)` | `deviceAdapter.stat(path)` | ✅ 已实现 |
| `mp.listTreeStats(root)` | `deviceAdapter.listTreeStats(root)` | ✅ 已实现 |
| `mp.getBoardFilesAndSizes(root)` | `deviceAdapter.getBoardFilesAndSizes(root)` | ✅ 已实现 |
| `mp.uploadReplacing(src, dst)` | `deviceAdapter.uploadReplacing(src, dst)` | ✅ 已实现 |
| `mp.deleteAllInPath(root)` | `deviceAdapter.deleteAllInPath(root)` | ✅ 已实现 |

### 2.2 设备控制函数映射

| 旧函数 | 新函数 | 状态 |
|-------|-------|------|
| `mp.reset()` | `deviceAdapter.reset()` | ✅ 已实现 |
| `mp.healthCheck(port)` | `deviceAdapter.healthCheck(port)` | ✅ 已实现 |
| `mp.detectBoardInfo()` | `deviceAdapter.detectBoardInfo()` | ✅ 已实现 |
| `mp.listSerialPorts()` | `deviceAdapter.listSerialPorts()` | ✅ 已实现 |
| `mp.interrupt()` | `deviceAdapter.interrupt()` | ✅ 已实现 |
| `mp.execute(code)` | `deviceAdapter.execute(code)` | ✅ 已实现 |

### 2.3 路径映射函数映射

| 旧位置 | 新位置 | 状态 |
|-------|-------|------|
| `mpremote.toDevicePath()` | `pathMapping.toDevicePath()` | ✅ 已实现 |
| `mpremote.toLocalRelative()` | `pathMapping.toLocalRelative()` | ✅ 已实现 |
| `mpremote.getEffectiveDeviceRootSync()` | `pathMapping.getEffectiveDeviceRoot()` | ✅ 已实现 |
| `mpremoteCommands.toDevicePath()` | `pathMapping.toDevicePath()` | ✅ 已实现 |
| `mpremoteCommands.toLocalRelative()` | `pathMapping.toLocalRelative()` | ✅ 已实现 |

### 2.4 缓存操作函数映射

| 旧函数 | 新函数 | 状态 |
|-------|-------|------|
| `mp.clearFileTreeCache()` | `fileTreeCache.clear()` | ✅ 已实现 |
| `mp.refreshFileTreeCache()` | `fileTreeCache.refresh(deviceAdapter)` | ✅ 已实现 |
| `mp.debugTreeParsing()` | 内联到 debugCommands | 待迁移 |
| `mp.debugFilesystemStatus()` | 内联到 debugCommands | 待迁移 |

### 2.5 REPL/终端操作映射

| 旧函数 (mpremoteCommands.ts) | 新实现 | 状态 |
|----------------------------|--------|------|
| `getReplTerminal()` | `ReplTerminalManager.getTerminal()` | 待创建 |
| `openReplTerminal()` | `ReplTerminalManager.open()` | 待创建 |
| `closeReplTerminal()` | `ReplTerminalManager.close()` | 待创建 |
| `isReplOpen()` | `ReplTerminalManager.isOpen()` | 待创建 |
| `disconnectReplTerminal()` | `ReplTerminalManager.disconnect()` | 待创建 |
| `serialSendCtrlC()` | `deviceAdapter.interrupt()` | ✅ 可复用 |
| `stop()` | `deviceAdapter.interrupt()` | ✅ 可复用 |
| `softReset()` | `deviceAdapter.reset()` | ✅ 可复用 |
| `runActiveFile()` | `ReplTerminalManager.runFile()` | 待创建 |

### 2.6 会话管理映射

| 旧函数 | 新实现 | 状态 |
|-------|-------|------|
| `suspendSerialSessionsForAutoSync()` | `syncSessionManager.suspend()` | ✅ 已实现 |
| `restoreSerialSessionsFromSnapshot()` | `syncSessionManager.restore()` | ✅ 已实现 |

---

## 第三部分：详细迁移步骤

### 阶段 1: 创建 REPL 终端管理器 (关键)

需要创建新的 REPL 终端管理模块替代 mpremoteCommands.ts：

```
src/terminal/
├── ReplTerminalManager.ts    # REPL 终端生命周期管理
├── MpyPseudoterminal.ts      # ✅ 已存在 - 虚拟终端实现
└── index.ts                  # 模块导出
```

**ReplTerminalManager 需要实现的功能：**
1. 创建使用 Pseudoterminal 的 REPL 终端
2. 管理终端状态（打开/关闭/暂停）
3. 与 DeviceSession 集成
4. 支持中断和重置操作
5. 支持运行文件功能

### 阶段 2: 更新 extension.ts

替换所有 mpremote 导入和使用：

```typescript
// 旧导入
import * as mp from "../board/mpremote";
import { ... } from "../board/mpremoteCommands";
import { mpremoteCommands } from "../commands/mpremoteCommands";

// 新导入
import { getDeviceAdapter } from "../board/deviceAdapter";
import { fileTreeCache } from "../cache/fileTreeCache";
import { toDevicePath, toLocalRelative } from "../utils/pathMapping";
import { ReplTerminalManager } from "../terminal/ReplTerminalManager";
import { syncSessionManager } from "../board/syncSessionManager";
```

### 阶段 3: 更新命令模块

按顺序更新以下文件：

1. **boardCommands.ts** - 替换 `mp.listSerialPorts()`, `mp.detectBoardInfo()`
2. **fileCommands.ts** - 替换文件操作和路径映射
3. **syncCommands.ts** - 替换文件操作
4. **replCommands.ts** - 使用新的 ReplTerminalManager
5. **debugCommands.ts** - 内联调试功能

### 阶段 4: 更新业务模块

1. **boardOperations.ts** - 最复杂，需要完全重写文件操作逻辑
2. **esp32Fs.ts** - 替换 `mp.lsTyped()` 为 `deviceAdapter.lsTyped()`
3. **utilityOperations.ts** - 替换缓存刷新

### 阶段 5: 删除旧模块

确认无引用后删除：
1. `src/board/mpremote.ts`
2. `src/board/mpremoteCommands.ts`
3. `src/board/MpRemoteManager.ts`
4. `src/board/mpremoteOperations.ts`
5. `src/commands/mpremoteCommands.ts`

---

## 第四部分：执行清单

### ☐ 任务 1: 创建 ReplTerminalManager

**文件**: `src/terminal/ReplTerminalManager.ts`

**功能要求**:
- [ ] 使用 MpyPseudoterminal 创建终端
- [ ] 与 SessionManager 集成获取会话
- [ ] 实现 open/close/isOpen/disconnect 方法
- [ ] 实现 runFile 方法
- [ ] 支持 suspend/restore 用于自动同步

### ☐ 任务 2: 创建 pythonDetector 模块

**文件**: `src/python/pythonDetector.ts`

**功能要求**:
- [ ] 检测 Python 路径
- [ ] 验证 mpy_backend 可用性
- [ ] 替代 MpRemoteManager 的 Python 检测功能

### ☐ 任务 3: 更新 extension.ts

**需要修改的内容**:
- [ ] 替换 `import * as mp from "../board/mpremote"`
- [ ] 替换 `import { ... } from "../board/mpremoteCommands"`
- [ ] 替换 `import { mpremoteCommands } from "../commands/mpremoteCommands"`
- [ ] 替换所有 `mp.*` 调用
- [ ] 替换 REPL 终端相关调用
- [ ] 替换会话管理调用

### ☐ 任务 4: 更新 boardOperations.ts

**需要修改的内容**:
- [ ] 替换 `import * as mp from "./mpremote"`
- [ ] 替换会话管理导入
- [ ] 替换所有 `mp.*` 调用 (约 22 处)
- [ ] 更新 toDevicePath/toLocalRelative 调用

### ☐ 任务 5: 更新 esp32Fs.ts

**需要修改的内容**:
- [ ] 替换 `import * as mp from "./mpremote"`
- [ ] 替换 `mp.lsTyped()` 调用

### ☐ 任务 6: 更新 fileCommands.ts

**需要修改的内容**:
- [ ] 替换 mpremote 导入
- [ ] 替换路径映射导入
- [ ] 替换所有 `mp.*` 调用 (约 5 处)

### ☐ 任务 7: 更新 syncCommands.ts

**需要修改的内容**:
- [ ] 替换 mpremote 导入
- [ ] 替换所有 `mp.*` 调用 (约 4 处)

### ☐ 任务 8: 更新 boardCommands.ts

**需要修改的内容**:
- [ ] 替换 mpremote 导入
- [ ] 替换 `mp.listSerialPorts()` 和 `mp.detectBoardInfo()`

### ☐ 任务 9: 更新 replCommands.ts

**需要修改的内容**:
- [ ] 替换 mpremoteCommands 导入
- [ ] 使用 ReplTerminalManager

### ☐ 任务 10: 更新 debugCommands.ts

**需要修改的内容**:
- [ ] 替换缓存相关导入
- [ ] 内联调试功能或使用 DeviceAdapter

### ☐ 任务 11: 更新 utilityOperations.ts

**需要修改的内容**:
- [ ] 替换动态 mpremote 导入
- [ ] 使用 fileTreeCache

### ☐ 任务 12: 更新 pythonInterpreter.ts

**需要修改的内容**:
- [ ] 替换 MpRemoteManager 导入
- [ ] 使用新的 pythonDetector

### ☐ 任务 13: 删除旧模块

- [ ] 删除 `src/board/mpremote.ts`
- [ ] 删除 `src/board/mpremoteCommands.ts`
- [ ] 删除 `src/board/MpRemoteManager.ts`
- [ ] 删除 `src/board/mpremoteOperations.ts`
- [ ] 删除 `src/commands/mpremoteCommands.ts`

### ☐ 任务 14: 编译验证

- [ ] 运行 `npm run compile`
- [ ] 修复所有 TypeScript 错误

### ☐ 任务 15: 测试更新

- [ ] 更新 pathMapping 测试
- [ ] 更新其他相关测试
- [ ] 运行完整测试套件

---

## 第五部分：风险和注意事项

### 5.1 高风险区域

1. **REPL 终端管理** - mpremoteCommands.ts 中有复杂的终端状态管理逻辑
2. **会话暂停/恢复** - 需要确保自动同步期间正确处理终端状态
3. **运行文件功能** - 需要在新架构中重新实现

### 5.2 向后兼容性

- 保持所有命令 ID 不变
- 保持配置项名称不变
- 保持文件同步行为不变

### 5.3 测试策略

1. 单元测试: 路径映射、缓存操作
2. 集成测试: 设备连接、文件操作
3. E2E 测试: REPL 使用、文件同步、运行文件

---

## 附录：代码示例

### A.1 ReplTerminalManager 基本结构

```typescript
import * as vscode from "vscode";
import { MpyPseudoterminal } from "./MpyPseudoterminal";
import { getSessionManager, DeviceSession } from "../session";

export class ReplTerminalManager {
    private static instance: ReplTerminalManager | null = null;
    private terminal: vscode.Terminal | null = null;
    private pseudoterminal: MpyPseudoterminal | null = null;
    private session: DeviceSession | null = null;

    private constructor() {}

    public static getInstance(): ReplTerminalManager {
        if (!ReplTerminalManager.instance) {
            ReplTerminalManager.instance = new ReplTerminalManager();
        }
        return ReplTerminalManager.instance;
    }

    public async open(port: string): Promise<vscode.Terminal> {
        // 创建或获取终端
    }

    public async close(force = false): Promise<void> {
        // 关闭终端
    }

    public isOpen(): boolean {
        return this.terminal !== null && this.pseudoterminal !== null;
    }

    public async runFile(filePath: string): Promise<void> {
        // 运行文件
    }

    public suspend(): SessionSnapshot {
        // 暂停会话
    }

    public async restore(snapshot: SessionSnapshot): Promise<void> {
        // 恢复会话
    }
}
```

### A.2 更新后的 extension.ts 导入示例

```typescript
// 新的导入结构
import * as vscode from "vscode";
import { Esp32Tree } from "../board/esp32Fs";
import { ActionsTree } from "./actions";
import { SyncTree } from "../sync/syncView";
import { Esp32Node } from "./types";

// 新模块导入
import { getDeviceAdapter, DeviceAdapter } from "../board/deviceAdapter";
import { fileTreeCache, refreshFileTreeCache, clearFileTreeCache } from "../cache/fileTreeCache";
import { toDevicePath, toLocalRelative, getEffectiveDeviceRoot } from "../utils/pathMapping";
import { ReplTerminalManager } from "../terminal/ReplTerminalManager";
import { syncSessionManager } from "../board/syncSessionManager";
import { detectPython, isPythonAvailable } from "../python/pythonDetector";

// 标准库导入
import * as path from "node:path";
import * as fs from "node:fs/promises";
// ...
```
