# VScodeMicroPython 串口统一管理实施计划

生成时间: 2026-06-20 19:09:19
版本: v1

## 1. 目标与边界

主要目标:

- 修复点击关闭串口后 REPL 实际仍持有 COM 口的问题,避免后续文件列表、删除、上传等操作出现 `PermissionError(13, '拒绝访问。')`.
- 梳理并逐步收敛当前扩展里的串口所有权,使 REPL、文件系统操作、运行文件、interrupt、soft reset 尽量通过同一个串口 owner 执行.
- 参考 Thonny 的 backend 模型,设计适合 VS Code 扩展的串口 manager 方案.

本次非目标:

- 不重写整个扩展 UI.
- 不直接引入 Thonny 或 minny 作为依赖.
- 不在第一阶段改变已验证可用的 `scripts/mpyrepl` 文件传输协议,除非为了 manager 接入做必要封装.
- 不扩大到 WebREPL、多板同时调试等功能,除非用户确认需要.

成功标准:

- 用户点击 Close Serial 后,扩展能确认 REPL backend 已退出或至少确认 COM 口释放.
- 有 REPL 打开时,文件操作不再另起进程抢同一个 COM 口.
- control channel 失效、backend 残留、操作取消等异常状态可被识别和恢复.
- TypeScript 测试通过,Python 测试使用 `E:\xm\github\.conda\python.exe` 运行且本地覆盖率保持 80% 以上.

## 2. 项目现状

相关目录与文件:

- `src/board/mpremoteCommands.ts`: 当前 REPL terminal、run terminal、auto suspend/restore、open/close serial 的核心状态在这里.
- `src/board/mpyClient.ts`: 文件系统操作统一入口,当前优先走 custom REPL control file,失败或不存在时回退到临时 helper 进程.
- `src/board/customReplControl.ts`: extension 侧基于临时 JSON 文件的 RPC/control channel.
- `scripts/mpyrepl/__main__.py`: `async-repl` 已经持有 `SerialReplTransport`,并通过 `SerialOperationGate` 串行处理 `exec/fs/interrupt/soft-reset/exit`.
- `scripts/mpyrepl/control.py`: Python 侧 control file 轮询解析.
- `src/commands/fileCommands.ts`, `src/commands/uploadToBoard.ts`, `src/board/boardOperations.ts`, `src/commands/syncCommands.ts`, `src/sync/activeFileSync.ts`: 大量操作仍使用 `suspendSerialSessionsForAutoSync` 关闭/恢复 REPL,这是当前冲突模型的主要来源.
- `src/core/actions.ts`, `src/core/extension.ts`: action view 和命令注册,需要保持 UI 状态与真实 manager 状态一致.

当前串口所有权:

- REPL 打开时,VS Code Terminal 内运行 `scripts/mpyrepl/__main__.py ... async-repl`,由该 Python 进程持有串口.
- 文件操作如果检测到 custom control file 存在,会通过 `requestCustomReplRpc(..., "fs", ...)` 交给 `async-repl`.
- 文件操作如果 control file 不存在或 RPC 出错,会回退到 `mpyrepl fs` 临时 helper,该 helper 会再次打开同一个 COM 口.
- `closeReplTerminal()` 目前主要调用 `replTerminal.dispose()`,随后清理 control file 和本地状态.如果 Terminal 内 Python 进程没有真正退出,扩展会丢失对残留进程的控制,但 COM 口仍被残留进程占用.

Thonny 对照结论:

- Thonny 的 MicroPython 前端启动一个 backend 进程,launcher 在 `bare_metal_backend.py` 中创建 `SerialConnection`,并交给 `BareMetalTargetManager`.
- REPL 输入、interrupt、文件上传、删除、目录列表等都通过同一个 backend 命令队列和 target manager 执行.
- 文件写入入口 `_write_file()` 调用 `self._tmgr.write_file_ex(...)`,读取入口 `_read_file()` 调用 `self._tmgr.read_file_ex(...)`;这些操作没有另起一个抢串口的进程.
- 当前本机仓库未包含 Thonny 依赖的 sibling `minny`,因此不能确认 `write_file_ex/read_file_ex` 的底层 chunk 和协议实现,但可确认它的架构核心是“单 backend 拥有连接”.

## 3. 需求与疑问

已确认需求:

- Close Serial 必须实际关闭串口,不能只更新 VS Code UI 状态.
- 串口管理需要统一,否则 REPL 与文件操作会反复抢 COM 口.
- 体验优先,可以大胆改,但要保持代码可维护、可读、合理拆分.

关键假设:

- 当前 `async-repl` 可以作为串口 manager 的第一阶段基础,因为它已支持 `exec/fs/interrupt/soft-reset/exit` 并有操作 gate.
- 用户可以接受逐步迁移,先修复 close 泄漏,再消除 auto-suspend 模型.
- 在同一块板子上,长文件操作期间 interactive REPL 输入需要排队或提示 busy,不能并发写串口.

需要用户确认的问题:

- 是否接受把 REPL 从普通 OS shell terminal 改成 VS Code `Pseudoterminal`,由扩展直接 spawn Python backend 并持有 `ChildProcess` 句柄?
- 是否需要支持多个串口/多个板子同时打开?如果需要,manager 应以 port 为 key 管理多个实例.
- 长文件传输期间,REPL 输入是直接排队、显示 busy,还是允许用户取消当前传输后执行输入?
- `Run Active File` 是否也必须走同一个 manager,还是可以保留独立 run terminal 但必须先关闭 manager?

## 4. 方案设计

### 方案 A: 短期止血,修复 close 和 stale control file

思路:

- `closeReplTerminal(userInitiated)` 在 dispose terminal 前,如果 custom REPL active,必须先发送 `exit`,等待 control file 被 Python 侧 `control_channel.clear()` 删除或等待 terminal close 事件.
- 在退出确认前不要删除 control file 和 reset 状态,避免扩展失去对仍存活 backend 的控制.
- 增加 port release 探测或至少 backend 状态探测.如果超时仍未释放,提示用户 backend 未退出并保留可恢复信息.
- `mpyClient.runFs()` 回退 helper 前,应判断是否存在“本扩展认为 REPL terminal 仍活着或 manager 正在关闭”的状态.如果存在,不能直接启动 helper 抢口.

优点:

- 改动最小,能直接修复当前 Close Serial 后 COM21 被残留进程占用的问题.
- 不改变用户现有 terminal 使用体验.

缺点:

- 仍依赖 VS Code Terminal 生命周期和 file control polling,不是最终架构.

### 方案 B: 以现有 async-repl 为 manager,减少抢口

思路:

- 把 `async-repl` 视为“当前 port 的 serial manager”.
- 只要 manager running,所有 `list/read/write/remove/rename/mkdir/exec/interrupt/soft-reset` 都走 manager RPC.
- auto-suspend 不再默认关闭 REPL,文件操作直接走 manager gate.
- 临时 helper 只在 manager 不存在且 port 空闲时使用.
- 增加 manager 状态 API: `ping/status/close/cancel/currentOperation`.

推荐新增模块:

- `src/board/serialManager.ts`: TypeScript 侧 manager 生命周期、状态、关闭、恢复、port keyed registry.
- `src/board/serialManagerClient.ts`: RPC 请求、进度、取消、超时处理.
- `src/board/serialManagerTerminal.ts`: terminal/pseudoterminal 绑定,隔离 UI 表现与 backend 生命周期.

Python 侧:

- `scripts/mpyrepl/manager.py`: 从 `__main__.py` 拆出 manager 主循环,避免 `__main__.py` 继续变大.
- `scripts/mpyrepl/manager_protocol.py`: control/RPC payload 类型和响应格式.
- `scripts/mpyrepl/control.py`: 保留 file-control 兼容,后续可替换为 named pipe/stdin JSON-RPC.

### 方案 C: Thonny 式 backend process + Pseudoterminal

思路:

- 扩展直接 `spawn()` Python backend,持有 `ChildProcess`.
- backend 长期持有串口,用 stdin/stdout 或 named pipe 做结构化 JSON-RPC.
- VS Code Terminal 改为 `Pseudoterminal`,用户看到的 REPL 输入输出由 extension 与 backend 转发.
- 关闭串口时先发 `close`,等待 child `exit`,必要时 kill child,最后确认 port release.

优点:

- 串口所有权清晰,最接近 Thonny.
- 扩展可以可靠取消、关闭、检测 backend,不再依赖 OS shell terminal 是否杀掉子进程.
- 后续补全、文件操作、运行、状态栏都能通过同一 backend 复用运行时状态.

缺点:

- 改动大,需要较完整测试.
- Pseudoterminal 行为要处理好输入编辑、Ctrl-C/Ctrl-D、颜色输出和编码.

推荐路线:

1. 先做方案 A,解决当前用户可见 bug.
2. 再做方案 B,把现有 `async-repl` 正式收敛成 manager.
3. 最后做方案 C,替换 terminal-hosted manager 为 extension-owned backend process.

## 5. 文件级任务

第一阶段预计修改:

- `src/board/mpremoteCommands.ts`: 改造 `closeReplTerminal`,增加 graceful close、等待退出、状态不提前清理;整理 `stop/stopSerial/Close Serial` 语义.
- `src/board/mpyClient.ts`: 在 helper fallback 前增加 manager/REPL 状态约束,避免 control channel 异常时直接抢口.
- `src/board/customReplControl.ts`: 增加 `ping/status/close` 或至少封装 request/response 生命周期,减少散落状态判断.
- `scripts/mpyrepl/__main__.py`: 为 `exit` 或新增 `status` 提供可确认响应;如需拆分,新增 `scripts/mpyrepl/manager.py`.
- `tests/...`: 增加 close 行为、fallback 阻止、control file stale、RPC timeout/cancel 的单元测试.

第二阶段预计修改:

- 新增 `src/board/serialManager.ts`.
- 新增 `src/board/serialManagerClient.ts`.
- 迁移 `src/commands/fileCommands.ts`, `src/commands/uploadToBoard.ts`, `src/board/boardOperations.ts`, `src/commands/syncCommands.ts`, `src/sync/activeFileSync.ts` 中的 auto-suspend 文件操作.
- 更新 `src/core/actions.ts` 和 `src/core/extension.ts` 的状态刷新逻辑,以 manager 状态为准.

不应修改:

- 不修改与本需求无关的补全 parser、stub 生成、语言包内容.
- 不修改 `build.ps1` 的版本策略.
- 不修改用户工作区 `mpy/lib/*.py` 示例文件.

## 6. 分阶段执行

阶段 1: Close Serial 可靠退出

- 任务: `closeReplTerminal()` 先发 custom `exit`,等待 backend 删除 control file/terminal close/port release,再 dispose terminal 和 reset 状态.
- 文件: `src/board/mpremoteCommands.ts`,必要时 `scripts/mpyrepl/__main__.py`.
- 验证: 打开 REPL 后 Close Serial,随后执行 list/delete/upload 不应出现 `PermissionError`.
- 完成标准: 单元测试覆盖 custom close,手测或设备测试确认 COM21 释放.

阶段 2: 禁止危险 helper fallback

- 任务: `mpyClient.runFs()` 在疑似 manager 存活或 closing 状态时不回退 helper,而是报明确 busy/stale manager 错误或尝试恢复 control channel.
- 文件: `src/board/mpyClient.ts`,可能新增 `src/board/serialManagerState.ts`.
- 验证: 模拟 control file 缺失但 REPL terminal alive,不能 spawn helper.
- 完成标准: 不再出现“扩展认为关了,实际 helper 抢口失败”的路径.

阶段 3: 文件操作不再 auto-suspend REPL

- 任务: 有 manager 时,文件操作直接走 manager RPC;没有 manager 时,再使用 helper.
- 文件: `src/commands/fileCommands.ts`, `src/commands/uploadToBoard.ts`, `src/board/boardOperations.ts`, `src/commands/syncCommands.ts`, `src/sync/activeFileSync.ts`.
- 验证: REPL 打开时删除/上传/打开文件不关闭 REPL,操作完成后 REPL 仍可用.
- 完成标准: auto-suspend 只用于 legacy fallback 或完全删除.

阶段 4: extension-owned backend

- 任务: 用 `spawn()` 管理 Python backend,terminal 改为 Pseudoterminal 或至少记录 child process pid/exit.
- 文件: 新增 manager 模块,调整 `mpremoteCommands.ts`.
- 验证: 关闭串口能 await child exit;强制关闭能 kill child tree;VS Code terminal close 也释放 port.
- 完成标准: 串口 owner 只有一个,生命周期由 extension 显式管理.

## 7. 验证计划

TypeScript:

```powershell
npm test -- --runInBand
```

Python:

```powershell
& E:\xm\github\.conda\python.exe scripts\mpyrepl\run_python_tests_with_coverage.py
```

格式/构建:

```powershell
git diff --check
```

注意: 不要为了普通验证直接运行 `build.ps1`,因为它会 bump package version.只有用户明确要求打包时再运行.

设备验证建议:

- 打开 REPL,执行 Close Serial,立即刷新 `/lib` 或删除文件,确认无 `PermissionError`.
- 打开 REPL,上传大文件,中途取消,确认 `.mpyupload` 临时文件按预期清理,REPL 状态正确.
- 打开 REPL,删除文件,确认不会因为 REPL 占口失败.
- 连续 open/close/open 10 次,确认没有残留 Python 进程持有 COM 口.

## 8. 风险与注意事项

- VS Code Terminal 的 `dispose()` 不等价于可靠杀掉内部 Python 子进程,不能把 UI terminal 状态当作串口释放证明.
- control file 是弱协议: 文件被删、写入半截、进程残留、sequence 重置都会造成状态漂移.短期可加确认,长期应换成有连接语义的 RPC 通道.
- 传输/文件操作期间必须串行化同一 port 的操作,否则 raw REPL 协议会互相污染.
- 取消大文件传输需要 backend 和设备端清理临时文件,仅 kill host helper 不够.
- 串口释放探测在 Windows 上可能有短延迟,测试里应允许短暂等待,但 UI 应显示明确状态.
- 如果引入 Pseudoterminal,需要单独验证中文输出、ANSI 颜色、Ctrl-C/Ctrl-D、粘贴多行、补全交互.

## 9. 当前结论

当前问题不是单个按钮显示错误,而是串口 owner 模型不稳定.最小修复应先保证 Close Serial 是一次有确认的 backend shutdown,不要提前删除 control file.长期应把 `async-repl` 提升为正式 serial manager,并让文件操作、REPL、运行、补全查询共用同一个 manager 队列.

当前仅完成计划,尚未开始编码,需用户确认后再实施.
