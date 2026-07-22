# 自定义 Python REPL

[English](custom-python-repl.md)

## 概述

MicroPython 工作台默认使用位于 `scripts/mpyrepl` 下的内置 Python 客户端作为开发板传输路径。

这条实现路径用于避开纯 `mpremote connect` 终端难以处理的交互体验，尤其是：

- 主机侧多行编辑
- 更丰富的补全行为
- 更稳妥的 Unicode 输出处理
- REPL 进程持续运行时的带外中断 / 软重置控制

## 作用范围

REPL, 运行活动文件, 中断/重置, 串口列表, 开发板文件浏览和同步都会走内置 `mpyrepl` helper 路径。旧的实验 REPL 路径已经不是单独可开启的设置项。

## 包目录结构

`scripts/mpyrepl/__main__.py` 是扩展和直接 CLI 调用共用的稳定入口.它负责配置包路径,在加载串口或 TUI 依赖前优先分流 `agent`,其他命令交给 `app.py` 分发.

运行代码按职责划分:

- `clients/`: 人工 REPL 和仅依赖标准库的 Agent 客户端
- `manager/`: NDJSON 协议、服务端、排队和共享设备会话
- `runtime/`: 串口传输、文件系统操作、数据模型、解码和操作门控
- `completion/`: 补全解析、stub 索引、会话符号、回退候选和设备查询
- `repl/`: 提示会话、编辑行为、语义处理、兼容控制通道和异步运行器
- `tests/`: Python 单元测试、测试依赖和递归覆盖率运行器

内部导入统一使用唯一的 `mpyrepl.*` 包身份.`_vendor/` 继续保持隔离,仅由需要 prompt-toolkit 和 Pygments 的交互路径通过 bootstrap 加载.

## 使用要求

- 必须先选择固定串口，不能用 `auto`
- `mpyrepl` 脚本建议使用 Python 3.9 及以上
- 所选 Python 解释器中需要可导入 `pyserial`
如果当前解释器缺少 `pyserial`，扩展会在启动开发板操作前提示安装到所选 Python 环境中。

推荐直接在统一的 Python 环境中安装：

```bash
python -m pip install --user pyserial
```

## 在 VS Code 中使用

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
3. 扩展会启动内置的 `scripts/mpyrepl/__main__.py`

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

当 `.pyi` stub 中包含函数或构造函数签名时, 补全菜单会显示参数类型与默认值, 例如 `bpp: int = 3` 和 `timing: int = 1`。

对于当前会话已经导入或定义的对象, REPL 会合并并缓存一次设备 `dir()` 结果。stub 继续提供签名和类型说明, 设备结果补充自定义固件中存在但通用 stub 尚未声明的成员。

因此，当以下两点同时满足时，补全效果最好：

- 扩展里已经开启代码补全
- 当前 REPL 会话已经导入或定义过你要补全的名字

### 3. 共享串口管理器

扩展连接开发板后,隐藏的 manager 进程独占物理串口.VS Code、人工 REPL 和 Agent CLI 都通过本机 NDJSON RPC 连接这个 manager,不会分别打开 COM 口.代码执行和文件操作由 manager 串行调度,中断仍可通过带外请求立即发送.

人工 REPL 使用后台读取线程持续消费 manager 事件,因此停留在提示符且没有输入时,设备 stdout/stderr 也会直接显示,不再等待下一次输入或补全请求.prompt-toolkit 会在实时输出后重绘当前正在编辑的内容.这包括 Agent 执行代码和设备后台线程产生的输出.Agent 的一次性命令默认只解析自己的最终 RPC 结果,不会把其他客户端的输出混入 JSON.

### 4. Unicode 处理

Python 客户端会对 REPL 输出进行增量解码，并在宿主终端编码无法表示目标文本时使用更安全的写出回退逻辑。

这使得它在 Windows 和混合编码宿主环境下，比直接依赖普通终端输出更稳妥。

### 5. 失败与诊断行为

设备端代码异常会被当作正常 REPL 输出处理。开发板上运行的代码产生 traceback 时, REPL 会打印 traceback, 然后继续保留提示符等待下一条命令。

串口管理器会在协议操作空闲时检测设备连接状态。USB 串口被拔出或驱动返回 `ReadFile`、`WriteFile`、`ClearCommError` 错误时, 扩展会把串口状态更新为断开并关闭已经失效的 REPL 终端。重新插入设备后, 需要重新执行打开串口或打开 REPL 操作。

如果主机侧 REPL 客户端自身崩溃或以非零状态退出, VS Code 会保留终端, 而不是自动关闭。终端里应能看到 Python traceback 和一行简短的 `mpyrepl` 诊断信息。

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
- `--control-file`,仅用于兼容旧的独立 async-REPL 控制路径
- `--dir-query-timeout`

## Agent 命令行接入

manager 就绪后,扩展或 manager 自身会原子写入工作区的 `.mpy-workbench/serial-manager.json`.Agent 命令从当前目录向上查找该文件,也可以使用 `--workspace`、`--session` 或 `MPY_MANAGER_SESSION` 显式指定.除 `connect PORT` 可在缺少会话时冷启动 manager 外,描述文件无效时命令会失败,不会回退为直接打开串口.

Agent 路径只使用 Python 标准库,不会加载 prompt-toolkit、Pygments 或其他 TUI 依赖.常用命令:

```bash
python scripts/mpyrepl/__main__.py agent --workspace C:\qzrobot\mpy --timeout 20 connect COM5
python scripts/mpyrepl/__main__.py agent status
python scripts/mpyrepl/__main__.py agent exec --code "print(1)"
python scripts/mpyrepl/__main__.py agent exec-file mpy/test.py
python scripts/mpyrepl/__main__.py agent ls /sd
python scripts/mpyrepl/__main__.py agent get /sd/main.py ./main.py
python scripts/mpyrepl/__main__.py agent put ./main.py /sd/main.py
python scripts/mpyrepl/__main__.py agent rm /sd/old.py --yes
python scripts/mpyrepl/__main__.py agent disconnect
python scripts/mpyrepl/__main__.py agent --timeout 20 reconnect
python scripts/mpyrepl/__main__.py agent shutdown
```

`--busy wait`默认在 manager 端进行有界排队,`--queue-timeout 30`控制开始执行前的最长等待时间,`--busy reject`用于忙碌时立即失败.`--timeout`控制操作开始后的等待时间.标准输出始终是一条最终 JSON;使用 `--progress`时,匹配当前传输的进度 JSONL 写入 stderr.

发现优先级、完整命令与选项、JSON 契约、退出码和安全限制见 [agent-cli_zh-CN.md](agent-cli_zh-CN.md).

## 当前限制

- 运行时点式补全依赖实时设备状态，也可能超时。
- raw REPL 会占用串口；当它处于活动状态时, 文件操作会通过它的控制通道执行。
- 当前会话描述文件包含仅供本机进程使用的 manager token,必须继续忽略 `.mpy-workbench/`,不要复制到日志或版本库.
- 如果所选解释器低于 Python 3.9，或缺少 `pyserial`，启动会失败。

## 故障排查

### REPL 无法启动

优先检查：

- 是否已经选择了固定串口
- `microPythonWorkBench.pythonPath` 是否指向有效 Python 解释器
- 该解释器是否能够导入 `serial`

### REPL 报错后终端仍然保留

当主机侧 `mpyrepl` 进程以非零状态退出时, 这是预期行为。请先阅读终端中保留下来的 traceback 和诊断信息, 确认原因后再通过工作台操作关闭或重新打开 REPL。

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
