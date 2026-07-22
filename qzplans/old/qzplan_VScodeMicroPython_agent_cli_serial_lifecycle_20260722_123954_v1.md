# VScodeMicroPython Agent CLI 串口生命周期实施计划

版本: v1  
创建时间: 2026-07-22 12:39:54  
状态: 已完成

## 1. 目标与边界

### 主要目标

- 增加 `agent connect PORT`,让命令行能够显式选择并连接串口.
- 增加 `agent disconnect`,仅释放物理串口并保持 manager RPC 服务存活.
- 保留 `agent reconnect`,用于重新打开当前记录的串口.
- 增加 `agent shutdown`,显式停止 CLI 或扩展启动的共享 manager.
- 当描述文件不存在时,`agent connect PORT` 自动启动后台 manager并发布 `.mpy-workbench/serial-manager.json`.
- 扩展、人工 REPL 和多个 Agent 始终复用同一个 manager,不产生第二个串口所有者.

### 非目标

- 不让 Agent 客户端直接使用 pyserial 打开设备.
- 不实现远程主机访问,manager 仍只绑定回环地址.
- 不改变现有文件传输协议、REPL 输入语义和代码补全算法.
- 不自动扫描并猜测目标串口;调用方必须给出 `PORT`,或明确使用现有端口执行 `reconnect`.

### 成功标准

- 无活动 manager 时,从工作区运行 `agent connect COM5` 可启动后台 manager、连接 COM5 并返回一条成功 JSON.
- manager 已存在时,`agent connect COM7` 可在同一 manager 内释放旧端口并切换到 COM7.
- `disconnect` 后状态为 `stopped`,描述文件和 manager endpoint 保留,其他客户端仍可附着.
- `shutdown` 后 manager 退出并仅删除自己持有 token 对应的描述文件.
- 扩展可附着 CLI 启动的 manager,串口状态和当前端口不会继续显示旧值.
- 完整 `build.ps1` 通过并生成下一补丁版本 VSIX,但不安装扩展.

## 2. 项目现状

- `scripts/mpyrepl/clients/agent.py` 只会发现并附着现有描述文件,所有命令执行前都会要求 manager 已存在.
- `scripts/mpyrepl/manager/session.py` 使用冻结的 `ReplConfig`,当前新增的 `reconnect()` 只能恢复同一端口.
- `scripts/mpyrepl/manager/server.py` 在 RPC server 监听前立即打开串口,已有 `device.reconnect`,但没有 connect/disconnect.
- `src/board/serialManager.ts` 和 `src/board/serialManagerDescriptor.ts` 当前由扩展写入、删除描述文件.
- `src/board/serialManagerProcess.ts` 能启动 manager 并解析 ready marker,但没有把描述文件路径传给 Python manager.
- 顶层 `--port COM5 exec/fs/...` 会直接占用串口,不能作为共享 Agent 工作流的实现基础.
- 描述文件已经包含 endpoint、token、managerInstanceId、device、managerPid、scriptPath 和 extensionVersion,可继续复用 schema v1.

## 3. 已确认需求、假设与疑问

### 已确认需求

- 命令行应能直接指定串口连接,且不依赖操作 VS Code 界面.
- 没有 manager 时也要支持冷启动,不是只给现有 `reconnect` 增加端口参数.
- manager 必须保持串口唯一所有权,避免扩展和 Agent 抢占 COM 口.

### 实施假设

- `connect` 命令格式采用 `agent connect PORT [--baudrate N]`.
- `--timeout` 同时限制 manager 冷启动和设备连接重试时长.
- 未显式指定 `--session` 或 `--workspace` 且不存在描述文件时,使用当前目录作为工作区根目录.
- 切换端口失败后,manager 保留请求的新端口配置并处于失败/停止状态,调用方可修复设备后执行 `reconnect`.
- schema v1 字段足以表达生命周期,只增加 RPC capability,暂不升级协议版本.

### 风险点

- 两个 CLI 同时冷启动时可能竞争描述文件和串口;必须使用原子写入、实例 ID/token 校验和启动后握手避免附着错误实例.
- Windows 后台进程必须脱离调用终端但保留可控 PID,且 stdout 不应把 bearer token 写入普通日志.
- CLI 切换端口后,扩展内存中的 activeRuntime 和当前端口覆盖值必须同步,否则下一次扩展操作可能重新打开旧端口.
- manager 异常退出时描述文件可能残留;Agent 必须验证 endpoint 和实例 ID,不能盲信文件存在.

## 4. 方案设计

### 命令与 RPC

| Agent 命令 | RPC | 行为 |
| --- | --- | --- |
| `connect PORT [--baudrate N]` | `device.connect` | 关闭旧 transport,更新配置,重试打开指定端口并完成 raw REPL/helper 初始化. |
| `disconnect` | `device.disconnect` | 关闭 transport,清空运行时补全缓存,manager 继续监听 RPC. |
| `reconnect` | `device.reconnect` | 重新连接当前配置端口. |
| `shutdown` | `manager.shutdown` | 关闭 transport、RPC server 和后台进程. |

这些串口操作继续使用 manager 的有界操作队列.`interrupt` 保持带外路径,用于中断正在运行的设备代码.

### 冷启动流程

1. Agent 根据 `--session`、`MPY_MANAGER_SESSION`、`--workspace` 或当前目录确定描述文件目标路径.
2. 如果存在描述文件,先校验 schema、回环地址、token 和 managerInstanceId,附着成功后复用该 manager.
3. 如果描述文件不存在或已确认 endpoint 不可达,`connect` 使用当前 Python 和当前 `mpyrepl/__main__.py` 启动后台 manager.
4. Windows 使用隐藏、独立进程组和重定向句柄;POSIX 使用新 session.敏感 ready 输出写入空设备,启动错误写入工作台内诊断日志.
5. Python manager 成功监听后原子写入描述文件,其中 PID、实例 ID、token、端口和脚本路径来自实际运行实例.
6. Agent 轮询描述文件并完成 `manager.hello` 校验,只接受本次启动 PID/实例对应的 manager.
7. 启动失败或超时时终止本次创建的进程,返回稳定 JSON 错误和退出码.

### 描述文件所有权

- 新增纯标准库 Python 描述文件模块,供 manager 和 Agent 使用.
- Python manager 在配置了 session 文件时负责初始发布、端口变更更新和退出清理.
- 删除描述文件前必须重新读取并核对 token,不能删除后来实例写入的文件.
- 扩展启动 manager 时把 descriptor path 和版本信息传给 Python manager;过渡期允许扩展现有写入逻辑重复写入相同实例数据,最终以 token/instance 校验保证一致.
- `disconnect` 不删除描述文件,因为 manager 仍可附着;`shutdown` 或 manager 退出才删除.

### 端口切换与扩展同步

- `ManagerSession.connect()` 使用 `dataclasses.replace()` 创建新的冻结配置,不原地修改 `ReplConfig`.
- status 事件始终包含当前目标 `port` 和 `baudrate`.
- manager 发布器在 connect 成功或目标配置变化时更新描述文件 `device`.
- 扩展收到当前 manager 的 status.port 后更新 `activeRuntime.device`,并同步内存中的 selected connect override,防止后续命令回退旧端口.
- 扩展附着 CLI manager 时继续校验 descriptor.device 与请求设备;CLI 切换后的 descriptor 必须先完成更新.

### 错误处理

- 空端口、非法波特率和非正连接超时返回 `invalid_params`/退出码 2.
- manager 正忙时遵循 `--busy wait|reject` 和 `--queue-timeout`.
- 串口未在超时内就绪返回 `transport`/退出码 6,details 包含目标端口和超时.
- 描述文件无效时不覆盖未知内容;只对格式有效但 endpoint/实例已确认失效的描述文件执行 token 条件清理.
- `connect` 不自动回退到旧的直接串口 CLI,避免双重占用.

## 5. 文件级任务

### 预计新增

- `scripts/mpyrepl/manager/descriptor.py`:Python 端描述文件模型、原子发布、条件清理和版本/路径辅助函数.
- 对应 Python 测试文件,优先 `scripts/mpyrepl/tests/test_manager_descriptor.py`.

### 预计修改

- `scripts/mpyrepl/runtime/models.py`:如需要,增加安全替换配置的辅助约束,保持冻结 dataclass.
- `scripts/mpyrepl/manager/session.py`:实现 connect/disconnect,重用连接重试逻辑,清理运行时状态.
- `scripts/mpyrepl/manager/server.py`:增加 RPC、capability、manager 实例信息访问及描述文件发布生命周期.
- `scripts/mpyrepl/cli.py`:为 manager 增加 session 文件和发布元数据参数.
- `scripts/mpyrepl/app.py`:把新增 manager 参数传入运行入口.
- `scripts/mpyrepl/clients/agent.py`:增加 connect/disconnect/shutdown,描述路径解析、现有 manager 复用和后台冷启动.
- `src/board/serialManagerTypes.ts`:增加 manager 启动参数或状态同步所需字段.
- `src/board/serialManagerProcess.ts`:向 Python manager 传递 descriptor path/版本,保持 ready 解析兼容.
- `src/board/serialManager.ts`:同步 status.port 到 activeRuntime 和扩展当前端口覆盖值.
- `scripts/mpyrepl/tests/test_manager_session.py`:覆盖连接、切换、断开和失败状态.
- `scripts/mpyrepl/tests/test_manager_server.py`:覆盖新 RPC、参数校验和 capability.
- `scripts/mpyrepl/tests/test_agent_client.py`:覆盖命令映射、冷启动、陈旧描述文件和稳定退出码.
- `tests/serialManagerProcess.test.ts`:覆盖新增启动参数.
- `tests/serialManagerCoverage.test.ts`:覆盖端口状态同步和 CLI manager 附着.
- `docs/agent-cli.md`、`docs/agent-cli_zh-CN.md`:更新完整生命周期、命令示例、冷启动与安全说明.
- `docs/custom-python-repl.md`、`docs/custom-python-repl_zh-CN.md`:同步 manager 所有权和描述文件生命周期.
- `package.json`、`package-lock.json`:由 `build.ps1` 成功后自动增加补丁版本.

### 不应修改

- `scripts/mpyrepl/runtime/filesystem.py` 的传输协议和块大小.
- 设备端 MicroPython 文件及固件代码.
- 用户现有工作区配置和本机已安装扩展.
- 与本次生命周期无关的补全、编辑器 UI 和文件同步逻辑.

## 6. 分阶段执行

### 阶段一:Session 生命周期

- 实现 `connect/disconnect/reconnect` 的共享内部流程.
- 验证端口更新、失败重试、缓存清理、transport 关闭和状态事件.
- 完成标准:Session 单元测试覆盖同端口恢复、跨端口切换、断开后重连和超时失败.

### 阶段二:RPC 与描述文件

- 增加 `device.connect`、`device.disconnect` 和 capability.
- 实现 Python 描述文件原子发布、配置更新和 token 条件清理.
- manager 启动/退出时管理描述文件.
- 完成标准:RPC 和 descriptor 单元测试全部通过,manager 停止后不遗留自己拥有的描述文件.

### 阶段三:Agent 冷启动

- 增加命令解析、工作区目标路径解析和后台 manager 启动器.
- 对现有 manager 优先附着,仅在 `connect` 且无可用 manager 时冷启动.
- 完成标准:使用 mock 子进程和临时目录验证成功、超时、子进程提前退出、陈旧描述文件和并发竞争的主要分支.

### 阶段四:扩展同步

- 扩展启动 manager 时传递 descriptor 元数据.
- status.port 更新 activeRuntime 与选中端口覆盖值.
- 完成标准:Jest 覆盖启动参数、附着和端口变更,旧的 Open Serial/Open REPL 行为保持通过.

### 阶段五:文档、构建与人工验证

- 更新中英文文档和 CLI help 示例.
- 先运行定向测试,再执行 `build.ps1` 完整构建和版本递增.
- 不安装 VSIX;产物只放 `release/`.
- 如当前扩展仍占用实际串口,不启动第二个源代码 manager做硬件测试.安装新版后再按文档执行真实冷启动和切换验证.

## 7. 验证计划

```powershell
python -m unittest scripts.mpyrepl.tests.test_manager_descriptor scripts.mpyrepl.tests.test_manager_session scripts.mpyrepl.tests.test_manager_server scripts.mpyrepl.tests.test_agent_client
npm test -- --runInBand tests/serialManagerProcess.test.ts tests/serialManagerCoverage.test.ts
git diff --check
& .\build.ps1
```

安装新 VSIX 后的真实设备验证步骤:

```powershell
python scripts/mpyrepl/__main__.py agent --workspace C:\qzrobot\mpy --timeout 20 connect COM5
python scripts/mpyrepl/__main__.py agent --workspace C:\qzrobot\mpy status
python scripts/mpyrepl/__main__.py agent --workspace C:\qzrobot\mpy exec --code "print('agent-ok')"
python scripts/mpyrepl/__main__.py agent --workspace C:\qzrobot\mpy disconnect
python scripts/mpyrepl/__main__.py agent --workspace C:\qzrobot\mpy --timeout 20 reconnect
python scripts/mpyrepl/__main__.py agent --workspace C:\qzrobot\mpy shutdown
```

真实验证还应覆盖 `machine.reset()` 后执行 `reconnect`,以及设备重枚举为其他 COM 编号后执行 `connect NEW_PORT`.

## 8. 风险与实施约束

- 不得通过 GUI 自动化代替 manager 生命周期接口.
- 不得在 stdout、诊断日志、测试快照或回复中输出真实 token.
- 不得因陈旧描述文件而杀死未经实例 ID/PID 校验的进程.
- 不得让 connect 失败后静默回退到直接 pyserial.
- 不得修改或安装当前用户正在使用的扩展;只生成新 VSIX.
- 工作区已有大量未提交改动,实施时只增量修改相关文件,不得重置或覆盖现有变更.
- Windows 进程创建和句柄继承必须有单元测试;Linux/macOS 分支至少进行参数级测试.
- 如果 manager 冷启动方式无法保证退出清理或扩展可接管,应先停在该阶段修正设计,不要用临时守护脚本绕过.

## 9. 实施结果

- 已实现 `connect PORT [--baudrate N]`、`disconnect`、`reconnect` 和 `shutdown`.
- 已实现无描述文件时的后台 manager 冷启动、Windows 隐藏进程、POSIX 新 session 和启动诊断日志.
- 已实现 Python manager 描述文件原子发布、端口更新和 token/instance 条件清理.
- 已实现扩展启动参数传递及 status.port 到 activeRuntime/selected connect 的同步.
- 已更新中英文 Agent CLI、REPL 架构、README 和测试文档.
- `build.ps1` 已通过:26 个 Jest 套件、111 个 TypeScript 测试、206 个 Python 测试,Python 覆盖率 80.8%.
- 版本已递增到 `0.4.34`,产物为 `release/mpy-0.4.34.vsix`.
- 按用户要求未安装 VSIX,因此未在真实设备上执行新版冷启动测试.
