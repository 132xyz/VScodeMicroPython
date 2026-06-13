# mpremote 在 Windows 下的 UTF-8 输出问题与当前仓库策略

## 问题概述

在 Windows 的 PowerShell / 终端环境下，直接通过 `mpremote` 运行设备脚本或打开 REPL 时，多字节 UTF-8 输出有时会表现为乱码、截断、卡住，或者触发宿主控制台编码相关的问题。

这类问题通常与以下因素叠加有关：

- 设备输出是按字节流到达的，UTF-8 字符可能被拆分
- 宿主终端的输出编码不一定是 UTF-8
- 终端 / TTY 行为和 VS Code OutputChannel 的行为并不完全一致
- `mpremote` 及外部终端本身并不总能屏蔽这些编码差异

## 当前仓库已经做了什么

当前仓库不是单纯停留在“提示用户改编码”的阶段，而是已经采取了两类措施：

### 1. 终端路径上的缓解

- 在 Windows 上，扩展创建 REPL / Run 终端时会优先使用 PowerShell
- 会向终端注入更偏向 UTF-8 的环境变量
- 首次运行时会尝试设置 PowerShell 的输出编码为 UTF-8

这能降低一部分 Windows 终端输出问题。扩展内部主路径现在优先通过 `mpyrepl` 做增量解码；外部手动 `mpremote` 命令仍受宿主终端影响。

### 2. 内置 Python mpyrepl 客户端

仓库现在默认使用内置 Python `mpyrepl` 客户端：

- 设置项：`microPythonWorkBench.experimentalCustomRepl`
- 文档：`docs/custom-python-repl.md` / `docs/custom-python-repl_zh-CN.md`

这条路径通过内置的 `scripts/mpyrepl` 客户端处理 REPL 输出和文件传输，当前具备：

- 增量 UTF-8 解码
- 宿主流写入时的 Unicode 安全回退
- 基于控制通道的中断 / 软重置 / 退出 / 文件系统 RPC

如果你在扩展内部 REPL 或运行活动文件时遇到 Unicode 或 Windows 控制台相关问题，当前优先验证这条 `mpyrepl` 路径。

## 推荐处理顺序

### 情况 1：问题发生在扩展内部 REPL 终端

优先顺序：

1. 确认 `microPythonWorkBench.experimentalCustomRepl` 保持默认开启
2. 确认 `microPythonWorkBench.pythonPath` 指向可用 Python
3. 确认该 Python 环境具备 `pyserial`
4. 重新打开 REPL 终端验证

### 情况 2：问题发生在扩展内部“运行活动文件”终端

该路径现在会把当前文件发送到同一个 `mpyrepl` 会话执行，执行完成后回到提示符。

可以先尝试：

1. 确保使用的是 PowerShell
2. 确保 Python / 终端输出编码配置为 UTF-8
3. 确认 `pyserial` 安装在扩展选择的 Python 环境中
4. 重新打开 REPL 后再运行活动文件

### 情况 3：问题发生在扩展外部的命令行

例如你手动执行：

```powershell
python -m mpremote connect COM4 run script.py
```

这属于扩展之外的终端路径，自定义 REPL 无法直接修复它。此时应优先从上游 `mpremote`、Python 环境和终端编码配置入手。

## PowerShell 下的最小缓解方式

如果你仍需直接使用 `mpremote` 命令行，可先尝试：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
& "C:\path\to\python.exe" -m mpremote connect COM4 run C:\path\to\script.py
```

这不是根治方案，但在一部分 Windows 终端环境中有帮助。

## 当前文档边界说明

仓库里此前提到的本地 `mpremote` 补丁目录与安装脚本目前并不是当前实现的一部分，因此这里不再把“手工覆盖 site-packages”作为主推荐方案。

当前更符合仓库现状的推荐路径是：

- 优先使用扩展内置的 `mpyrepl` 传输路径
- 对扩展外部手动执行的 `mpremote` 命令，尽量使用 UTF-8 终端配置并跟进上游修复

## 上游参考

- 相关 issue：https://github.com/micropython/micropython/issues/18659
- 相关 PR：https://github.com/micropython/micropython/pull/18670

## 相关文档

- `docs/custom-python-repl.md`
- `docs/custom-python-repl_zh-CN.md`
- `README.md`
- `README_zh-CN.md`
