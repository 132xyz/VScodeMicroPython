# VScodeMicroPython soft-reset REPL 同步修复

状态: 已完成授权的宿主侧实现、回归、编译和打包, 归档后不可再次编辑. 物理设备/GUI 验证不在本次范围, 未执行.
项目: `/home/qz/qzrobot/mpy/VScodeMicroPython`.
基线: `8f6d91e`, 工作树已有 0.4.38 下载去重修复、测试、文档和下载计划, 必须保留.
实施授权: 用户在本会话先要求不操作设备、分析 soft-reset 误报, 随后于 2026-09-15 明确要求 "开始修复". 本计划记录该已获授权范围, 不增加设备操作许可.

## 1. 目标与边界

- 修复软复位等待中 100ms 无输出即失败的宿主侧误判.
- 协议同步超时与真实串口 I/O 错误分别处理.
- 已发送 Ctrl-D 后不自动重发复位; 下一条命令可在同一个串口句柄上恢复 raw REPL.
- 保留成功 RPC 结果 `true`, 增加失败细节和 `status.replReady`.
- 更新 Agent 超时传递、长期回归和相关中英文说明.
- 不连接、读写、复位或测试任何物理设备; 不调用现有 manager, 不安装扩展, 不更改文件传输逻辑.

成功标准: 200ms 及更长启动空闲不会触发 100ms 误报; 完整等待到期返回同步错误但不关闭串口; 下一条命令原句柄恢复; I/O 错误仍按断线处理; build.sh 全检查通过.

## 2. 当前实现与证据

- `runtime/transport.py::read_until` 在读取已有数据之前检查空闲超时.
- `soft_reset` 所有阶段均使用 `read_timeout=0.1`, 尽管另有 `operation_timeout=10`.
- 软复位错误 "raw repl prompt not restored after soft reset" 发生在已收到 `soft reboot` 后.
- `manager/session.py::soft_reset` 将所有 TransportError 交给 `_mark_transport_lost`, 关闭句柄并进入 stopped.
- 下一条 execute/fs 命令通过 `_ensure_open` 自动重连, 因而可能立即成功.
- Agent `--timeout` 尚未传给 device.softReset 的设备协议等待.
- 2026-09-14 纯 pyserial loop:// 复现: 提示符延迟 200ms, 首次等待 0.110s 返回空, 下一次立即成功; 使用 timeout=None + 整体期限可在 0.201s 成功.

相关函数未发现明确人工作者/保护记录, 作者来源未知. 用户的本次授权覆盖上述已分析函数的聚焦修复, 不授权整文件重写或风格归一化. 保留现有 Python 类、类型标注、门控和错误包装风格.

## 3. 已确认决定

| 决定 | 来源与条件 |
| --- | --- |
| 仅修改宿主代码, 不操作设备 | 用户 "先不操作设备"; 本次 "开始修复" 未扩大设备许可 |
| 协议等待使用完整期限, 不受 100ms 空闲约束 | 上轮修复建议第 1 项, 用户授权开始修复 |
| 读取已有数据优先于空闲超时判定 | 上轮修复建议第 2 项, 同上 |
| 提示符未恢复不等同物理断线, 不再次发送 Ctrl-D | 上轮修复建议第 3/4 项, 同上 |
| 保持现有成功 true, 失败增加细节, 下次命令原句柄恢复 | 在上述范围内的最小兼容实现; 不添加新的 public state |
| 编译打包而不安装 | 本会话既有明确要求, 使用真实 build.sh |

## 4. 方案

1. read_until 仍保留整体截止时间, 但在一次读取无数据后才判断空闲/中断静默期限; 超时前将未发送的标记候选尾部输出给 consumer.
2. enter_raw_repl 的 banner/真实提示符等待和 soft_reset 的各阶段使用 timeout=None, 每次完整操作分别共用一个有界截止时间.
3. soft_reset 使用一个共享截止时间, 支持 operation_timeout 覆盖. 等待 reboot marker、raw banner 和真实 `>`; 将最后的 `>` 放回内部缓冲, 供下一条执行使用.
4. 新增 ReplSyncError, 携带 reset_sent/reset_observed; 仅表示协议同步问题, 不用于 pyserial I/O 异常.
5. ManagerSession 遇到同步错误保留 transport, 设置待同步标志, 返回 `repl_sync_timeout` 和 resetSent/resetObserved/replReady. status 的 state 仍表示原串口连接, replReady=false 表示协议未就绪.
6. 下一条命令 `_ensure_open` 通过同一个 gate/transport 执行 enter_raw_repl(soft_reset=False) 和 helper 注入. 恢复失败可再次返回同步错误; I/O 错误才关闭句柄. 人工 REPL 不因协议超时收到 stopped.
7. CLI 将 --timeout 作为 softResetTimeoutMs 传入, server 验证正有限数; 不带参数的旧人工 REPL/扩展继续用 manager 默认期限.

## 5. 文件级范围

- `scripts/mpyrepl/runtime/transport.py`: ReplSyncError, read_until, enter_raw_repl, soft_reset; 不改下载/上传或 raw-paste 流量控制.
- `scripts/mpyrepl/manager/session.py`: 待同步状态、soft_reset、_ensure_open、状态/释放/补全的必要兼容处理.
- `scripts/mpyrepl/manager/server.py`: device.softReset 参数验证与传递.
- `scripts/mpyrepl/clients/agent.py`: softResetTimeoutMs、同步错误退出码.
- `src/board/serialManagerTypes.ts`: 可选 replReady 字段, 不修改串口 UI 生命周期.
- `scripts/mpyrepl/tests/test_transport_behavior.py`: 延迟/分片/期限/尾部输出/真实提示符/写失败回归.
- `scripts/mpyrepl/tests/test_manager_session.py`: 超时不关闭、原句柄恢复、缓存失效、I/O 断线回归.
- `scripts/mpyrepl/tests/test_manager_server.py`, `test_agent_client.py`: 参数、队列、错误契约回归.
- `docs/agent-cli.md`, `docs/agent-cli_zh-CN.md`, `docs/custom-python-repl.md`, `docs/custom-python-repl_zh-CN.md`, `docs/TEST_README.md`: 本次行为与验证边界.
- `package.json`, `package-lock.json`: 仅由 build.sh patch 更新版本.
- 不修改已有 filesystem.py/test_fs_ops.py 的下载修复, 不修改旧计划或外部固件代码.

## 6. 分阶段执行

- [x] 阶段 A: 加入纯宿主回归, 在旧代码上验证失败. 禁止真实串口和 RPC endpoint.
- [x] 阶段 B: transport/manager/CLI 聚焦修复, 四个相关 unittest 文件通过; 最后补入 raw entry 共享期限回归.
- [x] 阶段 C: 同步文档, 已检查聚焦差异和新链接, git diff --check 通过.
- [x] 阶段 D: `./build.sh patch`, Python 3.14 完整回归, git diff --check 和 VSIX 内容核验通过. 未安装、未提交.

## 7. 验证

- `python3 -m unittest discover -s scripts/mpyrepl/tests -p test_transport_behavior.py`.
- 对 test_manager_session.py/test_manager_server.py/test_agent_client.py 同样执行.
- `./build.sh patch`: TypeScript 编译、Jest、Python 覆盖率、版本增量、release/ 打包.
- `/usr/bin/python3.14 scripts/mpyrepl/tests/run_with_coverage.py`.
- `git diff --check`, 检查压缩包 CRC 与实际打包的 Python 源码.
- 所有串口测试仅 FakeSerial/loop://, 不代表真实硬件验证. 不做 GUI/设备验证, 交付明确说明限制.

## 8. 风险与收尾

- 等待真正完整期限可能让真实同步错误比旧版本晚返回, 这是避免误报所需行为.
- 已收到 soft reboot 只表示观察到复位标记, 最终 REPL 就绪还需 banner 和 `>`; 不把二者混为一谈.
- 同步恢复发送 Ctrl-C/Ctrl-A, 但只在调用方下一次主动命令时执行, 不自动重发 Ctrl-D.
- 长期回归保护真实功能契约, 放入已有正式测试; 不新建一次性工具.
- 不对当前 manager 热替换; 用户安装后需启动新版 manager 才能验证新代码.
- 保留之前未提交工作, 本次不 git add/commit. 计划仅在宿主范围实现验证完成后归档, 标注未做硬件验证.

## 执行记录

- 2026-09-15: 已读取技能、源码、测试、构建脚本和 Git 基线, 用户授权有效, 开始宿主侧实施.
- 旧代码宿主回归复现: 已到达的空闲临界点数据未读、boot gap 引发误报、未匹配 marker 尾部未输出; 新超时接口与错误细节尚缺失.
- 聚焦测试通过. 第一次完整覆盖率运行暴露已有模块重载测试引发的异常类身份问题, 已按现有测试习惯改为模块引用; 第二次完整运行 249 项全部通过, Python 3.12 覆盖率 89.2%. 此后补入 raw entry 共享期限测试, 待最终构建重验.
- 最终源代码完整 Python 3.12 验证: 250 项通过, 覆盖率 89.2% (5570/6243). 已完成所有源码修改, 正在使用 build.sh patch 编译打包.
- `./build.sh patch` 成功: TypeScript 编译通过, 26 个 Jest suites / 112 项测试通过, Python 3.12 250 项通过, 覆盖率 89.2%. 版本由工作树中的 0.4.38 增加到 0.4.39, 生成 `release/mpy-0.4.39.vsix`.
- Python 3.14 完整验证: 250 项通过, trace 覆盖率 84.5% (5289/6259), 通过 80% 门槛. 不同 Python trace 行统计不直接等同覆盖率变化.
- `git diff --check` 通过; 存在仓库已有的 CRLF/LF 提示, 未整文件归一化. VSIX CRC 校验通过, transport/session/server/agent/filesystem 源码和 5 份相关文档逐字节匹配工作树.
- VSIX SHA256: `9fe14f0d5e2a3cf34b613ff19cb639edd6ddea2c94ba60d1bbf488ad12a222b1`. 根目录无 VSIX 遗留, 原 release/ 历史构建未删除.
- 全程未连接物理设备、调用已有 manager RPC、安装扩展或 Git 暂存/提交. 未创建一次性脚本/设备文件, 无本次待清理的实验样本. 此前下载修复和未完成下载计划完整保留.
- 后续实机验证必须另获设备操作许可, 复用获准的原工作区会话, 并确认 manager 从 0.4.39 启动. 安装 VSIX 或重开串口不会让旧常驻 Python 进程热加载新代码.
