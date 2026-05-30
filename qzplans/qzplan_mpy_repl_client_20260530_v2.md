# VScodeMicroPython 自建 REPL 客户端 实施计划 (v2)

- 创建时间: 2026-05-30
- 目标仓库: `E:\xm\github\github\VScodeMicroPython`
- 上位目标: 在不修改设备固件的前提下，为扩展提供一个自建的 MicroPython REPL 客户端，解决 Windows 下官方 REPL / mpremote 控制台对 UTF-8 的兼容问题。
- 文档定位: 本文是 v2 计划，替代 v1 作为后续实现基线。v1 中仍有几处“已核实事实”与当前仓库不一致，已在本文修正。
- 当前状态: 仅为实施计划，未开始编码。

---

## 0. 已确认范围与边界

### 0.1 已确认决策

1. 在任何修改扩展 TypeScript / JavaScript 路径之前，**先用独立 Python CLI 完成验证**。
2. Phase 1 **只替换 REPL**，不把 `runActiveFile`、文件同步、监视器等路径一起并入统一串口后端。
3. 前端载体继续使用 **VSCode 集成终端**，不走 `vscode.Pseudoterminal`。
4. Python 依赖采用 **vendoring**，打包进扩展，不依赖首次使用时 `pip install`。
5. 新客户端做成 **可独立运行的 CLI**，便于脱离扩展直接调试。
6. REPL 语义目标不止是“最小可用”，而是尽量贴近 **CPython / Thonny** 的表达式回显与 `_` 行为。
7. 主循环架构在计划层直接定为 **异步事件驱动**，不再把同步 `prompt()` 方案保留为并列候选。

### 0.2 本期明确不做

1. 不替换 `runActiveFile` 的 mpremote 路径，因此本计划 **不解决** 该路径上的 Windows UTF-8 问题。
2. 不做设备端 `input()` 的交互输入转发。
3. 不做设备侧 Tab 自动补全，列为 Phase 2。
4. 不做统一长驻串口后端，不把 REPL、Run、Sync、Monitor 合并到一个共享连接层。

### 0.3 重要范围说明

本计划解决的是“扩展内 REPL 入口”的问题，而不是整个扩展所有串口路径的统一改造。因此：

- REPL 中文输入输出、增量 UTF-8 解码、行编辑、多行、历史、表达式回显，属于本期目标。
- `mpremote run`、文件同步、轮询监视器等路径仍保留现有实现，相关风险单独管理。

---

## 1. 对 v1 的纠偏

### 1.1 当前 REPL 启动命令不是 `mpremote repl`

v1 把当前集成点描述成“替换 `mpremote ... repl`”，这与现状不符。当前扩展打开 REPL 时，实际走的是：

```text
python -m mpremote connect <device>
```

而不是：

```text
python -m mpremote repl
```

这会影响以下判断：

1. 退出方式是当前终端 + mpremote `connect` 会话，不是单独的 `repl` 子命令生命周期。
2. `disconnectReplTerminal`、`softReset`、`serialSendCtrlC` 等操作现在都默认“终端里跑着一个 mpremote connect 会话”。
3. 新客户端要替换的是“现有 REPL 终端会话模型”，不是只替换一个命令字符串。

### 1.2 仓库里并不存在可直接复用的 `scripts/thonny_list_files.py`

v1 把“已使用 thonny 改写脚本 `scripts/thonny_list_files.py`”写成了已核实现状，但当前仓库 `scripts/` 目录没有这个文件，`src/python/pyraw.ts` 仍在引用它。这说明：

1. Python helper 的真实位置与打包路径已经漂移。
2. 不能把“已有 Thonny helper 链路”当成已稳定、可直接扩展的前提。
3. 本次 REPL 方案要把 Python helper 的目录结构、打包规则、运行时定位方式一次性收拢清楚。

### 1.3 旧的 Pseudoterminal 方案文档仅作参考，不再作为实施基线

旧文档走的是：

- JSON IPC
- Python 长驻后端
- Pseudoterminal
- minny 抽取

这对“统一串口后端”是有吸引力的，但与本次已经确认的范围不一致。本次应明确采用更轻量的策略：

- 只替换 REPL
- 保留集成终端
- Python CLI 进程自管行编辑与串口协议

---

## 2. 现有系统真实约束

### 2.1 当前 REPL 控制面是终端注入控制字符

当前扩展并不是通过结构化 API 控制 REPL，而是直接向终端会话注入控制字节。这意味着新客户端必须明确承接以下动作：

1. 中断: 终端注入 `Ctrl-C`
2. 软复位: 终端注入 `Ctrl-D`
3. 关闭会话: 当前实现里有 mpremote 特定退出动作，未来必须改成新客户端自己的退出约定

因此，新客户端不是“只负责显示和提交代码”，而必须对控制字节有统一入口。

### 2.2 自动挂起 / 恢复已有上层契约

当前扩展在执行同步、运行文件等操作前，会主动关闭或断开 REPL，然后根据上层配置恢复。这不是简单的 close / reopen，而是带有行为模式的恢复契约。

Phase 1 里必须审计两层内容：

1. `suspendSerialSessionsForAutoSync` / `restoreSerialSessionsFromSnapshot` 的底层行为
2. `extension.ts` 中围绕 `replBehavior` 的上层语义

如果只改 `mpremoteCommands.ts` 而不检查调用方，容易出现“底层协议已换成 raw REPL，恢复语义仍按旧 friendly REPL 设计”的错配。

### 2.3 本次方案不等于“统一串口后端”

本计划不应误导未来实现者。Phase 1 的本质是：

1. 用新的 Python CLI 客户端替换 REPL 路径
2. 保持 Run / Sync / Monitor 仍然用现有 mpremote 或现有实现
3. 接受串口在这些路径间继续独占切换

这是一个可控的、小范围、高收益改造，而不是一次性重写扩展的串口基础设施。

---

## 3. 技术路线总览

### 3.1 总体策略

采用“主机端行编辑 + raw-paste 提交 + 增量 UTF-8 解码”的路线，在库存固件上绕过 friendly REPL 的 ASCII-only readline。

### 3.2 为什么继续选集成终端

在当前范围下，集成终端优于 Pseudoterminal：

1. 与扩展当前 REPL 打开方式更一致，改动面最小。
2. 避免引入新的终端抽象层和 JSON IPC。
3. 让 Phase 1 聚焦在真正的问题上: UTF-8、raw-paste、输入编辑、控制键、REPL 语义。

### 3.3 为什么仍要借鉴 Thonny，但只借“协议层 + 语义思路”

Thonny 的参考价值分为两层：

1. 协议层: raw-paste、raw prompt、容错解码，这些可以借。
2. 后端层: `ProperTargetManager`、对象检查、输入转发、项目管理，这些耦合较重，不适合在本期照搬。

本计划只借以下能力：

1. raw-paste 协议细节
2. 表达式回显与 `_` 语义增强思路
3. `errors="replace"` 或增量解码的容错原则

---

## 4. Phase 0: 两个必须先做的 Spike

这两项不再视为“实现中顺手验证”，而是编码前必须先过的架构闸门。

### 4.1 Spike A: 传输层与 UTF-8 PoC

目标:

1. 验证串口打开、进入 raw REPL、raw-paste 提交、follow 读取、增量 UTF-8 解码都能工作。
2. 验证中文输入字符串、中文输出、中文异常回溯在 Windows 下不崩溃。
3. 验证 `Ctrl-C` 中断和 raw 模式下 `Ctrl-D` soft reboot 的设备行为。

实现范围:

1. 不接 prompt_toolkit
2. 不接 VSCode
3. 只做一个最小 CLI 或脚本
4. 先证明“设备执行、串口输出、软复位、中断”全部成立，再考虑输入编辑层

通过标准:

1. `s='中文测试'` 后再输入 `s`，能看到正确回显
2. `print('中文')` 正常
3. 多字节字符分包时不会抛解码异常
4. 死循环能被 `Ctrl-C` 打断
5. raw 模式空提示符下 `Ctrl-D` 会 soft reboot 并重新回到 raw 提示符

### 4.2 Spike B: prompt_toolkit + 集成终端 + 控制键收敛 PoC

目标:

1. 验证 prompt_toolkit 在 VSCode 集成终端中正常工作
2. 验证真实键盘按下 `Ctrl-C` / `Ctrl-D` / `Ctrl-]` 时，新客户端能正确处理
3. 验证扩展侧 `sendText` 注入同样的控制字节时，客户端能否在同一层收到并按预期处理

重点不是“界面好不好看”，而是确认下面三件事：

1. 真键盘事件可用
2. 扩展注入字节可用
3. 两者确实能共享同一控制路径

额外要验证的关键事实:

1. 执行中的 `Ctrl-C` 是否真的可达，因为这是同步 `prompt()` 架构天然做不到的。
2. 扩展 `sendText("\x03")` 在执行中是否会只是堆积在 stdin，而不是触发统一中断入口。
3. Windows ConPTY 下的真实 `Ctrl-C` 是否会被转成信号，并因此与扩展注入字节走不同路径。

通过标准:

1. 用户按键与扩展注入都能触发中断
2. 用户按键与扩展注入都能触发 soft reset
3. 客户端退出能可靠释放串口

若 Spike B 未通过，则本期要立即降级选择：

1. 要么保持“用户键盘与扩展命令两条控制路径分开”
2. 要么中止集成终端路线，回退到 Pseudoterminal 方案评估

### 4.3 Phase 0 的硬约束

1. 在 Spike A 与 Spike B 都通过前，不改扩展 REPL 启动代码。
2. Spike 阶段先只实现 Python 侧文件与最小人工验证脚本。
3. 只有当“执行中中断”在独立 CLI 和集成终端 PoC 中都成立，才进入 TypeScript 集成阶段。

---

## 5. Phase 1 目标架构

### 5.1 目录结构

```text
scripts/mpyrepl/
    __init__.py
    __main__.py
    cli.py
    bootstrap.py
    transport.py
    executor.py
    repl_semantics.py
    session.py
    keybindings.py
    decode.py
    errors.py
    models.py
    _vendor/
        prompt_toolkit/
        wcwidth/
        pygments/
        serial/
        VENDOR.md
        LICENSES/
```

### 5.2 模块职责

1. `bootstrap.py`: 按“脚本路径执行也成立”的方式把 `_vendor` 放到 `sys.path` 最前。
2. `cli.py`: 解析命令行参数，支持独立运行。
3. `transport.py`: 串口连接、raw REPL、raw-paste、follow、interrupt、soft reset。
4. `decode.py`: 增量 UTF-8 解码。
5. `session.py`: prompt_toolkit 会话、多行、历史、lexer、提示符。
6. `keybindings.py`: `Ctrl-C` / `Ctrl-D` / `Ctrl-]` 以及执行态与空闲态的不同动作。
7. `repl_semantics.py`: 表达式回显与 `_` 语义增强。
8. `executor.py`: 把一段输入从文本变成要提交的源码，并负责执行、收集输出。
9. `models.py`: `ReplConfig`、`ExecResult`、`TransportState` 等数据类。

### 5.3 vendoring 方案

采用以下原则：

1. 运行时不依赖用户额外安装第三方包。
2. 自带依赖版本固定，避免系统环境差异。
3. 保留第三方 LICENSE，并在 `VENDOR.md` 记录来源与版本。

额外说明:

1. `.vscodeignore` 已允许 `scripts/**` 进入 VSIX，这是可行路径。
2. `pygments` 体积较大，Phase 1 可先整包 vendoring，Phase 2 再评估裁剪。

---

## 6. REPL 语义设计: 不再停留于最简包装

v1 中“单表达式包装成 `_=(expr)` 然后 `print(repr(_))`”虽然简单，但不足以满足本次已确认的语义目标。v2 采用更接近 Thonny 的思路。

### 6.1 目标语义

1. 顶层表达式语句自动回显其 `repr`
2. 结果为 `None` 时不打印
3. 最近非 `None` 结果可作为 `_` 使用
4. 如果用户自己显式给 `_` 赋值，则尊重用户赋值，不强行篡改

### 6.2 实现策略

#### 方案

1. 在设备端注入一次 helper 代码，提供 `print_repl_value` 与 `last_non_none_repl_value`
2. 对每次提交的源码做 AST 分析，只处理顶层表达式语句
3. 把顶层 `Expr` 包装成 `__mpy_repl_helper.print_repl_value(...)`
4. 在安全前提下，把 `_` 的读取改写为“优先 globals 中的 `_`，否则回退到 helper 记录的最近值”

#### 伪代码

```python
helper_state = """
class __mpy_repl_helper:
    last_non_none_repl_value = None

    @classmethod
    def print_repl_value(cls, obj):
        if obj is not None:
            globals()['_'] = obj
            cls.last_non_none_repl_value = obj
            print(repr(obj))
"""

def instrument_source(source: str) -> str:
    root = ast.parse(source, mode="exec")
    guard_user_assignments_to_underscore(root)
    replace_safe_underscore_loads(root)
    wrap_top_level_expr_nodes(root)
    return ast.unparse(root) or textual_fallback(root, source)
```

### 6.3 为什么这里要比 v1 更复杂

因为本期已经确认“语义尽量贴近 CPython / Thonny”，那就不应再把 `_` 行为降格为简单副产物。这里复杂一些是值得的，但边界仍要明确：

1. 只处理顶层 REPL 语义
2. 不做对象检查器
3. 不做项目管理级 helper

### 6.4 语义边界补充

1. “尽量贴近 CPython / Thonny”不等于完全复制其所有 backend helper。
2. 若用户显式给 `_` 赋值，用户赋值优先。
3. 如果某些场景下 AST 改写存在歧义，宁可降级为“不自动回显”，也不应生成错误代码。

---

## 7. 串口与协议层设计

### 7.1 Transport 能力

`Transport` 需要提供以下方法：

1. `open()`
2. `close()`
3. `enter_raw_repl()`
4. `exit_raw_repl()`
5. `interrupt()`
6. `soft_reset()`
7. `exec_raw_paste()`
8. `follow()`

### 7.2 关键协议原则

1. 连接建立后立即进入 raw REPL
2. 整个会话保持在 raw REPL 内
3. 每次提交走 raw-paste，必要时回退到普通 raw
4. 输出统一通过增量 UTF-8 解码器流出

### 7.3 raw prompt 读取规则

这里需要显式避免 off-by-one 错误。

规则如下：

1. `enter_raw_repl()` 不吞掉用于后续执行的那个独立 `>` 提示符时，`exec_raw_paste()` 才能安全等待 `>`。
2. 或者反过来，若 `enter_raw_repl()` 已经读掉了最终 `>`，则 `exec_raw_paste()` 不能再次等待 `>`。

本计划选择 **完全对齐 mpremote 的读取边界**，避免首次执行时因为重复等待 `>` 而卡死。

### 7.4 soft reset 语义

在 raw 空提示符下发送 `Ctrl-D` 触发 soft reboot，随后继续回到 raw 模式。这一行为在客户端内部实现，扩展不再自己拼接旧的 `Ctrl-C -> Ctrl-B -> Ctrl-D` 序列。

补充说明：

1. raw 模式下的 `Ctrl-D` 与 friendly REPL 下的 `Ctrl-D` 在 `main.py` 是否执行这件事上可能存在差异。
2. 因此文档与 banner 里要明确说明此差异，必要时在后续提供“完整重启并跑 main.py”的单独动作。

---

## 8. 输入与控制键设计

### 8.1 控制键职责

1. `Ctrl-C`
   - 空闲态: 清空当前输入
   - 执行态: 向设备发送中断
2. `Ctrl-D`
   - 空输入时: soft reset
   - 非空输入时: 不退出客户端
3. `Ctrl-]`
   - 客户端退出并释放串口

### 8.1.1 执行中中断的架构前提

执行中 `Ctrl-C` 是否成立，取决于主循环在运行设备代码期间是否仍然维持输入层与串口读取层活着。

因此本计划直接排除“同步 `sess.prompt()` 返回后再阻塞 `run_block()`”的架构。原因如下：

1. 执行期间 prompt_toolkit 不在运行。
2. 执行期间若没有独立读取 stdin 或独立键位层，扩展注入的 `\x03` 只会堆在 stdin 中。
3. 真键盘 `Ctrl-C` 在 Windows ConPTY 下往往会变成信号，路径也不同。

结论：主循环必须从一开始就采用 **异步 prompt_toolkit + 独立串口读取任务**，或等价的“输入层与执行层并存”结构。

### 8.2 统一入口原则

理想设计是“真键盘”和“扩展 `sendText` 注入”都走到 `keybindings.py` 这一层。但在 Spike B 验证通过前，这一条只能视为目标，不可视为既成事实。

因此，计划里必须写清：

1. 若验证通过，扩展侧继续发送控制字节即可。
2. 若验证不通过，扩展侧应切换为“发送普通命令字符串”或走备用控制通道，而不是继续假设控制字节一定可收敛。

### 8.3 多行提交不是 `multiline=True` 就够

这里必须显式设计 Enter 键绑定。

要求如下：

1. 输入完整时，Enter 提交。
2. 输入未完成时，Enter 插入换行并显示续行提示。
3. 不采用“默认 Enter 永远换行、用户再用其他组合键提交”的交互。

因此 `session.py` 必须实现一个基于 `is_complete()` 的自定义 Enter 绑定，而不是只打开 `multiline=True`。

---

## 9. 扩展集成改动范围

### 9.1 TypeScript 侧只改 REPL 路径

本期只动以下行为：

1. REPL 打开命令改为启动 `scripts/mpyrepl/__main__.py`
2. REPL 关闭路径改为新客户端的退出约定
3. REPL 打开状态下的中断、软复位行为改为交给新客户端承接
4. 自动挂起 / 恢复逻辑做兼容性修正

但这些动作全部排在 Phase 0 成功之后。

### 9.2 明确不动的路径

以下路径本期不改：

1. `runActiveFile`
2. 文件同步命令
3. 轮询 monitor
4. 代码补全下载 / 安装逻辑

### 9.3 需要显式审计的现有函数

1. `getReplTerminal`
2. `openReplTerminal`
3. `disconnectReplTerminal`
4. `softReset`
5. `serialSendCtrlC`
6. `suspendSerialSessionsForAutoSync`
7. `restoreSerialSessionsFromSnapshot`
8. `withAutoSuspend`

---

## 10. 测试计划

### 10.1 Python 侧

最少覆盖：

1. 增量 UTF-8 解码
2. raw-paste 窗口写入逻辑
3. 表达式语义注入
4. `_` 读取与用户显式赋值冲突场景
5. raw prompt 读取边界
6. soft reset 哨兵流转
7. 多行完整性判断与 Enter 绑定

### 10.2 TypeScript 侧

最少覆盖：

1. REPL 启动命令切换到新 CLI
2. REPL 打开状态下 `softReset` / `serialSendCtrlC` 的注入行为
3. `disconnectReplTerminal` 的新退出路径
4. auto-suspend 恢复时不会误走旧 mpremote 语义

### 10.3 人工验收

必须在 Windows 下做：

1. 中文输入
2. 中文输出
3. 中文异常回溯
4. 多行 `for` / `def`
5. 历史与行内编辑
6. 死循环中断
7. soft reboot
8. REPL 打开时执行同步操作后的恢复

---

## 11. Phase 划分

### Phase 0: 验证

1. Spike A: transport + UTF-8
2. Spike B: prompt_toolkit + 集成终端 + 控制键收敛
3. 只产出 Python 侧验证文件，不改扩展集成代码

### Phase 1: MVP

1. 落地 vendoring
2. 实现异步主循环、transport / decode / session / keybindings / repl semantics
3. 跑通独立 CLI
4. 集成扩展 REPL 路径
5. 补最小测试与文档

### Phase 2: 增强

1. `input()` 交互转发
2. 设备 `dir()` 自动补全
3. 状态行与更丰富的诊断输出
4. 可选的 `pygments` 裁剪

---

## 12. 验收标准

1. Windows VSCode 集成终端中可稳定输入和显示中文，不出现 `UnicodeDecodeError`
2. 顶层表达式自动回显，`None` 不回显
3. `_` 的行为在常见 REPL 场景下尽量贴近 CPython / Thonny
4. `Ctrl-C` 中断、`Ctrl-D` soft reboot、`Ctrl-]` 退出都可用
5. 自动挂起 / 恢复不再依赖旧 mpremote friendly REPL 假设
6. VSIX 打包后 `_vendor/` 与 CLI 文件完整包含在扩展中

---

## 13. 仍需在编码前最终拍板的点

1. Spike B 若证明“扩展 `sendText` 注入的控制字节”无法与真实键盘完全收敛，备用控制方案选哪条。
2. `repl_semantics.py` 采用 AST 直接改写，还是文本级改写 + 语法校验作为回退。
3. vendoring 时各依赖的具体锁定版本号。
4. raw 模式 soft reset 是否接受“可能不跑 main.py”的差异，或是否需要额外提供完整重启动作。

---

## 14. 独立 CLI 启动约束

“按文件路径直接运行”与“包内相对导入”不能混用。为了满足本计划的独立验证目标，启动方式直接定为：

1. 允许 `python scripts/mpyrepl/__main__.py --port COMx` 直接运行。
2. 因此 `__main__.py` 不能依赖 `from . import bootstrap` 这种只在包方式执行下可靠的相对导入。
3. 推荐做法是由 `__main__.py` 基于 `__file__` 计算目录，自举 `_vendor` 路径，并使用脚本路径可成立的导入方式。

---

## 15. 主循环既定架构

这里不再保留“同步 prompt 还是异步 prompt”两案并列，直接采用异步架构。

### 15.1 目标结构

1. prompt_toolkit 的应用层持续存活
2. 串口读取任务持续存活
3. 执行设备代码期间，键位层仍然活着
4. 控制键既能处理真实键盘，也能尽量承接扩展注入

### 15.2 建议结构

```text
Application.run_async()
    ├─ prompt / keybindings 持续运行
    ├─ serial reader task 持续读取设备输出
    ├─ execute task 负责提交源码与等待完成
    └─ control path 负责 Ctrl-C / Ctrl-D / Ctrl-]
```

### 15.3 soft reset 哨兵规则

`Ctrl-D` 的处理必须统一为：

1. 键位层返回 soft reset 哨兵
2. 主循环识别该哨兵
3. 主循环调用 `transport.soft_reset()`
4. 处理完成后继续回到 REPL 空闲态

不要把串口 I/O 直接塞进键位回调里，也不要让主循环把哨兵当普通文本再去 `.strip()`。

---

## 16. 简短执行摘要

这项工作不是“重做整个扩展串口层”，而是一次边界清晰的 REPL 替换工程：

1. 先用独立 Python CLI 完成两轮 Spike，把最关键的不确定性打掉。
2. 主循环从计划层就定为异步，不再保留同步 `prompt()` 的错误候选。
3. 再以 Python CLI + vendoring + 集成终端的方式落地 MVP。
4. 只承诺修好 REPL，先不吞并 Run / Sync 路径。
5. 在 REPL 语义上，不满足于最简包装，而是尽量贴近 CPython / Thonny 的表达式与 `_` 行为。
