# 文件树按需加载与 manager 启动修复

状态: 授权的宿主侧实现、测试和打包已完成, 归档后不再修改. 初始基线 `b1d4df2`, 初始工作树干净. 未执行设备/GUI 实测.
授权: 本会话用户于 2026-09-16 明确要求 "不用全量扫描...开始修复吧", 承接此前文件树、协议超时和 manager/raw-paste 启动问题分析.

## 目标与边界

- 浏览文件树只读取目标目录的直接子项, 刷新使用配置 rootPath, 展开才读取子目录.
- 合并重复目录读取与并发 manager 启动, 防止重复进程/相互关闭.
- 协议同步超时保留串口和共享会话; 真正 I/O 失败保留原断线处理.
- raw-paste 正确处理提前终止和流控, 失败后用有界 Ctrl-C 中止并消费结束确认. 不盲目重发用户源码或发送 Ctrl-D 复位.
- 不操作任何设备、现有 manager 或安装扩展. 全量同步的 fs.tree 接口保持递归语义.

## 现状与证据

- refreshFileTreeCache/populateFileTreeCache 和 lsTyped 的 TTL 路径会请求 fs.tree('/'), 逐项 stat 后一次输出 JSON.
- 外层 tree RPC 为 60 秒, 底层短命令 follow 默认 10 秒无输出超时, 异常被统一视为 transport_lost.
- ensureManagerStarted 和 SerialManagerProcess.start 无正在启动请求合并, 共享 stderr/child 可被并发覆盖.
- raw_paste_write 仅在额度归零时读取流控, 错误直接返回; startup helper 注入失败仅 close.
- 未发现上述区域明确的人工作者保护标记; 作者未知. 本次只按用户授权修改相关行为和必要生命周期边界, 不整体格式化或无关重构.

## 方案与文件范围

1. `src/board/mpremote.ts`: directory cache + in-flight + generation, 规范化空路径/根路径, 空结果有效; refresh 失效目录缓存并读取配置 rootPath, 不再生成全量 tree-paths.json. 保持 debug 与同步显式 tree 请求.
2. `src/core/utilityOperations.ts`: 刷新请求合并/现有视图缓存配合(如确有必要).
   `src/board/esp32Fs.ts`: 用刷新代次避免迟到目录结果覆盖界面节点缓存.
3. `src/board/serialManager.ts`: 同设备启动共享 Promise, 启停串行化, 失败清理, 显式关闭不得留下延迟启动进程.
4. `src/board/serialManagerProcess.ts`: start/stop 生命周期并发保护, 使用局部 stderr, 取消正在准备/重试的启动.
5. `scripts/mpyrepl/runtime/transport.py`: 将协议 EOF 超时转为 ReplSyncError; raw-paste 持续消费流控、提前终止、完整等待 ACK; 明确传输中状态和有界中止. raw entry 可终止残留 reader.
6. `scripts/mpyrepl/manager/session.py`: 执行/fs 的同步异常复用上版 replReady=false 恢复路径, 不标断线.
7. `tests/` 与 `scripts/mpyrepl/tests/` 的对应正式回归: 慢/空/并发/失效目录、启动并发/取消/失败重试、上传流控/中止、fs 超时保留句柄.
8. 相关 README、custom-python-repl、agent-cli、TEST_README 文档; `package*.json` 由 build.sh patch 增量.

## 阶段与验证

- [x] 完成目录缓存、启动和协议回归, 对照已记录的旧代码问题建立行为断言.
- [x] 最小实现与定向测试; 核对浏览只调用 listdir, 失败操作无自动重发.
- [x] 文档同步与 `./build.sh patch`: 编译、Jest、Python 覆盖率、release/打包.
- [x] `git diff --check`, VSIX 源码/CRC 核验, 记录结果和未执行硬件验证.

## 风险与兼容

- 目录缓存以串口+目录隔离, clear generation 防止旧响应覆盖新刷新. 多个读取失败后必须可重试, 缓存过期只重新读取当前目录.
- 用户显式关闭必须串行地等待/取消正在启动的本实例, 不触碰外部服务; 后续显式打开可重新启动.
- 源码是否执行可能不确定, 协议异常不自动重发操作. Ctrl-C 中止可能打印 KeyboardInterrupt, 正常保留错误诊断.
- 全量同步仍可能受设备文件系统耗时影响; 本次不修改为后台全盘扫描或添加设备探测.
- 保存实际构建产物, 不自动安装或提交. 不创建一次性设备测试文件.

## 执行记录

- 2026-09-16: 已读取现有源码、回归和构建约定, 开始实施. 沿用本会话已读取的 project-doc-architect 文档流程.
- TypeScript 编译通过; 第一轮完整 Jest 29 suites / 124 tests 通过, Python 256 tests 通过, 覆盖率 89.2% (5601/6276). 此后补入界面迟到响应回归和相关文档, 待 build.sh 最终重验.
- 移除了浏览路径中的全量树构造和持久化, 保留同步/调试的显式递归接口. raw-paste abort 只用 Ctrl-C, 若设备本身提前结束则按协议用 Ctrl-D 确认该结束, 不用于发起软复位.
- 最终 `./build.sh patch` 完成: TypeScript 编译通过, Jest 29 suites / 125 tests 通过, Python 3.12 共 256 tests 通过, 覆盖率 89.2% (5601/6276). 版本 0.4.39 -> 0.4.40.
- 产物 `release/mpy-0.4.40.vsix`, CRC 校验无错误. Python transport/session、编译后 mpremote/serialManager/serialManagerProcess/esp32Fs/utilityOperations 和抽查文档逐字节匹配工作树.
- SHA256: `e3ef68bb6210f66e4d08c43841696e2f0a8ac97dd018457f60929a14497c6205`. git diff --check 通过, 保留原文件行尾风格, 未全文件格式化.
- 本次未创建一次性脚本或设备样本, 无实验文件待清理. 未连接设备、附着或终止任何现有 manager, 未安装扩展, 未暂存或提交 Git.
- 实测性能、设备 USB/串口驱动行为仍待单独获准后验证. 使用新版功能需从 0.4.40 启动 manager; 旧进程不会热加载. 原全量下载计划保持原状.
