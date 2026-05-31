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
	- 目录：`scripts/mpyrepl/test_*.py`
	- 目标：覆盖实验性自定义 Python REPL 的 transport、session、completion、控制通道和入口逻辑

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
python -m pip install -r scripts/mpyrepl/requirements-test.txt
npm run test:py
```

### 一次性运行 JS 与 Python 覆盖率命令

```bash
npm run test:coverage
```

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

当前 `scripts/mpyrepl/` 下已覆盖的主要方向包括：

- `test_transport_behavior.py`
	- raw REPL transport、超时、soft reset、协议边界
- `test_session_behavior.py`
	- prompt 会话、多行输入、缩进、按键行为、补全触发
- `test_support_modules.py`
	- CLI 参数解析、补全模块、控制模块等辅助组件
- `test_main_helpers.py`
	- `__main__.py` 入口、异步 REPL 主循环、控制通道、Unicode 输出回退、soft reset 路径

## 当前验证快照

以下数字是本次文档刷新时的本地验证快照，不代表长期冻结指标：

- JS / TS
	- 20 个 test suites
	- 74 个 tests
	- statements: 42.65%
	- branches: 28.79%
	- functions: 43.60%
	- lines: 44.57%
- Python `mpyrepl`
	- 53 个 tests
	- 本地 `scripts/mpyrepl` 源码覆盖率：81.0%

## 测试基础设施与约定

### JS / TS 侧

- `jest.config.js`：Jest 配置入口
- `tests/__mocks__/vscode.ts`：VS Code API mock
- `tests/setup.ts`：全局测试初始化与常用 mock
- `package.json`：统一暴露测试与覆盖率脚本

### Python 侧

- `scripts/mpyrepl/run_python_tests_with_coverage.py`
	- 使用 `trace` 统计 `scripts/mpyrepl/` 本地源码覆盖率
- `scripts/mpyrepl/requirements-test.txt`
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

## 仍值得继续补强的区域

- `src/board/` 下仍有部分真实运行时路径依赖硬件或终端状态，覆盖率仍低于纯逻辑模块
- 自定义 REPL 与默认 `mpremote` REPL 的切换边界仍应继续补充回归测试
- Windows / macOS 平台差异路径需要持续防回归
- 与真实开发板强耦合的行为，仍应通过手工硬件验证补充信心