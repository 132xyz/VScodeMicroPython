# MicroPython 工作台 for VS Code

[English](README.md)

MicroPython 工作台是一个面向 ESP32 类开发板及类似设备的 VS Code 扩展，聚合了开发板文件浏览、双向差异同步、运行与 REPL 终端，以及工作区级别的 MicroPython stub 管理能力。

开发板通信现在通过内置 Python 客户端 `scripts/mpyrepl` 完成, 覆盖 REPL, 运行活动文件, 串口检测和开发板文件操作。扩展主工作流不再需要 `mpremote`。

## 主要功能

- 连接开发板后的远程文件浏览、下载、上传、重命名、删除
- 基于差异比较的本地 ↔ 开发板双向同步
- 当前活动文件同步，以及可选的保存时自动同步
- 集成 REPL 终端, 并在同一会话内运行活动文件
- 开发板操作命令：中断、软重置、重连等
- 基于 stub 的 MicroPython 代码补全、安装、自动选择与 Pylance 集成
- 内置 Python REPL 客户端, 支持多行编辑、补全、成对符号编辑、文件传输和控制通道中断/重置

**连接开发板并运行文件**
![运行文件演示](https://github.com/132xyz/VScodeMicroPython/blob/main/assets/run-file.gif?raw=true)

**自动同步本地文件夹内容**
![同步文件演示](https://github.com/132xyz/VScodeMicroPython/blob/main/assets/sync%20new%20files.gif?raw=true)

## 快速开始

1. 从 VS Code Marketplace 安装扩展，或者本地构建 `.vsix`：

```bash
npm ci
npm run compile
npm run package
```

如果这个包会安装到 VS Code 中验证, 优先使用完整 PowerShell 构建流程, 这样验证通过后会自动更新扩展版本:

```powershell
.\build.ps1
```

2. 在扩展将要使用的 Python 环境中安装 `pyserial`：

```bash
python -m pip install --user pyserial
```

3. 打开工作区后，执行 `MicroPython 工作台：选择串口`，再通过文件视图或命令面板执行同步、浏览和 REPL 操作。

4. 可选但推荐：
   - 安装 Python 与 Pylance 扩展，以获得更好的补全体验。
   - 开启 `microPythonWorkBench.enableCodeCompletion`，为当前工作区启用 MicroPython IntelliSense。

## 使用要求

- 内置 `mpyrepl` helper 需要 Python 3.9+
- 扩展使用的 Python 环境中需要安装 `pyserial`
- Python 扩展 `ms-python.python` 为必需依赖
- 推荐安装 Pylance `ms-python.vscode-pylance`，以获得完整代码补全体验

如需强制使用某个 Python 解释器，请设置 `microPythonWorkBench.pythonPath`。

## 核心工作流

### 文件与同步

- `MicroPython 工作台：刷新`：重新加载开发板文件树
- `MicroPython 工作台：检查文件差异`：比较开发板文件与当前配置的本地同步根目录
- `MicroPython 工作台：同步已更改文件 本地 → 开发板` 与 `MicroPython 工作台：同步已更改文件 开发板 → 本地`：只传输变更文件
- `MicroPython 工作台：同步所有文件（本地 → 开发板）` 与 `MicroPython 工作台：同步所有文件（开发板 → 本地）`：执行完整基线同步
- `MicroPython 工作台：同步活动文件 本地 → 开发板`：仅上传当前编辑器文件，但要求该文件位于配置的同步根目录内
- `MicroPython 工作台：切换工作区保存时自动同步`：将保存时自动上传开关存入 VS Code workspaceState, 不写入 `settings.json`

工作区级别的元数据保存在 `.mpy-workbench/` 下：

- `.mpy-workbench/config.json`：旧版工作区覆盖配置
- `.mpy-workbench/esp32sync.json`：同步清单
- `.mpy-workbench/pyi/`：默认的 MicroPython stub 安装目录
- `.mpy-workbench/serial-manager.json`：供 REPL 和 Agent 客户端连接的临时本机 manager 描述文件,不要提交或共享

### REPL、运行与自动挂起

- 默认 REPL 终端通过内置 `scripts/mpyrepl/__main__.py` 客户端打开。
- `MicroPython 工作台：运行活动文件` 会把当前文件发送到该 REPL 会话执行, 输出结束后回到同一个提示符。
- 设备端代码异常会打印在 REPL 中, 不会关闭当前提示符。
- 如果主机侧 REPL 客户端自身以非零状态退出, VS Code 会保留终端, 便于查看 traceback 和诊断信息。
- 在 Windows 上，扩展会为 REPL 和 Run 终端注入更偏向 UTF-8 的环境变量与 PowerShell 输出编码设置。
- `microPythonWorkBench.serialAutoSuspend` 会在同步前关闭 REPL / Run 终端，避免串口冲突，并在同步后恢复原来的串口会话状态。
- `microPythonWorkBench.replRestoreBehavior` 用于控制自动恢复 REPL 后的行为：
  - `runChanged`：尽量把刚同步的文件重新导入到 REPL 中
  - `executeBootMain`：发送 `Ctrl-D`，让会在软重置后自动运行 `boot.py` / `main.py` 的设备重新启动
  - `openReplEmpty`：只重新打开 REPL，不发送后续命令
  - `none`：不自动重新打开 REPL

### 代码补全

- `microPythonWorkBench.enableCodeCompletion` 为当前工作区启用 MicroPython 补全接入。
- 状态栏中的 `MPY: Stub` 用于管理已安装的 stub 包。
- 当 `microPythonWorkBench.stubAutoSelect` 为开启状态时，扩展会尽量为当前连接的设备自动选择最佳 stub。
- `microPythonWorkBench.codeCompletionExtraPaths` 可将额外目录或 `.pyi` 文件合并到当前激活的 MicroPython stub 根目录。
- 如果选中的 stub 包包含 typeshed 风格的标准库布局，扩展还会同步更新 Pylance 的分析来源，以改善 MicroPython 内置符号和标准库模块的解析效果。

### 内置 Python REPL

- 内置 `mpyrepl` Python 客户端是当前开发板传输路径。
- REPL, 运行活动文件, 串口检测, 文件浏览和同步都使用同一套传输栈。
- 标准库依赖的 `agent` CLI 可以通过 `.mpy-workbench/serial-manager.json` 连接共享 manager,也能用 `connect PORT` 冷启动 manager;Agent 本身不会直接占用串口。
- 运行代码按职责组织在 `scripts/mpyrepl/{clients,manager,runtime,completion,repl}` 下,`scripts/mpyrepl/__main__.py` 保持为稳定的薄入口。
- Python 客户端提供：
  - 主机侧多行编辑
  - prompt_toolkit 补全
  - 会话内符号跟踪
  - 基于共享 manager 的中断、软重置、执行和文件系统 RPC
  - Windows 与混合编码主机下更稳妥的 Unicode 输出

详见中文专题文档 [docs/custom-python-repl_zh-CN.md](docs/custom-python-repl_zh-CN.md) 和完整的 [Agent CLI 参考](docs/agent-cli_zh-CN.md)。

## 常用配置项

以下设置最值得优先关注：

- `microPythonWorkBench.connect`：固定串口，例如 `COM3` 或 `/dev/ttyUSB0`
- `microPythonWorkBench.connectOnActivate`：允许扩展激活时自动从开发板填充文件树；默认关闭，避免意外占用串口
- `microPythonWorkBench.syncLocalRoot`：本地同步根目录，可为工作区相对路径或绝对路径
- `microPythonWorkBench.rootPath`：开发板侧根路径，例如 `/` 或 `/lib`
- `MicroPython 工作台：切换工作区保存时自动同步`：保存时自动上传的命令/视图开关，按工作区保存在扩展状态中
- `microPythonWorkBench.serialAutoSuspend`：同步前后自动挂起并恢复串口会话
- `microPythonWorkBench.replRestoreBehavior`：自动恢复 REPL 后的行为
- `microPythonWorkBench.pythonPath`：为辅助脚本指定解释器
- `microPythonWorkBench.enableCodeCompletion`：启用工作区级别的 MicroPython 补全
- `microPythonWorkBench.stubInstallPath`：工作区内 stub 安装目录
- `microPythonWorkBench.stubAutoSelect`：自动选择最合适的已安装 stub
- `microPythonWorkBench.codeCompletionExtraPaths`：向当前 stub 根目录合并额外 `.pyi` 路径
- `microPythonWorkBench.usePyRawList`：高级兼容/调试开关，改用旧的 Python raw REPL 列目录 helper, 而不是 serial manager 文件树/缓存路径

完整配置项请查看 `package.json` 中的 `contributes.configuration`。

## 常用命令

- `MicroPython 工作台：选择串口`
- `MicroPython 工作台：刷新`
- `MicroPython 工作台：打开 REPL`
- `MicroPython 工作台：打开串口监视器`
- `MicroPython 工作台：运行活动文件`
- `MicroPython 工作台：中断 (Ctrl-C, Ctrl-B)`
- `MicroPython 工作台：软重置 (Ctrl-D)`
- `MicroPython 工作台：检查文件差异`
- `MicroPython 工作台：同步已更改文件 本地 → 开发板`
- `MicroPython 工作台：同步已更改文件 开发板 → 本地`
- `MicroPython 工作台：同步所有文件（本地 → 开发板）`
- `MicroPython 工作台：同步所有文件（开发板 → 本地）`
- `MicroPython 工作台：切换工作区保存时自动同步`
- `MicroPython 工作台：切换代码补全`

## 构建、测试与打包

Windows 本地验证并生成可安装包时, 推荐使用:

```powershell
.\build.ps1
```

`build.ps1` 会先编译扩展, 再运行 JavaScript 测试和带覆盖率门槛的 Python `mpyrepl` 测试, 全部通过后使用 `npm version patch --no-git-tag-version` 自动更新 `package.json` 与 `package-lock.json` 中的版本号, 最后把 `.vsix` 输出到 `release/`。修复已经验证正确并准备安装到 VS Code 时不要使用 `-S`, 否则扩展版本号不变, VS Code 可能不会提示重新加载/重启扩展。`.\build.ps1 -S` 只用于临时诊断打包, 并且必须明确接受版本不变。

手动局部检查命令:

```bash
npm run compile
npm test
npm run test:js:coverage
npm run test:py
npm run test:coverage
npm run package
```

当前仓库测试分为两条主线：

- JavaScript / TypeScript 扩展测试：基于 Jest + ts-jest，位于 `tests/`
- Python `mpyrepl` 测试：位于 `scripts/mpyrepl/tests/test_*.py`

CI 当前运行于 GitHub Actions，覆盖：

- `ubuntu-latest`、`windows-latest`、`macos-latest`
- Node.js 24 和 22
- Python 3.11

工作流当前使用 `actions/checkout@v6`、`actions/setup-node@v6`、`actions/setup-python@v6`。

更多测试细节请参见 [docs/TEST_README.md](docs/TEST_README.md)。

## 相关文档

- [docs/custom-python-repl.md](docs/custom-python-repl.md)
- [docs/custom-python-repl_zh-CN.md](docs/custom-python-repl_zh-CN.md)
- [docs/agent-cli.md](docs/agent-cli.md)
- [docs/agent-cli_zh-CN.md](docs/agent-cli_zh-CN.md)
- [docs/TEST_README.md](docs/TEST_README.md)
- [docs/mpremote-windows-utf8.md](docs/mpremote-windows-utf8.md)
- [docs/repl_architecture_plan.md](docs/repl_architecture_plan.md)

## 当前限制

- 当前兼容性验证仍主要集中在 ESP32 系列，尤其是 ESP32-S3 与 ESP32-C3。
- 部分遗留模块和命令名称仍包含 `mpremote` 以保持兼容, 但主传输路径已经使用 `mpyrepl`。
- 部分贴近硬件的 board/runtime 路径覆盖率仍低于纯工具和配置逻辑，因此涉及真实开发板行为时仍建议上板验证。
- 自动固件烧录已从扩展中移除，请在扩展外使用 `esptool` 或厂商工具完成烧录。

## 贡献

欢迎提交 issue 和 pull request。

## 许可证

MIT。详见 `LICENSE`。

## 致谢

- 感谢 walkline 的 code-completion-for-micropython: https://gitee.com/walkline/code-completion-for-micropython
- 感谢 Daniel Bustillos 的原始 `mpy-workbench` 项目：https://github.com/DanielBustillos/mpy-workbench
