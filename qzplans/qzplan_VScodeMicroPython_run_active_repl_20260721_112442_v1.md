# Run Active File 与 REPL 状态修复计划

## 1. 目标与边界

### 目标

- 阻止 VS Code Python 扩展向 MicroPython REPL 注入 PowerShell 虚拟环境激活命令.
- 让 `Run Active File` 通过当前 REPL 客户端发起执行,运行时退出 `>>>` 输入状态,结束或中断后再返回 REPL 提示符.
- 运行文件时保留原始源码,不应用仅面向交互表达式回显的 AST 改写.
- 保持隐藏 serial manager 独占物理串口,不引入第二个串口连接.

### 非目标

- 不关闭工作区全局的 `python.terminal.activateEnvironment` 设置.
- 不恢复旧 mpremote 运行终端或旧 control-file 通道.
- 不改动文件同步、上传下载和代码补全协议.

### 成功标准

- 新建或重新打开 `ESP32 REPL` 时,终端中不再出现 `Set-ExecutionPolicy` 或 `Activate.ps1`.
- 点击运行后,REPL 客户端显示正在运行的文件,运行期间没有可误输入的 `>>>`,结束后恢复 `>>>`.
- Ctrl+C 仍通过 manager 的带外中断终止板端脚本.
- 连续运行两个文件时,第二次运行不会把主机 shell 命令发送给 MicroPython.

## 2. 项目现状

- `src/board/mpremoteCommands.ts` 创建可见 PowerShell 终端,Python 扩展会监听终端创建并自动发送虚拟环境激活命令.
- 当前安装的 Python 扩展 `2026.4.0` 明确跳过 `creationOptions.hideFromUser === true` 的终端自动激活;终端随后仍可由本扩展主动 `show()`.
- `runActiveFileInCustomRepl()` 当前绕过终端 REPL 客户端,直接用 TypeScript manager client 调用 `repl.exec`.因此 REPL 客户端仍停留在 `>>>`,运行状态与实际设备状态不一致.
- `ManagerSession.execute()` 对所有源码调用 `instrument_source()`.该逻辑适合交互表达式回显,不应改写完整文件.

## 3. 需求、假设与风险

- 已确认日志中的 `(Set-ExecutionPolicy ... Activate.ps1)` 来自主机 Python 扩展,不是用户脚本.
- 假设活动文件由本机 REPL 客户端按 UTF-8 读取;这与扩展当前读取方式一致.
- 特殊运行命令使用扩展保留前缀并以 JSON 字符串携带本地绝对路径,避免空格、中文和反斜杠解析问题.
- 风险是终端启动与运行命令发送存在时序关系.依赖 VS Code `Terminal.sendText()` 的顺序队列,先启动 REPL 客户端,再发送运行命令.

## 4. 方案设计

1. 创建 REPL/Run 终端时设置 `hideFromUser: true`,创建完成后仍由现有调用点执行 `show()`.这仅用于阻止其他扩展对专用终端自动注入命令.
2. 在 REPL 客户端增加内部命令 `:mpy-run-file <json-path>`:
   - 解析 JSON 路径并读取 UTF-8 源码.
   - 在终端打印清晰的运行状态.
   - 调用 manager `repl.exec`,携带 `instrument: false` 和文件名标签.
   - 沿用现有 `_ExecutionInterruptWatcher`,保证 Ctrl+C 可中断运行.
3. `runActiveFileInCustomRepl()` 不再从 TypeScript 直接调用 `executeInManager()`,而是把内部运行命令发送给 REPL 终端.这样 prompt loop 自身进入阻塞执行状态,脚本结束后自然恢复 `>>>`.
4. manager server 将 `instrument` 参数传给 session;缺省值保持 `true`,保证普通 REPL 表达式回显行为兼容.

## 5. 文件级任务

- `src/board/mpremoteCommands.ts`
  - 专用终端改为隐藏创建后主动显示.
  - 活动文件运行改为向 REPL 客户端发送保留运行命令.
- `scripts/mpyrepl/repl_client.py`
  - 增加安全的运行文件命令解析、文件读取、状态输出和执行分支.
- `scripts/mpyrepl/manager_server.py`
  - 转发 `instrument` 和可选运行标签.
- `scripts/mpyrepl/manager_session.py`
  - 支持执行原始源码或交互语义源码,默认行为保持不变.
- `tests/boardMpremoteCommandsCoverage.test.ts`
  - 验证活动文件通过终端命令运行,且终端使用 `hideFromUser`.
- `scripts/mpyrepl/test_repl_client.py`
  - 覆盖带空格/中文路径、读取失败、运行成功和 Ctrl+C.
- `scripts/mpyrepl/test_manager_server.py`, `scripts/mpyrepl/test_manager_session.py`
  - 覆盖 `instrument: false` 的协议转发和原始源码执行.

不应修改 `python.terminal.activateEnvironment` 用户设置、工作区 `.vscode/settings.json` 或旧 mpremote 模块.

## 6. 分阶段执行

### 阶段一:终端隔离

- 修改专用终端创建参数.
- 验证终端仍能由 `show()` 正常显示.
- 完成标准:测试确认 `hideFromUser: true`,且现有 REPL 启动命令不变.

### 阶段二:运行命令与原始源码协议

- 增加 REPL 客户端保留命令和 manager 参数.
- 保持普通 `repl.exec` 默认进行表达式回显改写.
- 完成标准:活动文件走 `instrument: false`,交互 REPL 仍走默认路径.

### 阶段三:状态与中断验证

- 验证运行期间 prompt loop 被执行调用占用,完成后恢复提示符.
- 验证 Ctrl+C 使用现有带外 manager 客户端中断.
- 完成标准:连续运行和中断路径测试通过.

## 7. 验证计划

- `npm run compile`
- `npm test -- --runInBand tests/boardMpremoteCommandsCoverage.test.ts tests/serialManagerCoverage.test.ts`
- `python scripts/mpyrepl/run_python_tests_with_coverage.py`
- `npm test -- --runInBand`
- 如 COM 端口空闲,最后进行一次非破坏性实机验证:运行可中断的演示脚本,Ctrl+C 后再次运行,确认没有 PowerShell 激活命令进入 REPL.

## 8. 风险与注意事项

- 不通过关闭 Python 扩展功能规避问题,避免影响用户正常 Python 终端.
- 内部命令必须使用严格前缀和 JSON 路径解析,不能拼接为主机 shell 命令.
- 完整文件必须原样发送到 MicroPython,避免 CPython AST unparse 改变语义或错误行号.
- 实机测试前只确认串口是否可用,不删除或覆盖设备文件.
