# REPL 输出完整性与请求等待修复方案

状态: 用户已于本会话回复 "开始吧", 授权的宿主侧修复、回归、文档与打包已完成. 归档后不再修改;设备/真实终端驱动实测未执行.
用户请求: 先要求详细方案, 随后明确授权按方案实施. 授权不包括安装扩展、复位设备或接管当前会话.
基线: Git HEAD `b1d4df2`; 工作树已有 0.4.40 文件树按目录加载、manager 启动保护和协议超时分类改动. 保留这些修改, 不回退或夹带提交.
相关历史: `qzplans/old/qzplan_VScodeMicroPython_lazy_tree_startup_20260916_092651_v1.md`, `qzplans/old/qzplan_VScodeMicroPython_soft_reset_sync_20260915_170521_v1.md` 均为只读归档.

## 1. 目标、边界和成功标准

### 用户已确认的目标

- 人工 REPL 是共享设备控制台, 应显示用户执行、其他 Agent 执行和后台线程的普通输出, 不能因按请求隔离而消失.
- 文件浏览按目录读取, 不回到全量扫描方案.
- Agent CLI 保持轻依赖, 不引入终端/TUI 运行依赖.
- 复用现有工作区串口 owner. 分析不触发复位、抢占、manager 替换或关闭用户 REPL.
- 安装包由用户安装; 后续实现使用 `build.sh` 构建和递增版本.

### 本计划建议的修复目标

- 同一设备输出在任意串口/TCP 分片下, 普通文字内容不因分片改变.
- 已确认协议控制字节不进入控制台; 非协议输出恰好一次转发给人工 REPL.
- CRLF 可以跨任意两个回调; 无换行文本实时可见, 不污染正在编辑的输入.
- 后台输出不会被内部 fs/补全/helper 查询默默吃掉; 协议帧损坏时显式失败, 不假装成功.
- 输入、Ctrl-C、输出绘制不被补全 RPC 阻塞. 超时请求有归属, 不留隐形排队任务.

### 非目标与不能承诺的行为

- 不改固件、USB CDC 驱动、波特率或设备端用户线程.
- 不保证任意后台线程把任意字节插入 raw REPL 控制序列后仍能无损自动拆分. 同一物理字节流缺少来源标签时存在不可判定情况.
- 不把时间上位于某个 RPC 内的输出伪称为该 RPC 独占输出. operationId 表示接收上下文, 不证明设备线程来源.
- 不对无限生产、无限阻塞的终端承诺有限内存下永久无丢失. 队列过载必须可见, 不能悄悄丢数据或拖死串口 owner.
- 不开启默认原始串口录制, 不在诊断日志保存源码、token、用户打印或文件内容.

## 2. 已验证事实与推断

| 项目 | 证据 | 能证明什么 |
| --- | --- | --- |
| 每片 flush | `clients/repl.py::ManagerClient._handle_event` 每个 stdout/stderr event 后立即 flush | 绕过 prompt-toolkit 未完成行缓冲 |
| CRLF 分片覆盖 | 宿主使用实际 prompt-toolkit 渲染和 VT100 模拟器: 整行两行正常, CR/LF 分片两行可被提示符重绘覆盖 | 显示层存在确定的分片依赖缺陷 |
| 单独拆出 `[` | 同一实验只拆出 `[` 时仍完整 | 不能把样例每个缺失 `[` 都归因于 flush |
| manager 被动采样 | 只附着既有 manager 6 秒, 收到 3 个 stdout events, 拼接含 2 条完整括号进度行 | 短采样期间 manager 输出可以完整, 不是全量抓包证据 |
| fs 吞旁路输出 | `DeviceFsClient.execute` 不传 stdout consumer, `_parse_json_result` 只返回标记结果; 模拟结果后附加 `[` 未转发 | 后台字符可在内部查询期间丢失 |
| 补全吞旁路输出 | `completion/device.py` 仅解析 repr(name), 无旁路 consumer | 补全查询有同类损失风险 |
| idle 误识别 `>` | `read_idle_output` 使用 data.find(b'>'); 无已确认提示符缓冲时 `value > 0` 变 `value  0` | 正文字符可能被当协议提示符消耗 |
| 前端超时未取消 | TS call 的定时器只 pending.delete/reject, socket 保持; manager 排队期限默认 None | 30 秒 UI 超时不是服务端取消 |
| 输入阻塞 | complete_in_thread=False, Tab 同步取 completions, ManagerClient.call 阻塞 queue.get 无超时 | 慢补全可冻结输入循环; 宿主 20ms tick 被 200ms RPC 等待延后 |
| 当时共享状态 | 第一次只读 status 为 repl.exec busy/2 queued, 后续同 PID 自行 ready/0 queued | 不应认定整板或 manager 事件循环已死锁; 当时没有足够操作归属数据 |

样例缺少 `[` 的最终归因仍需正常输出分片、内部查询重叠与终端显示对照. 上述确定缺陷均应修复, 但不能用模拟代替全部真实现场证据.

## 3. 当前链路与责任划分

```text
设备 stdio
  -> SerialReplTransport: raw-paste/EOF/prompt 协议
  -> 内部响应解析或用户执行结果收集
  -> ManagerSession: UTF-8 解码和 stdout/stderr event
  -> ManagerServer: 广播给 REPL/扩展/Agent
  -> ManagerClient: 读取 event
  -> prompt-toolkit 输出与输入界面
```

目前协议读取、用户输出与界面刷新依赖多处隐式约定. 建议保留现有单 owner、操作 gate、NDJSON RPC 和 prompt-toolkit, 只明确三种内容:

1. 协议控制: raw-paste credit/ACK, raw EOF, 确认过的 prompt.
2. 内部响应: fs/helper/补全/传输记录, 只由匹配请求解析.
3. 可见输出: 其余设备普通 stdout/stderr, 人工 REPL 必须收到, 请求是否成功不影响已收到输出的转发.

新模块只用于实际共享职责, 不是另建串口服务. 候选新增文件在下表中标明, 并非声称当前已有这些 API.

## 4. 终端显示修复

建议新增 `scripts/mpyrepl/repl/output.py` 的输出呈现器, 将文本事件处理从逐片 write/flush 改为持续状态:

```text
receive event -> 更新输出模型 -> 投递 UI 更新
                               -> 已完成行提交至 scrollback
                               -> 未完成行作为可重绘尾行显示
```

具体规则:

- reader 线程只入队, 不操作 prompt renderer, 不同步等待 UI RPC.
- 完整行提交仍复用 prompt-toolkit 的 `run_in_terminal`, 合并同一批次可减少重绘.
- 未完成行在输入区上方作为可重绘区域显示, 用 prompt-toolkit 的格式化文本/控件构建; 不用裸 ANSI 直接覆盖输入, 不通过反复向 scrollback 写半行实现预览.
- CRLF 用一个有状态的换行解析器处理. 收到尾部 CR 时保留其状态, 下一片若以 LF 开始则合成一次换行. 空闲刷新只刷新可视状态, 不把待定 CR 或半行强行提交.
- 裸 CR 按控制台回到当前输出行行首的语义更新尾行; 原始 RPC 字符串不被追加人为换行. 进度 `10%\r20%\r100%\n` 最终只提交该逻辑输出行.
- 普通 stdout 和 stderr 保留各自标签, 但终端按 manager 的输出顺序绘制; 两流交错不能各自 flush 后重新排序.
- 无换行输出也及时显示. 建议 UI 合并窗口 20-50ms, 可见延迟目标不超过约 100ms; 这些是待实现测试的目标值, 不是硬件时延承诺.
- 超长无换行输出不能无限增长. 应分批提交安全的完整显示行或采用有界尾行窗口, 保证无截断且与终端换行一致; 不按任意字符数硬切多字节/宽字符/转义序列.
- prompt、用户脚本运行、退出/断线共享同一个输出状态对象. 切换时明确移交尾行, 确认已入队内容处理完毕, 不让旧事件循环关闭时丢弃排队回调, 不重复打印已提交行.
- 继续阻止设备任意 ANSI 改变宿主终端模式. 对目前用户需要的换行、回车等逐项定义, 不引入宽泛的字符清洗正则. 普通 `[`, `]`, `>`, 中文必须原样进入输出模型.

实施时优先保留 PromptSession 与既有编辑键绑定. 若其默认布局无法承载安全的实时尾行, 只在 session 构造中增加独立 tail 控件; 不重做整个 TUI 或改变输入历史规则. 终端渲染回归决定具体控件组合.

不能采用的简化:

- 只删除 flush: 无 LF 的提示会永久不可见.
- 固定延时后照常 flush 半行: 只是降低碰撞概率, CRLF 分片仍会出错.
- 补丢失的 `[` 或过滤 `>`: 无法恢复原始文本, 会破坏合法输出.

## 5. 协议读取与内部响应分流

### 5.1 显式保存提示符状态

`runtime/transport.py` 中区分串口接收缓冲和“已经确认一个 raw prompt 可用”:

- `_read_buffer` 只存实际未消费字节, 不再写入人造 `b'>'` 作为 readiness 状态.
- 用明确的 `prompt_ready`/等待阶段保存同步状态. `enter_raw_repl`、`soft_reset`、raw-paste abort 和 `follow` 统一更新.
- `follow` 在 stdout EOF、stderr EOF 之后完成预期 prompt 的同步, 串口操作 gate 保持到这个阶段结束. 当前 idle reader 不再从任意普通文本中 find/delete `>`.
- `exec_raw_no_follow` 消费已确认的 readiness, 而不是每次用 read_until('>') 吞掉它前面的后台文字. 必须等待 prompt 时, 已确认的旁路输出送 console sink.
- 进入 raw REPL/恢复期间读取的普通 boot/后台输出也有 sink. 正常模式不调用 reset_input_buffer 丢掉所有待收数据.
- 必要的协议重新同步若无法分类残留数据, 输出明确 resync 诊断和计数. 不把旧 raw-paste 控制数据当正文, 也不声称这段残留已无损恢复.

物理限制: 在期待 prompt 的阶段, 若线程输出也在同一个位置插入 `>` 或 EOF 字节, raw REPL 本身没有完备来源信息. 必须约束识别到协议边界, 用后续握手验证同步; 无法验证则 ReplSyncError. 不宣称一个状态变量能解决所有任意字节交错.

### 5.2 内部响应使用请求专属标记

建议新增 `runtime/response_stream.py`, 复用到 fs/补全/helper:

- 每次内部操作产生独立随机 nonce, 由主机生成并嵌入本次设备代码. nonce 是关联标识, 不是认证凭证.
- 内部响应采用明确起止边界、nonce、消息种类和 UTF-8 payload 字节长度. 优先小型 JSON 结果记录; 多字节长度必须按实际编码字节计算.
- 主机按字节增量解析, 允许边界跨任意读包, 不依赖 splitlines 后删除整行. 完整、匹配且校验成功的帧才被归为内部响应.
- 帧前、帧后和不匹配的字节按原顺序转发, 包括没有换行的单独 `[` 和正文中类似 marker 的文本.
- 不为打印 frame 额外补一个未计入帧的前导换行, 否则会人为切断后台输出行.
- stdout、stderr、异常及结果解析失败均经过同一个旁路输出路径. 不能仅在成功时转发剩余文字.
- 对 marker 前缀只保留必要的有限候选缓冲. 操作结束/超时仍未匹配时, 明确释放普通尾部; 已确认的内部 payload 不作为文件正文或日志误发.
- 校验: nonce、kind、字节长度、JSON 结构; 文件数据还需块序号、长度和内容完整性验证. 不假定 generic MicroPython 必定支持某个新校验 API; 实施时先验证目标能力, 只用仓库已支持的依赖或显式能力协商.

若后台日志插入帧内部, 长度/结构检查会失败. 此时只能报告 `protocol_interleaved` (建议新错误码) 和不含敏感正文的诊断, 保留主机收到的未分类内容供人工输出策略处理; 不尝试删除“看起来像日志”的字符后继续解码. 对任意交错实现严格无损需要固件侧原子写入或独立通道, 不在本计划内.

### 5.3 文件传输单独审计

不能只修 listdir/complete 然后声称所有后台输出已保护. 当前下载中开始标记之后的普通行直接被当 Base64, 结束后的行可能直接返回丢弃, 且 `consume_stdout` 还全局 replace `0x04`.

- 继续使用 stdio 流式传输, 不改回每块执行一条命令.
- 下载每块加请求关联和块序号/长度边界, 普通后台文本送 console sink; 验证失败必须终止传输, 不把日志当文件字节.
- 上传 ready、progress、error、result 记录也匹配同一个 nonce; stdin 内容处理与普通 stdout 路由分开.
- 保留原文本 stdout 避免 dupterm 短写重发的修复.
- 传输记录不倾倒到人工 REPL, 转为现有进度事件. 传输失败保留原目标, 清理本次临时文件, 不自动重发写操作.
- 明确取消和恢复时的流结束状态, 不能仅把 0x04 从所有数据中删掉. 原始文件字节仍按 Base64 传输, 不能与 raw 控制标记混为一谈.

## 6. manager 输出顺序和生命周期

- `ManagerSession` 建立统一 console sink. 用户 exec 同时“收集结果”和“广播”, 内部操作由解析器先去除专属协议响应, 其余进入相同 sink, idle reader 也使用它.
- 为物理控制台 stdout 保持连续 UTF-8 解码状态, 不因一次内部 RPC 结束而随意 flush/reset. stdin/raw 控制解析在解码之前. 断线/真正流结束才处理未完成编码并报告异常.
- 不要先收集完整 stdout 再整段广播, 否则既非实时又容易重复; 也不要 consumer 广播后将 ExecResult 再广播一遍.
- 输出事件增加单调序号和 manager instance ID, 可带当前 operationId/clientId 作为上下文. 事件序号先在统一入口赋值再分发.
- 人工 REPL 接收全部普通控制台事件. Agent 保持单条最终 JSON, 不直接向 stdout 打印事件; 文件进度按当前请求过滤. 普通 exec 结果在共享 stdio 中可能含后台输出, 文档不得宣称已严格识别设备线程来源.
- 用每客户端一个有序发送队列/写任务替代每事件新建任意并发广播任务, 同一连接的 response/event 也走一个 writer. 保证该连接先收到操作输出, 再收到其完成结果.
- 慢客户端有有界队列, 不能阻塞其他客户端或串口读取. 达到界限时明确标记 gap/断开慢消费者并报告最后 seq, 禁止静默丢弃. 队列阈值属于后续宿主负载测试选定的实现参数, 不把未验证数值写成已确定要求.
- 不把读取线程中的 UI异常吞掉后假称输出成功; 客户端应显示可理解的本地故障信息.

## 7. 输入不卡死与有归属的取消

### 7.1 补全

- `ManagerCompleter` 使用异步或受控 worker 请求, 自动补全不阻塞 prompt-toolkit 事件循环.
- Tab 绑定不能继续同步 `list(completer.get_completions(...))`. 用异步完成回调应用结果, 检查文档版本、光标位置和请求 generation, 丢弃过期建议.
- 补全短期限, 忙碌时快速使用 stub/本地缓存. 建议 RPC 预算 300-500ms, 作为待实现调优目标.
- 补全不能为了提供建议自动 `_ensure_open` 或 `_recover_repl` 中断设备程序. 未连接/待恢复时仅返回可用缓存和状态; 显式执行请求才负责恢复.
- 同一时刻最多一个有效补全请求, 后续输入替换过期请求, 防止网络和线程堆积.
- 不能统一给所有 `ManagerClient.call` 加很短超时: 用户长脚本有合法持续运行需求. 分别规定补全、状态、排队和执行期限.

### 7.2 RPC 排队、操作期限和取消

- 给前端浏览请求传明确排队预算; 设备正在执行用户代码时及时返回 busy/排队状态, 避免只在 30 秒后显示列表失败.
- 记录 `OperationContext(client_id, request_id, method, phase, started_at, deadline, cancel_requested)`, 字段是方案建议, 使用 dataclass/TypeScript interface, 不用散乱全局 dict 拼状态.
- 增加按请求取消方法(建议 `request.cancel`), 定位 connection/clientId + requestId, 不使用全局 interrupt 代替超时取消.
- manager 同一 TCP 连接不能因为 await 一个慢操作而无法读取后续取消/status. 分离接收调度和请求任务, 限制每客户端 in-flight 数量; 底层串口操作仍单个 gate.
- `queued`: 取消等待任务, 确保以后不会执行, 不触碰设备.
- `running`: 只允许取消调用者自己的请求. 仅在串口 ownership 仍属于该请求时, 执行协议允许的有界中止/恢复; 执行结果或写入副作用不确定时明确返回未知状态, 不自动重放.
- 前端超时发取消后不继续盲目刷新. 超时/取消完成/晚到结果三者用请求状态机保证只完成一次, 控制消息有单独处理通道但不创建新串口 owner.
- `asyncio.to_thread` 的取消不会杀掉工作线程. 不能仅 wait_for 超时后释放 gate 给下一条命令; 必须等原串口工作完成或确认中止后才放行.
- 底层文件操作区分字节空闲期限和整体期限; 后台持续打印不能无限续命. 人工长脚本可维持既有无总期限运行, 但要可中断且不能冻结输入界面.
- Agent socket timeout 也需要按 monotonic 计算剩余预算, 不能每个 event 后重新获得完整等待时长.
- 真正无法中止的驱动调用必须维持明确的 stalled/recovery-required 状态. 不伪装成 ready, 不强行在同一句柄上并发下一次读写.

这部分建议与输出修复一起作为后续目标, 因为输入循环阻塞会阻止 stdout UI 回调运行. 请求取消的状态机可在终端基本修复后独立分阶段验证.

## 8. 文件级任务和保护

| 文件/区域 | 计划变更 |
| --- | --- |
| `scripts/mpyrepl/clients/repl.py` | `_handle_event` 接入输出呈现器; completion RPC 期限和异步结果; 退出前排空; 保持命令结果不重发 |
| `scripts/mpyrepl/repl/session.py` | 尾行布局、Tab 异步处理、输入/退出边界; 保护现有补全选择、历史、自动配对和缩进语义 |
| `scripts/mpyrepl/repl/output.py` (拟新增) | 纯文本/CRLF状态、已提交行/可见尾行、单 UI 更新通道 |
| `scripts/mpyrepl/runtime/transport.py` | 提示符状态、旁路输出 sink、移除 idle 任意 find/delete 和正常同步的粗暴 drain |
| `scripts/mpyrepl/runtime/response_stream.py` (拟新增) | 请求专属帧的增量解析、剩余字节转发、损坏帧诊断 |
| `scripts/mpyrepl/runtime/filesystem.py` | execute/exec_json 旁路输出, 查询帧, 上传下载流式记录; 保留既有临时文件保护 |
| `scripts/mpyrepl/completion/device.py` | 补全结果帧和旁路输出; 失败不能丢弃全部 stdout/stderr |
| `scripts/mpyrepl/manager/session.py` | 统一解码/sink、补全不隐式恢复、操作期限和安全取消 |
| `scripts/mpyrepl/manager/server.py` | 有序 writer、操作归属、每连接任务调度、定向取消和队列预算 |
| `scripts/mpyrepl/manager/protocol.py` | 新 capability/错误类型/可选 seq 和上下文定义, 明确兼容 |
| `scripts/mpyrepl/clients/agent.py` | 总期限与取消, 保持标准库入口和单条 JSON |
| `src/board/serialManagerClient.ts`, `mpyClient.ts`, `serialManagerTypes.ts` | 排队预算、取消与 busy状态, 不因列表超时重启共享 owner |
| 已有 Python tests + 新 output/response parser tests | 协议字节、UI渲染、旁路输出、超时取消回归 |
| `tests/serialManagerClient.test.ts`, `tests/mpyClientManagerCoverage.test.ts` 等 | timeout/late response/queued cancellation 不触碰其他请求 |
| `docs/custom-python-repl*`, `docs/agent-cli*`, `docs/TEST_README.md` | 输出语义、归属限制、busy/取消、验证范围 |
| `package*.json` | 实施通过后由 build.sh patch 更新, 计划阶段不改 |

相关核心未发现明确人工作者保护记录, 来源未知. 按现有 type hints、operation gate、标准库 CLI 和模块布局实现, 不扩大为整文件格式重写. `_vendor` 原则上不修改; 修复扩展的调用方式和生命周期.

0.4.40 的懒加载、原始文件下载去重、启动并发和 soft-reset 改动均须保留. 当前未提交工作不授权本计划自动提交. 不修改已归档计划.

## 9. 实施顺序与完成门槛

### 阶段 A: 先修显示和输入循环

- 建立能稳定重现 CRLF 分片覆盖的终端测试, 覆盖无换行尾行和 prompt 切换.
- 实现单输出呈现器, 自动补全和 Tab 异步化/短期限, 取消过期补全.
- 完成标准: 各种分片得到相同逻辑显示, 输出期间输入/方向键/Ctrl-C响应, 不因取消补全中断设备.
- 可以先交付小版本, 但明确内部查询吞输出尚未修完, 不宣称全链路完整.

### 阶段 B: 修普通输出分流

- 显式 prompt 状态、统一 console sink、fs/helper/补全响应帧.
- 完成标准: 帧外每个普通字节只转发一次, 包括 `[`、`>`、中文跨片, 超时仍保留尾部.
- 先解决短操作, 再加入下载/上传每块标记. 帧内交错必须被检测, 不篡改内容后继续.

### 阶段 C: 消除隐形排队和广播顺序风险

- 操作上下文、按请求取消、同连接控制请求可响应、有界有序 writer.
- 完成标准: UI 超时后的排队任务不再偷偷执行; 取消 A 不中断 B; 慢控制台不拖死 manager; 连续事件不能无限延后整体期限.
- 成功/失败输出与 RPC 完成严格排序, 超载/断线显式报告.

### 阶段 D: 全量回归和打包

- 统一执行 TypeScript/Jest/Python覆盖率, 检查原 soft-reset/raw-paste/传输/启动回归.
- 用 build.sh patch 打包, 校验 VSIX 中实际源码, 不安装.
- 后续实机只在获准测试会话进行; 当前用户仅允许的查看不能扩大为主动打印测试、复位或文件写入. 测试板历史指定 ESP32_S3_AMOLED, cstptesp32s3 在用, 不得混用.

## 10. 验证矩阵

### 文本与终端

- 同一文本逐字节分片、所有双分片切点、固定 7/64/4096 分片和固定种子随机分片.
- 样例所有进度行, `[` 单独到达、CR/LF跨片、空行、末尾无LF、中文/emoji跨UTF-8字节、正文 `>`/`>>>`.
- 裸CR进度覆盖、长行折行、窗口缩放、输出期间输入/自动补全/Tab/Ctrl-C.
- prompt进入/退出、用户脚本执行结束、manager断线时的尾行排空, 不能重放或丢失.
- 断言虚拟终端最终屏幕/scrollback和内容计数; 仅 assert write() 被调用不足以证明显示正确. 上轮 pexpect VT100 只作本地复现依据, CI 使用可跨平台的已验证终端模拟方案, 必要依赖仅放测试 requirements, 不进入 Agent/runtime.

### 协议和输出

- 内部帧前后各只有一个 `[`; 帧标记跨片; 输出含近似 marker; 多个相邻帧; 错nonce; 长度不符; 错误帧; EOF前残余.
- 后台数据插入帧内部: 必须失败且不能把错数据当文件/补全结果; 不以“恢复了JSON”为通过标准.
- 独立 prompt readiness 与普通 `>`; EOF附近背景打印; 多字节字符跨操作/idle边界.
- 下载空文件、小文件、原 4026 字节问题文件边界、大文件, 字节相等+长度/内容哈希; 错误不覆盖旧文件, 不暴露Base64内部数据到终端.
- 每个消费者按 seq 接收相同顺序; 执行返回stdout与广播不能导致控制台重复.

### 等待和取消

- Agent长exec正在运行,刷新/展开返回busy或有界排队,终端仍可编辑.
- 队列取消后活动操作结束,被取消请求也不能再执行.
- 取消/完成/超时同一瞬间,响应只结算一次;同连接和不同连接请求ID冲突不能误取消.
- 连续背景输出、慢客户端、丢ACK、worker不能立即退出时,不能提前放开串口gate.
- completion慢响应过期只丢建议,不丢控制台输出;用户已改变输入时不应用旧补全.

### 真实命令

已有定向测试命令:

```bash
python3 -m unittest discover -s scripts/mpyrepl/tests -p 'test_repl_client.py'
python3 -m unittest discover -s scripts/mpyrepl/tests -p 'test_session_behavior.py'
python3 -m unittest discover -s scripts/mpyrepl/tests -p 'test_transport_behavior.py'
python3 -m unittest discover -s scripts/mpyrepl/tests -p 'test_fs_ops.py'
python3 -m unittest discover -s scripts/mpyrepl/tests -p 'test_manager_session.py'
python3 -m unittest discover -s scripts/mpyrepl/tests -p 'test_manager_server.py'
npx jest --runInBand tests/serialManagerClient.test.ts tests/mpyClientManagerCoverage.test.ts
./build.sh patch
git diff --check
```

新增测试文件的命令在实现时按真实路径补充. 必须区分宿主模拟、实际终端渲染、设备串口和真实文件系统验证, 不以其中一种代替其他.

## 11. 兼容与交付

- 新事件字段尽量可选, 保持旧stdout/stderr字段和单条Agent JSON. 新取消/输出序号由 manager.hello capabilities 明确协商.
- 旧 manager 不支持按请求取消时, 不能调用全局 manager.cancel 冒充; 返回能力不足说明并保留原会话, 不静默关闭共享服务.
- 当前协议版本是否必须递增, 以最终是否改变必需消息语义判断; 不只因为新增可选字段盲目升级, 也不在破坏兼容时继续宣称同版本.
- 内部设备 helper 与主机解析器同次注入匹配, 不要求刷固件. 固件不支持新增校验能力时应有显式兼容处理或报告不支持.
- 保持有限内存, 队列阈值与无换行尾行策略在阶段A/C负载测试记录. 默认不持久化原始输出/用户源码/凭证.
- 完成后提供release/ VSIX、验证结果、剩余硬件限制. 实际安装、替换manager和Git提交依用户请求执行.

## 本轮记录

- 2026-09-16: 只读取现有代码并形成方案, 新增本计划文档, 没有实现上述新接口、修改源码、测试设备或打包.
- 后续用户 "开始吧" 授权实施后: 已新增 LiveOutput/ConsoleLines、ResponseStream、ClientOutput,修改对应 REPL/manager/传输客户端和回归. 之前 0.4.40 改动保留.
- 阶段A已实现: 持续事件循环、完整行提交+尾行预览、CRLF跨片和异步补全. 无活动编辑时直接流式输出,下一提示符前采用显示分隔;不改变 RPC 原文. 65,536 字符尾行上限采用显示换行,不是丢字符.
- 阶段B已实现: 独立 prompt readiness、普通 console sink、nonce+字节长度的内部帧,fs/补全帧外字节转发;下载有块序号、解码长度与 SHA-256,设备要求 hashlib 或 uhashlib 的 sha256. 发送器局部函数隔离新增变量,不遗留 digest/block_index 全局变量.
- 阶段C已实现: request-cancel capability、同连接并发接收控制消息、queued/running归属和中断锁屏障、Monotonic客户端期限、文件操作总期限、有序socket writer和序号. Socket待发上限4MiB,本地待绘制上限1,048,576字符,超限明确诊断;没有无限无损保留承诺.
- 已通过定向 fs 27项、REPL 25项、console完整性15项、server22项等测试. 第一轮完整 Python 270项通过,覆盖率86.9%,其后补入取消锁和异常路径测试,待最终构建重新统计.
- pexpect VT100 屏幕回归在本机实际通过. 其他平台无该本地工具时显式跳过这一个屏幕测试,核心模型/协议测试不跳过;未增加Agent运行依赖,也未声称已经验证Windows/macOS真实终端.
- 阶段D进行中: 将使用 build.sh patch 编译/全部测试/版本递增/VSIX验证;本轮不操作设备、不安装、不提交.
- 阶段D完成: `./build.sh patch` 将版本递增至 0.4.41. 同一次交付期间补齐取消竞争/关闭故障边界后,使用 `./build.sh -S` 对最终源码重新编译、全部测试和打包,没有再次增加版本或安装中间产物.
- 最终构建: TypeScript 编译通过, Jest 29 suites / 126 tests 通过, Python 3.12 共 276 tests 通过,覆盖率86.9% (5983/6881). 一次早期构建有Jest worker退出警告;随后 `npm test -- --runInBand --detectOpenHandles` 正常退出无句柄报告,最终两轮构建也未再出现该警告.
- Python 3.14 阶段补验276项通过,覆盖率82.7%,超过80%门槛. 之后最后一处socket关闭异常保护由最终Python 3.12构建验证. 未以这些结果声称已完成Windows/macOS真实终端或硬件验证.
- VT100屏幕回归在本机通过,CR/LF逐片事件下两行进度完整;分片模型、内部帧旁路字符、真实生成的sender在模拟cooked stdout下的文件字节和SHA校验均通过. 测试设备路径使用 `/source.bin` 映射主机临时fixture,不会把Windows本地路径当设备路径.
- 新增状态字段和取消能力均为可选RPC扩展,protocolVersion保留1;旧manager没有request-cancel能力时不发送全局中断兜底. Agent仍只依赖标准库入口.
- 产物 `release/mpy-0.4.41.vsix`,SHA256 `a10c4a85a71da48a5d8c36edd5009fbe213b3f4c6f2bea4a3528ed17c0ec7b67`. CRC通过;新增3个运行模块、相关Python文件、编译后的mpyClient/serialManagerClient和中文文档均与工作树逐字节一致.
- git diff --check通过. 保留0.4.40已有未提交工作,未暂存或提交. 本轮未连接设备或更改当前manager,未安装扩展. 测试fixture使用TemporaryDirectory自动清理,没有待清理的一次性设备/主机实验脚本.
- 生效条件: 用户安装0.4.41并按共享会话使用情况安排从新版本启动manager. 原常驻进程不热加载. 无法无损解析任意线程插入同一协议帧内部的字节流,此情形明确失败;过载明确报缺口,不承诺无限输出保留.
