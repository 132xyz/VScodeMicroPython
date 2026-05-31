# 自定义 Python REPL

[English](custom-python-repl.md)

## 概述

MicroPython 工作台可以把默认的 `mpremote` REPL 终端替换为位于 `scripts/mpyrepl` 下的实验性 Python 客户端。

这条实现路径主要用于改善纯 `mpremote connect` 终端难以处理的交互体验，尤其是：

- 主机侧多行编辑
- 更丰富的补全行为
- 更稳妥的 Unicode 输出处理
- REPL 进程持续运行时的带外中断 / 软重置控制

## 作用范围

开启 `microPythonWorkBench.experimentalCustomRepl` 后，只会替换 REPL 终端路径。

以下能力仍然继续走 `mpremote`：

- 开发板文件浏览
- 开发板文件同步
- `运行活动文件`
- 大多数非 REPL 的开发板操作

排障时要特别注意这一点：自定义 REPL 可以改善交互式终端体验，但不会替代整套开发板传输栈。

## 使用要求

- 必须先选择固定串口，不能用 `auto`
- `mpyrepl` 脚本建议使用 Python 3.9 及以上
- 所选 Python 解释器中需要可导入 `pyserial`
- 在完整扩展工作流中仍建议安装 `mpremote`，因为同步、浏览和运行文件仍依赖它

推荐直接在统一的 Python 环境中安装：

```bash
python -m pip install --user mpremote
```

## 在 VS Code 中启用

你可以在工作区设置或用户设置中开启：

```json
{
  "microPythonWorkBench.experimentalCustomRepl": true
}
```

推荐同时搭配以下设置：

```json
{
  "microPythonWorkBench.pythonPath": "",
  "microPythonWorkBench.enableCodeCompletion": true,
  "microPythonWorkBench.serialAutoSuspend": true,
  "microPythonWorkBench.replRestoreBehavior": "openReplEmpty"
}
```

之后执行：

1. `MicroPython 工作台：选择串口`
2. `MicroPython 工作台：打开 REPL`
3. 扩展会启动内置的 `scripts/mpyrepl/__main__.py`，而不是 `mpremote connect`

## 它新增了什么

### 1. 主机侧编辑

REPL 提示符由 prompt-toolkit 实现，而不是完全依赖开发板侧的行编辑。

当前已具备：

- 多行编辑
- Python 语法高亮
- 输入历史
- 针对完整 / 不完整代码块的智能 Enter 行为
- Tab 在“缩进”和“补全选择”之间切换
- 感知缩进层级的 Backspace 处理

### 2. 补全来源

当前补全会合并以下来源：

- Python 关键字
- 主机侧 builtin
- 一组常见 MicroPython 模块默认候选
- 当前 REPL 会话中从成功执行代码里记录下来的符号
- 从当前 stub 根目录发现的顶层模块
- 通过 `dir()` 查询设备对象属性得到的点式运行时补全

因此，当以下两点同时满足时，补全效果最好：

- 扩展里已经开启代码补全
- 当前 REPL 会话已经导入或定义过你要补全的名字

### 3. 控制通道动作

自定义 REPL 启动后，扩展会通过系统临时目录下的 JSON 控制文件与该 Python 进程通信。

当前支持的控制命令包括：

- `interrupt`
- `soft-reset`
- `interrupt-reset`
- `exit`

扩展中的中断、停止、关闭等命令，正是通过这个控制通道作用到持续运行的 REPL 进程上的，而不是每次都直接杀掉整个终端。

### 4. Unicode 处理

Python 客户端会对 REPL 输出进行增量解码，并在宿主终端编码无法表示目标文本时使用更安全的写出回退逻辑。

这使得它在 Windows 和混合编码宿主环境下，比直接依赖普通终端输出更稳妥。

## REPL 内部常用控制

- `Ctrl-D`：请求软重置
- `Ctrl-X`：退出当前提示符
- `Ctrl-]`：退出当前提示符
- `:q`、`:quit`、`:exit`：以单行元命令退出
- `Ctrl-C`：尽可能转发为设备中断

## 与自动挂起 / 恢复的关系

自定义 REPL 与默认 REPL 一样，会接入扩展级别的挂起 / 恢复流程。

当 `microPythonWorkBench.serialAutoSuspend` 开启时：

- 同步前会先关闭 REPL，释放串口
- 操作结束后，扩展会在适当时机恢复 REPL
- `microPythonWorkBench.replRestoreBehavior` 仍然决定恢复后的 REPL 是保持空白、发送软重置，还是重新导入刚同步的文件

## 在源码仓库中手动运行

开发仓库时，也可以直接运行该客户端：

```bash
python scripts/mpyrepl/__main__.py --port COM4 async-repl
```

如果要显式指定 stub 根目录：

```bash
python scripts/mpyrepl/__main__.py --port COM4 async-repl --stub-root .mpy-workbench/pyi
```

常用可选参数包括：

- `--baudrate`
- `--follow-timeout`
- `--control-file`
- `--dir-query-timeout`

## 当前限制

- 这仍然是一条实验性路径。
- 它只替换 REPL 终端，不替换扩展完整的传输链路。
- 运行时点式补全依赖实时设备状态，也可能超时。
- raw REPL 会独占串口，因此同步和文件操作仍然需要先挂起 REPL。
- 如果所选解释器低于 Python 3.9，或缺少 `pyserial`，启动会失败。

## 故障排查

### REPL 无法启动

优先检查：

- 是否已经选择了固定串口
- `microPythonWorkBench.pythonPath` 是否指向有效 Python 解释器
- 该解释器是否能够导入 `serial`

### 补全能力太弱

优先检查：

- `microPythonWorkBench.enableCodeCompletion` 是否开启
- 是否已经安装并选中了 stub 包
- 当前 REPL 会话是否已经导入目标模块或定义了目标符号

### 中断或软重置感觉延迟

客户端内部会通过串口操作门控来串行化协议操作。如果当前正有阻塞执行在进行，请求到达后通常会在当前操作让出控制权后应用。

### Windows 终端输出仍然有问题

如果问题出现在扩展内部 REPL 终端，优先尝试自定义 REPL 路径。

如果问题发生在外部 shell 手动执行 `python -m mpremote ...`，那仍然更多属于上游 `mpremote` 或终端路径的问题。可参考 [mpremote-windows-utf8.md](mpremote-windows-utf8.md) 查看当前项目内说明。