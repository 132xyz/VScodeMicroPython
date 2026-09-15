# VS Code MicroPython 扩展测试说明

本文档描述当前仓库的测试体系、常用命令、覆盖范围与维护建议。它反映的是当前代码状态，而不是早期测试起步阶段的规划文档。

## 当前测试体系

仓库现在维护两套测试：

- JavaScript / TypeScript 扩展测试
	- 框架：Jest + ts-jest
	- 目录：`tests/`
	- 目标：覆盖扩展配置、同步逻辑、开发板操作、代码补全和 VS Code 交互层
- Python `mpyrepl` 测试
	- 框架：标准库 `unittest` + `trace`
	- 目录：`scripts/mpyrepl/tests/test_*.py`
	- 目标：覆盖 manager、Agent/人工客户端、transport、filesystem、session、completion 和入口分发

## 常用命令

### 运行全部 JS / TS 测试

```bash
npm test
```

### 运行 JS / TS 测试并生成覆盖率

```bash
npm run test:js:coverage
```

### 运行 Python `mpyrepl` 测试并输出本地源码覆盖率

```bash
python -m pip install -r scripts/mpyrepl/tests/requirements.txt
npm run test:py
```

### 一次性运行 JS 与 Python 覆盖率命令

```bash
npm run test:coverage
```

### 完整本地构建、测试、版本更新与打包

Windows PowerShell:

```powershell
.\build.ps1
```

Linux/macOS Bash:

```bash
./build.sh
```

两个脚本都会依次执行编译、JavaScript 测试、Python `mpyrepl` 覆盖率测试,通过后自动更新 `package.json` 与 `package-lock.json` 的版本号并生成 `release/*.vsix`.版本类型默认为 `patch`,也可传入 `minor` 或 `major`,例如 `./build.sh minor`.

修复验证完成并准备安装到 VS Code 时不要跳过版本更新,因为版本号不变可能导致 VS Code 不提示重新加载/重启扩展.`.\build.ps1 -S` 和 `./build.sh -S` 只适合临时诊断打包.

### 监听模式运行 Jest

```bash
npm run test:watch
```

## 当前测试文件面

### JS / TS 测试

当前 `tests/` 下已覆盖的主要方向包括：

- 同步与文件路径：
	- `activeFileSync.test.ts`
	- `pathMapping.test.ts`
	- `syncCommandsCoverage.test.ts`
	- `syncLocalizationCoverage.test.ts`
	- `syncView.test.ts`
- 开发板与串口路径：
	- `boardOperationsCoverage.test.ts`
	- `boardMpremoteCommandsCoverage.test.ts`
	- `esp32FsCoverage.test.ts`
	- `MpRemoteManagerCoverage.test.ts`
	- `mpremoteCommands.test.ts`
	- `pythonInterpreterCoverage.test.ts`
	- `fileCommandsCoverage.test.ts`
	- `decorationsCoverage.test.ts`
- 代码补全与 stub 管理：
	- `codeCompletionCoverage.test.ts`
	- `completionPythonConfig.test.ts`
	- `stubSupport.test.ts`
	- `stubIndex.test.ts`
	- `stubOverlay.test.ts`
- 基础能力与回归保护：
	- `coreUtilityCoverage.test.ts`
	- `extensionSmoke.test.ts`

### Python `mpyrepl` 测试

当前 `scripts/mpyrepl/tests/` 下已覆盖的主要方向包括：

- `test_transport_behavior.py`
	- raw REPL transport、超时、soft reset、协议边界
	- 软复位/进入 raw REPL 的启动空闲和真实提示符延迟、共享截止时间、空闲临界点数据读取、超时尾部输出和 I/O 错误分类
- `test_session_behavior.py`
	- prompt 会话、多行输入、缩进、按键行为、补全触发
- `test_support_modules.py`
	- CLI 参数解析、补全模块、控制模块等辅助组件
- `test_main_helpers.py`
	- `app.py` 分发、异步 REPL 主循环、控制通道、Unicode 输出回退、soft reset 路径
- `test_manager_descriptor.py`、`test_manager_protocol.py`、`test_manager_server.py`、`test_manager_session.py`
	- NDJSON 协议、客户端角色、串口操作排队、事件广播和共享设备会话
	- soft-reset 同步超时保留串口、下一条命令原句柄恢复且不重复复位、并发恢复门控和 CLI 期限验证
- `test_agent_client.py`、`test_repl_client.py`
	- 会话发现、冷启动、串口生命周期、JSON 契约、Agent 命令映射、人工 REPL manager 连接和空闲提示符实时输出
- `test_fs_ops.py`、`test_operation_gate.py`
	- 文件传输、进度事件和串口操作串行化

## 当前验证快照

以下数字是 2026-09-15 宿主侧验证快照,不代表长期冻结指标:

- JS / TS
	- 26 个 test suites
	- 112 个 tests
- Python `mpyrepl`
	- 250 个 tests
	- Python 3.12 递归包源码覆盖率: 89.2%

## 测试基础设施与约定

### JS / TS 侧

- `jest.config.js`：Jest 配置入口
- `tests/__mocks__/vscode.ts`：VS Code API mock
- `tests/setup.ts`：全局测试初始化与常用 mock
- `package.json`：统一暴露测试与覆盖率脚本

### Python 侧

- `scripts/mpyrepl/tests/run_with_coverage.py`
	- 递归统计 `scripts/mpyrepl/` 运行包源码,排除 `_vendor/` 和 `tests/`
- `scripts/mpyrepl/tests/requirements.txt`
	- 当前测试依赖 `pyserial`

## 当前测试策略

仓库当前更偏向以下策略：

- 优先增加可局部验证、可复审的小型测试
- 尽量通过外部环境模拟与 mock 提升覆盖率，而不是为了测试去大规模重构生产代码
- 对错误分支、降级路径和平台差异做有针对性的覆盖
- 在测试内部抑制预期内的 console 噪音，避免 CI 日志被误导性错误信息淹没
- 硬件相关行为优先验证“控制流”和“命令构造”，真实设备行为仍需上板补充验证

## 新增测试时的建议

1. 先选局部可验证的控制路径，不要一开始就从重 I/O 或重终端耦合路径下手。
2. 对 VS Code API、文件系统、子进程、串口等边界依赖使用窄 mock，而不是写过度复杂的全集成测试。
3. 新增覆盖率测试时，优先覆盖错误分支、平台分支、恢复逻辑和回退逻辑。
4. 如果测试会触发预期中的 warning / error 输出，在测试里显式接管 console，避免污染日志。
5. 修改测试结构或入口命令后，同步更新本文档。

## 软复位同步回归

`test_transport_behavior.py` 使用 FakeClock/FakeSerial 模拟 boot.py 静默、banner 分片、实际 `>` 延迟和截止时间临界点,验证整体期限仍有界,且不会在 100ms 无输出时误报.最后的提示符必须被保留给下一次执行,同步超时仍要转发未匹配标记的输出尾部.

`test_manager_session.py` 验证超时不关闭串口、不发 stopped,下一条命令原句柄恢复且不重复软复位,并覆盖恢复失败、并发恢复、补全缓存清理和真实 I/O 错误的断线分支.`test_manager_server.py` 与 `test_agent_client.py` 验证期限参数、退出码 5 和单条 JSON 错误细节.

这些是纯宿主模拟回归.本次没有连接物理串口、附着已有 manager 或执行真实设备复位,不代表 Windows/macOS 串口驱动或硬件验收.

## 下载发送器回归

`scripts/mpyrepl/tests/test_fs_ops.py` 会执行实际生成的下载发送程序,通过模拟 stdout 的主输出与副输出短写行为,检查二进制流自动补写是否导致尾部重复.这属于主机模拟,不是固件或真实设备测试.

回归覆盖空文件、Base64 尾部补齐、4096 字符附近的输出边界、包含 `0..255` 的二进制内容,以及接收回调按 1、7、4096 字节拆分的情况.成功时核对完整文件和进度;重复或非法尾部必须继续报错,保留旧目标并清理 `.mpydownload`.

定向运行:

```bash
python3 -m unittest discover -s scripts/mpyrepl/tests -p 'test_fs_ops.py'
```

实机验证应使用明确获准的测试板和独立 manager 会话,保留目标 `dupterm` 条件,下载到主机临时目录并核对长度及哈希.测试样本不覆盖既有文件,结束后清理恢复.通过 `repl.exec` 单独执行新发送器只验证设备输出,不能代替新版本 manager 的原生 `fs.readFile`、流式进度和 VS Code 下载界面验收.

## 仍值得继续补强的区域

- `src/board/` 下仍有部分真实运行时路径依赖硬件或终端状态，覆盖率仍低于纯逻辑模块
- 自定义 REPL 与默认 `mpremote` REPL 的切换边界仍应继续补充回归测试
- Windows / macOS 平台差异路径需要持续防回归
- 与真实开发板强耦合的行为，仍应通过手工硬件验证补充信心
