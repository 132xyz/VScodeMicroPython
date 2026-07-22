# 串口拔出检测与状态同步实施计划

## 1. 目标与边界

### 目标

- 开发板串口被拔出后,在空闲状态和执行状态都能检测到连接丢失.
- 将 Windows `PermissionError(13)`、`WriteFile failed`、`ReadFile failed` 统一转换为 `transport_lost`.
- 同步更新 manager 状态、VS Code `serialOpen/replOpen` 上下文和“开发板操作”树.
- 连接丢失后自动结束失效的 REPL 客户端,不继续显示可用的 `>>>`.
- 下一次显式连接或运行操作可以建立干净的新 manager 会话.

### 非目标

- 不自动循环重连开发板.
- 不修改用户选择的 COM 端口.
- 不弹出重复通知或增加遥测.
- 不安装生成的 VSIX.

### 成功标准

- 空闲 REPL 下拔出开发板后,默认 1 秒内 `serialOpen` 变为 false,操作树显示 `Open Serial`.
- 正在运行文件时拔出开发板,REPL 显示明确的连接丢失信息并自动退出.
- `PermissionError(13)` 不再显示为普通 `manager request failed`,而是 `serial connection lost`.
- 重新插入后,用户点击连接或运行可创建新会话.

## 2. 项目现状

- `scripts/mpyrepl/transport.py` 只包装了读取异常,多数 `serial.write()` 直接抛出 `PermissionError` 或 `SerialException`.
- `ManagerSession._mark_transport_lost()` 已能关闭 transport、设置 `stopped` 并广播 status,但只有收到 `TransportError` 才会进入该路径.
- manager 空闲时没有健康探测,拔线后如果没有读写就不会产生错误.
- `src/board/serialManager.ts` 的 `isSerialManagerActive()` 只检查 manager TCP client,即使 manager 到开发板的 transport 已停止也仍返回 true.
- `SerialManagerClient` 已支持 `status` 和 `close` 事件,但 `serialManager.ts` 没有监听.
- REPL 客户端收到 `transport_lost` 后仍返回 prompt loop,不会主动结束终端.

## 3. 需求、假设与风险

- Windows 上通过读取串口状态 `in_waiting` 可触发拔线后的 `ClearCommError/PermissionError`;探测必须避开正在执行的串口操作.
- 状态探测只判断物理 transport 是否可访问,不执行板端代码、不改变 REPL 模式.
- 串口忙时跳过探测,避免与上传、下载、运行、补全或重置并发访问.
- 某些驱动可能延迟报告拔线,成功标准按常见 USB CDC/USB Serial 行为验证.
- 断开后关闭 REPL 是确定行为;不自动重连,避免设备反复上下线造成循环弹窗和端口竞争.

## 4. 方案设计

### Python transport

- 增加统一 `_write_serial()` 和 `probe_connection()`.
- 所有协议写入通过 `_write_serial()`,将 `OSError/PermissionError/SerialException` 包装为 `TransportError`.
- `probe_connection()` 检查端口打开状态并读取串口状态,只做无副作用探测.

### ManagerSession

- transport 打开成功后启动后台监测任务,间隔约 500ms.
- 使用 `SerialOperationGate.try_run_blocking()`;串口忙时本轮跳过.
- 探测抛出 `TransportError` 时调用 `_mark_transport_lost()`,广播 `state=stopped`.
- close、soft reset 失败和 manager shutdown 时正确取消监测任务,避免泄漏 asyncio task.

### TypeScript 状态机

- `serialManager.ts` 增加“板端 transport 已连接”状态,不再只看 manager TCP socket.
- 监听 active client 的 `status` 和 `close` 事件.
- 收到 `stopped/failed/closing` 时立即:
  - 设置 `microPythonWorkBench.serialOpen=false`.
  - 通知扩展刷新开发板操作树.
  - 使 `ensureManagerStarted()` 下次先清理旧 manager 再新建会话.
- 使用内部命令或注册回调刷新 UI,不引入 `serialManager.ts -> actions.ts` 循环依赖.

### REPL 客户端

- `_execute_source()` 区分普通执行失败、用户取消和 `transport_lost`.
- `transport_lost` 时输出一次明确提示并退出 prompt loop.
- 终端退出触发现有 `onDidCloseTerminal`,同步 `replOpen=false`.

## 5. 文件级任务

- `scripts/mpyrepl/transport.py`
  - 统一串口写异常和新增无副作用连接探测.
- `scripts/mpyrepl/manager_session.py`
  - 管理后台监测任务及 transport lost 生命周期.
- `scripts/mpyrepl/repl_client.py`
  - transport lost 后退出 REPL.
- `src/board/serialManager.ts`
  - 维护真实串口状态,监听 status/close 事件.
- `src/core/extension.ts`
  - 注册内部状态变化命令并刷新 actions tree.
- `tests/serialManagerCoverage.test.ts`, `tests/serialManagerClient.test.ts`
  - 覆盖 status/close 状态更新和重连前清理.
- `scripts/mpyrepl/test_transport_behavior.py`
  - 覆盖 Windows 风格写错误与 probe 错误包装.
- `scripts/mpyrepl/test_manager_session.py`
  - 覆盖空闲探测发现断线、忙时跳过和任务取消.
- `scripts/mpyrepl/test_repl_client.py`
  - 覆盖 transport lost 输出并退出 prompt loop.
- `package.json`, `package-lock.json`
  - 完成后版本提升到 `0.4.28`.

不修改已安装扩展目录、不执行 `code --install-extension`.

## 6. 分阶段执行

### 阶段一:统一 transport 错误

- 将所有串口写入口收敛到异常包装函数.
- 增加连接探测 API 和单元测试.
- 完成标准:`PermissionError(13)` 转换为 `TransportError`.

### 阶段二:空闲监测

- ManagerSession 启停后台监测任务.
- 验证 gate 忙时不访问串口,空闲断线时广播 stopped.
- 完成标准:无悬挂 task、无串口并发访问.

### 阶段三:UI 与 REPL 状态同步

- TypeScript 监听 manager 状态,更新 context 并刷新操作树.
- REPL 客户端在 transport lost 后退出.
- 完成标准:serialOpen/replOpen 和终端实际状态一致.

### 阶段四:发布产物

- 版本提升到 `0.4.28`,编译、测试、生成 VSIX.
- 只生成 `mpy-0.4.28.vsix`,不安装.

## 7. 验证计划

- `python scripts/mpyrepl/run_python_tests_with_coverage.py`
- `npm test -- --runInBand`
- `npm run compile`
- `npm run package -- --out mpy-0.4.28.vsix`
- 非破坏性实机测试:
  - 空闲 REPL 拔线,观察 1 秒内状态变化.
  - 运行脚本时拔线,观察 transport_lost 和终端退出.
  - 重新插入后手动连接,验证可恢复.
- 实机测试不写入或删除设备文件.

## 8. 风险与注意事项

- 监测任务不得在 gate busy 时访问串口.
- `closeManager()` 主动关闭与物理断线必须幂等,不能重复关闭或重复弹错.
- manager TCP 存活不能再代表开发板串口在线.
- 避免 import cycle;UI 刷新通过内部事件边界完成.
- 不自动安装 VSIX,由用户自行安装验证.
