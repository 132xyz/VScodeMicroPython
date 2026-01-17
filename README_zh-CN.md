# MicroPython 工作台 — VS Code 的 MicroPython 文件管理器

[English](README.md)

受 Thonny 简洁性的启发，此扩展简化了在多个开发板上的 MicroPython 开发。它在 VS Code 中提供远程文件管理、集成的 REPL 和自动双向同步，从而实现更流畅的工作流程。

该扩展使用 **mpremote** 处理所有开发板交互，包括文件传输、REPL 连接和命令执行。

## 主要功能

- 📂 设备远程文件资源管理器（打开、下载文件/文件夹、上传、重命名、删除）
- 🔄 双向同步：比较本地文件与设备并同步已更改的文件
- 📝 在文件视图中创建一个新文件并在首次保存时将其上传到开发板
- 💽 通过 esptool 烧录 MicroPython 固件并自动检测开发板（目录驱动）
- 💻 集成的 MicroPython REPL 终端
- ⏯️ 向开发板发送命令（停止、软重置等）
- 🧭 文件视图显示检测到的开发板名称和状态栏显示上次自动同步时间
- 🧠 **IntelliSense 代码补全** MicroPython 模块，支持自动检测和多语言

**⚡ 连接到开发板并运行文件**
![运行文件演示](https://github.com/132xyz/VScodeMicroPython/blob/main/assets/run-file.gif?raw=true)

**🔄 自动同步本地文件夹内容**
![同步文件演示](https://github.com/132xyz/VScodeMicroPython/blob/main/assets/sync%20new%20files.gif?raw=true)

## 同步工具

这些命令在本地工作区和连接的 MicroPython 开发板之间执行完整或增量同步：

- **检查差异：** 列出本地和开发板之间新的、已更改或已删除的文件。
- **同步本地 → 开发板：** 仅上传本地文件，这些文件是新的或已修改的。
- **同步开发板 → 本地：** 仅下载开发板文件，这些文件是新的或已修改的。
- **上传所有本地 → 开发板：** 将所有非忽略的本地文件上传到设备。
- **下载所有开发板 → 本地：** 下载所有开发板文件，覆盖本地副本。
- **删除开发板上的所有文件：** 从设备中移除所有文件。

## 有用的命令（命令面板）

- `MPY 工作台：刷新` — 刷新文件树
- `MPY 工作台：检查文件差异` — 显示差异和本地独有文件
- `MPY 工作台：同步已更改文件（本地 → 开发板）` — 上传已更改的本地文件
- `MPY 工作台：同步已更改文件（开发板 → 本地）` — 下载已更改的开发板文件
- `MPY 工作台：同步所有文件` — 完整上传或下载
- `MPY 工作台：上传活动文件` — 上传当前编辑器文件
- `MPY 工作台：选择串口` — 选择设备串口
- `MPY 工作台：打开 REPL 终端` — 打开 MicroPython REPL
- `MPY 工作台：烧录 MicroPython 固件` — 使用捆绑目录和 esptool 烧录固件
- `MPY 工作台：切换工作区保存时自动同步` — 启用/禁用工作区自动同步
- `MPY 工作台：切换代码补全` — 启用/禁用 MicroPython 代码补全

## 工作区配置

该扩展在工作区根目录的 `.mpy-workbench` 文件夹中存储每个工作区的设置和清单。

- 工作区覆盖文件：`.mpy-workbench/config.json`
- 同步清单：`.mpy-workbench/esp32sync.json`

使用命令 `MicroPython 工作台：切换工作区保存时自动同步` 来启用或禁用当前工作区的自动同步。如果不存在工作区配置，扩展将回退到全局设置 `microPythonWorkBench.autoSyncOnSave`（默认：`false`）。

### 本地同步根目录

默认情况下，同步操作使用工作区根目录。您可以使用 `microPythonWorkBench.syncLocalRoot` 设置配置不同的本地根目录：

- **空（默认）**：使用工作区根目录
- **相对路径**：例如，`"src"` 或 `"micropython"` - 相对于工作区根目录
- **绝对路径**：完整路径到工作区外部的目录

当您的 MicroPython 项目文件位于工作区子目录中时，或者当您想要同步到完全不同的位置时，这很有用。

**VS Code 设置示例：**
```json
{
  "microPythonWorkBench.syncLocalRoot": "src/micropython"
}
```

请参阅 `example-workspace-settings.json` 以获取完整的配置示例。

## 代码补全

该扩展使用 Python stub 文件为 MicroPython 模块提供智能代码补全。此功能与 VS Code 的 Pylance 语言服务器集成，提供 IntelliSense 支持。

### 自动检测

代码补全在以下情况下自动启用：
- 检测到 MicroPython 项目（基于同步设置或项目结构）
- 工作区包含 MicroPython 特定文件或配置
- 通过命令或设置手动覆盖

### 多语言支持

- **英文**：默认文档语言
- **中文**：当 VS Code 语言设置为中文时自动使用
- 支持 47+ 个 MicroPython 模块的类型注解

### 配置选项

```json
{
  "microPythonWorkBench.enableCodeCompletion": "auto",
  "microPythonWorkBench.enableMultiLanguageDocs": true
}
```

- `microPythonWorkBench.enableCodeCompletion`：
  - `"auto"`（默认）：自动为 MicroPython 项目启用
  - `"manual"`：通过命令手动控制
  - `"forced"`：无论项目类型如何始终启用
  - `"disabled"`：完全禁用

- `microPythonWorkBench.enableMultiLanguageDocs`：根据 VS Code 区域设置启用多语言文档

### 手动控制

从命令面板使用 `MPY 工作台：切换代码补全` 来手动启用/禁用当前工作区的代码补全。

### 要求

- **Pylance 扩展**（推荐）：`ms-python.vscode-pylance` 以获得完整的 IntelliSense 支持
- 代码补全适用于任何 Python 语言服务器，但在 Pylance 下提供增强体验

### 自动暂停和 REPL 恢复

- `microPythonWorkBench.serialAutoSuspend`（默认：`true`）：在文件操作前关闭 REPL/运行终端以避免串口冲突，然后在操作后恢复（重新运行运行活动文件，或重新打开 REPL）。
- `microPythonWorkBench.replRestoreBehavior`（默认：`none`）：REPL 在自动暂停/同步后恢复时执行的操作：
  - `runChanged`：自动在 REPL 中运行已更改/保存的文件。
  - `executeBootMain`：发送 Ctrl-D 以便重置后重新启动自动运行 `main.py`/`boot.py` 的开发板。
  - `openReplEmpty`：重新打开 REPL 而无需发送任何内容。
  - `none`：不重新打开 REPL。

## 状态指示器

- 状态栏显示 `MPY: 自动同步 开/关`、取消所有任务按钮，以及 `MPY: 上次同步 <时间>` 在每次自动同步运行后。
- 文件视图标题在选择固定串口后显示检测到的开发板名称/ID。

## 要求

- **Python 3.13.2**
- **Mpremote v1.26.1**
- **固件烧录：** `esptool` 在同一 Python 环境中可用。通过 `pip install esptool` 安装。该扩展检查 `python`、`py -3`（Windows）和 PATH 中的 `esptool.py`/`esptool`。
- **代码补全（可选）：** [Pylance](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-pylance) 扩展以获得增强的 IntelliSense 支持
- 如果需要选择特定解释器，可以在扩展设置中调整 Python 路径。

## 快速开始

1. 从 VS Code 市场安装扩展，或在本地构建并安装 `.vsix`：

```bash
# 构建包（需要 vsce）
npm ci
npm run compile
npm run package
# 然后在 VS Code 扩展中选择 "Install from VSIX" 安装生成的 .vsix
```

2. 确保本机安装依赖：

```bash
# Python 3.8+（建议 >=3.10），mpremote 与 esptool
python -m pip install --user mpremote esptool
```

3. 打开包含 MicroPython 项目的工作区，选择串口（`MPY 工作台：选择串口`），在文件视图中进行同步/上传操作。

## 开发与测试

- 构建：`npm run compile`（TypeScript 编译到 `dist/`）。
- 测试：`npm test`（Jest）。CI 配置位于 `.github/workflows/ci.yml`。
- 打包：`npm run package`（需要 `vsce`）。

## 配置项

常用设置（可在扩展设置中查看）：

- `microPythonWorkBench.syncLocalRoot`：用于同步的本地目录（默认：空，表示工作区根目录）。
- `microPythonWorkBench.autoSyncOnSave`：保存时是否自动同步（默认：`false`）。
- `microPythonWorkBench.pythonPath`：用于执行 `esptool`/辅助命令的 Python 可执行文件路径。

完整配置项请参见 `package.json` 中的 `contributes.configuration`。

## 使用要求

- **Python 3.8+** - 扩展使用 Python 运行内置的 mpremote 工具
- **mpremote** - ✅ **已内置，无需外部安装**
- **固件烧录**：需要在同一 Python 环境中安装 `esptool`。使用 `pip install esptool` 安装。
- **代码补全（可选）**：[Pylance](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-pylance) 扩展提供增强的 IntelliSense 支持
- 如需使用特定的 Python 解释器，可在扩展设置中调整 Python 路径。

- 固件目录与板子测试目前以 ESP32 系列为主（ESP32-S3、ESP32-C3）。若要支持其他板子，请先补充 `assets/firmwareCatalog.json` 条目并测试。
- 仓库已配置 CI，会在多平台和 Node.js 版本上运行构建/测试，但单元测试覆盖尚不足——建议在本地运行 `npm test` 并为核心模块（`sync`、`board`、`completion`）补充测试用例。

## 固件烧录

- 选择特定的串口（不是 `auto`），然后从命令面板或开发板操作视图运行 `MicroPython 工作台：烧录 MicroPython 固件`。
- 该扩展检测开发板，从 `assets/firmwareCatalog.json` 中选择匹配条目，下载映像，并使用 460800 波特率运行 `esptool`。
- 首先将开发板置于引导加载程序模式；烧录期间 REPL 会自动关闭以释放串口。
- 通过将条目附加到 `assets/firmwareCatalog.json` 来添加更多开发板（芯片、闪存模式/频率、偏移、下载 URL 和别名）。

## 后续步骤

- ✅ 扩大开发板兼容性（目前仅在 ESP32-S3 和 ESP32-C3 上测试）
- 🔌 扩展固件目录以超越初始 ESP32-C6 条目
- 🪟 执行完整的 Windows 测试：验证 mpremote 与 COM 端口的兼容性，并确保文件操作和 REPL 在 Windows 环境中的一致行为

## 贡献

欢迎问题和拉取请求。

## 许可证

MIT — 请参阅此仓库中的 `LICENSE` 文件。

## 致谢

- 感谢 walkline 的 code-completion-for-micropython: https://gitee.com/walkline/code-completion-for-micropython — 该项目为本仓库的 `code_completion/` 目录提供了代码补全数据。
 - 感谢 walkline 的 code-completion-for-micropython: https://gitee.com/walkline/code-completion-for-micropython — 该项目为本仓库的 `code_completion/` 目录提供了代码补全数据。
 - 感谢原始项目 `mpy-workbench`（Daniel Bustillos）提供了最初的设计与实现参考：https://github.com/DanielBustillos/mpy-workbench