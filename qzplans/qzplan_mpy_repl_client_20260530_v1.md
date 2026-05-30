# VScodeMicroPython 自建 REPL 客户端 实施计划 (v1)

- 创建时间: 2026-05-30
- 目标仓库: `E:\xm\github\github\VScodeMicroPython`
- 决策前提: 兼容官方/库存固件(不依赖固件改动), 即采用 "方案 3 — 主机端行编辑 + paste/raw-paste 执行"
- 关联: micropython #2789 / #7585 / #15228; 参考 Thonny(`minny` 库)与 mpremote `transport_serial.py`
- 状态: 仅为计划, 待用户确认后再编码

### 已确认决策(2026-05-30)
1. 依赖分发: **vendoring 进 `scripts/`**(零 pip 安装, 自带纯 Python 依赖).
2. 自动补全: **Phase 2**.
3. 渲染载体: **VSCode 集成终端**.
4. 客户端形态: **做成可独立运行的 CLI**(可脱离扩展直接 `python ... --port COMx` 调试).
5. 软复位/中断统一入口: **与 MicroPython 自带快捷键保持一致**(Ctrl-C = 中断, Ctrl-D = 软复位), 由客户端键位层统一承接(用户按键与扩展注入字节都走同一处).

---

## 1. 目标设定

主目标: 在 VSCode 扩展内完全自建一个 MicroPython REPL 客户端, 彻底弃用 `mpremote repl` 控制台, 在 **库存固件** 上实现中文(UTF-8)的双向交互, 不再出现 Windows 下 `UnicodeDecodeError` 崩溃.

子目标:
- 输入: 主机端做行编辑, 用户键入的 UTF-8(中文)整行通过 paste/raw-paste 模式送入设备执行, 绕开设备 friendly REPL 的 readline(库存固件会丢弃 >127 字节).
- 输出: 对设备返回字节做 **增量 UTF-8 解码**(缓冲被分包切断的多字节序列), 永不崩溃.
- 体验: 提供 **Python 语法高亮**(随输入实时高亮)、多行续行、历史、与 mpy 一致的快捷键(Ctrl-C 中断 / Ctrl-D 软复位 / Ctrl-] 退出).
- 交互语义: 复刻 `>>>` 行为(表达式自动回显其 `repr`, 语句不回显, `None` 不打印).
- 集成: 由扩展在 VSCode 集成终端中启动该客户端, 替换原 `mpremote ... repl` 命令; 与现有串口自动挂起/恢复逻辑协同.

非目标(本期不做): 设备端 `input()` 的交互式 stdin 转发、Tab 自动补全(列为 Phase 2)、宽字符(CJK 双列)像素级对齐(由库处理, 不另造表).

---

## 2. 现有参考与工作原理(均已在仓库/源码核实)

### 2.1 崩溃根因(主机端, 非固件)
`mpremote` 的 `tools/mpremote/mpremote/console.py` 中 `ConsoleWindows.write` 对每个串口分块做严格 `buf.decode()`, 多字节字符被串口分包切断时抛 `UnicodeDecodeError`. POSIX 的 `ConsolePosix.write` 写原始字节不解码, 故只有 Windows 崩. 结论: 必须自管解码, 不能用 mpremote 控制台.

### 2.2 为什么必须走 paste/raw-paste(而非 friendly REPL)
库存固件的 friendly REPL 在 `shared/readline/readline.c` 中只接受 `32..126`, 丢弃 >127 字节. 因此把 UTF-8 整行发给 `>>>` 提示符仍会丢字符. 而 raw / raw-paste / paste 模式把字节 **直接交给编译器**(不过 readline 过滤), UTF-8 源码字符串可正确处理(issue #2789 亦确认 "paste 模式下可用"). 这正是方案 3 在库存固件上成立的关键.

### 2.3 raw-paste 协议(权威来源: mpremote `transport_serial.py`)
- 进入 raw REPL: 发送 `b"\r\x01"`(Ctrl-A), 设备回 `b"raw REPL; CTRL-B to exit\r\n>"`.
- 尝试 raw-paste: 发送 `b"\x05A\x01"`; 设备回 `b"R\x01"`(支持) / `b"R\x00"`(不支持, 回退普通 raw).
- raw-paste 流控: 设备先回 2 字节窗口大小(小端), 之后每收到 `b"\x01"` 表示可再发一窗; 发完写 `b"\x04"` 表示结束; 设备以 `b"\x04"` 确认.
- 取结果(`follow`): 读到第一个 `b"\x04"` 前是 stdout, 第二个 `b"\x04"` 前是 stderr/异常.
- 退出 raw REPL 回 friendly: 发送 `b"\r\x02"`(Ctrl-B). 中断运行: 发送 `b"\x03"`(Ctrl-C). 软复位: `b"\x04"`.

关键点: **整个会话保持在 raw REPL 内**, 逐块用 raw-paste 提交, 全局命名空间在不软复位时跨提交保留 → 变量持久, 同时彻底避开 readline.

### 2.4 Thonny 的做法(参考对象)
- Thonny 已把通信抽到 `minny` 库(`from minny.target import ProperTargetManager, EOT, NORMAL_PROMPT, FIRST_RAW_PROMPT ...`), 采用 `submit_mode="raw_paste"`, 同样基于上面的协议.
- 解码容错: `mp_back.py` 的 `_decode` 用 `data.decode("UTF-8", errors="replace")`, 从不崩溃.
- 结论: 我们复刻 "raw-paste 协议 + 容错/增量解码", 这是被验证可行的路线.

### 2.5 扩展当前集成点(已核实)
- `src/board/mpremoteCommands.ts`: REPL 在 VSCode 集成终端中由 `replTerminal.sendText(cmd, true)` 启动, 命令形如 `"${pythonPath}" -m mpremote ... repl`(`buildShellCommand`/`getReplTerminal`).
- 已有串口自动挂起/恢复: `suspendSerialSessionsForAutoSync` / `restoreSerialSessionsFromSnapshot`(同一时刻仅一个进程占用 COM 口).
- 扩展 **已依赖 Python + pyserial**(经 mpremote)且已使用 thonny 改写脚本(`scripts/thonny_list_files.py`). 因此用 Python 实现客户端是最省事路径, 不引入 node 原生 `serialport`/`xterm` 依赖.

---

## 3. 需求分析与技术选型

### 3.1 是否需要 TUI 库 — 结论: 需要, 选 prompt_toolkit(+ Pygments), 但不用全屏 TUI
- 行编辑(光标移动、多行、历史、宽字符/UTF-8、Windows 兼容)是最难自造的部分. `prompt_toolkit` 已成熟解决(IPython/ptpython/pgcli 均基于它), 跨平台(Windows 走自带 VT/Win32 输入), 内置 `wcwidth` 处理 CJK 宽度.
- 语法高亮: `prompt_toolkit` 用 `PygmentsLexer(Python3Lexer)` 即可随输入 **实时高亮**.
- 不需要全屏 TUI(Textual/urwid): REPL 是 "输入行高亮 + 输出滚动" 模式, prompt-mode 即可; 全屏 TUI 反而会让输出流式显示复杂化. 故 **推荐 prompt_toolkit 的 prompt 模式**, 参考 ptpython 的实现思路.
- 依赖三件套: `pyserial`(传输)、`prompt_toolkit`(行编辑+高亮)、`pygments`(词法). 均为纯 Python, 易安装/可 vendoring.

### 3.2 选型结论(已确认)
- 依赖分发: **vendoring**. 把纯 Python 依赖打包进 `scripts/mpyrepl/_vendor/`, 启动时把该目录插到 `sys.path` 最前, 不触碰系统已装版本, 零 pip 安装. 详见 4.5.
- 渲染载体: **VSCode 集成终端**(底层 xterm.js, 天然处理 UTF-8 与 ANSI). 不引入 `vscode.Pseudoterminal`/webview.
- 自动补全: **Phase 2**(查询设备 `dir()`).

### 3.3 需 vendoring 的依赖与许可
| 包 | 导入名 | 用途 | 许可 | 备注 |
|---|---|---|---|---|
| prompt_toolkit | `prompt_toolkit` | 行编辑/多行/历史/实时高亮/跨平台输入 | BSD-3 | 3.x 仅运行期依赖 `wcwidth` |
| wcwidth | `wcwidth` | CJK 宽字符列宽 | MIT | prompt_toolkit 的依赖 |
| pygments | `pygments` | Python 词法(高亮) | BSD-2 | 体积最大; 仅用 `Python3Lexer`, 见 4.5 体积说明 |
| pyserial | `serial` | 串口传输 | BSD-3 | 无额外依赖 |

许可均为宽松许可, 允许 vendoring. 必须随包保留各自 LICENSE, 并在 `_vendor/VENDOR.md` 记录版本号与来源.

---

## 4. 架构设计

### 4.1 总体结构(新增 Python 包 `scripts/mpyrepl/`)
```
scripts/mpyrepl/
  __init__.py
  __main__.py     # CLI 入口: bootstrap vendor 路径 → 解析 argv → 连接 → 跑主循环
  cli.py          # argparse: --port/--baud/--history/--no-color; 可独立运行
  bootstrap.py    # 把 _vendor 插入 sys.path 最前(优先于系统已装版本)
  transport.py    # 串口 + raw/raw-paste 协议(参考并裁剪 mpremote, MIT)
  executor.py     # 交互语义: 表达式/语句分类 + 包装 + 提交 + 取结果
  session.py      # prompt_toolkit 会话: 高亮/多行续行/历史
  keybindings.py  # Ctrl-C/Ctrl-D 等, 与 mpy 快捷键一致的统一入口
  decode.py       # 增量 UTF-8 解码器封装
  errors.py       # 异常与设备掉线/复位处理
  _vendor/        # 自带纯 Python 依赖(见 4.5)
    prompt_toolkit/   wcwidth/   pygments/   serial/
    VENDOR.md         # 记录各包版本/来源/许可
    LICENSES/         # 各依赖 LICENSE 原文
```

可独立运行: `python scripts/mpyrepl/__main__.py --port COM4 --baud 115200`(亦支持 `python -m mpyrepl`, 当父目录在 `sys.path` 时). 不导入任何 vscode API, 纯 CLI.

### 4.2 数据流
- 输入: 键盘 → prompt_toolkit(高亮/编辑, 得到 `str`) → `executor` 分类与包装 → `transport` 以 UTF-8 字节经 raw-paste 送设备(绕开 readline) → 设备编译执行.
- 输出: 设备字节 → `transport.follow` 切出 stdout/stderr → `decode` 增量解码 → 打印到终端(stdout, prompt_toolkit 之外的普通输出区).

### 4.3 状态机/生命周期
- 启动 → 打开串口 → Ctrl-C 中断当前运行 → 进入 raw REPL(`\r\x01`) → 循环{ 读输入 → 提交 → 显示 } → 退出时 Ctrl-B 回 friendly 并关闭串口.
- 快捷键与 mpy 一致(详见 5.7): **Ctrl-C** = 中断(空闲时清空当前输入行; 执行中透传 `\x03` 中断设备); **Ctrl-D**(空行)= 软复位设备(在 raw 空提示符发 `\x04`, 触发 soft reboot). 退出客户端走终端级约定 **Ctrl-]**(同 mpremote), 不占用 mpy 语义键.
- 与扩展自动挂起协同: 客户端就是占用 COM 口的进程, 复用现有 suspend/resume 钩子(关客户端=释放口).

### 4.4 用类承载数据(遵循项目规范, 不用裸 dict 传参)
- `ReplConfig`(port, baud, history_path, ...), `ExecResult`(stdout: str, stderr: str, interrupted: bool), `Transport`(封装 serial + 协议方法). 在模块间传递结构化对象而非字典.

### 4.5 vendoring 方案
- 布局: 依赖解包到 `scripts/mpyrepl/_vendor/`(`prompt_toolkit/ wcwidth/ pygments/ serial/`), 各自 LICENSE 放 `_vendor/LICENSES/`, 版本与来源记于 `_vendor/VENDOR.md`(vendoring 时锁定当时稳定版, 不臆造版本号).
- 引入: `bootstrap.py` 在导入任何第三方库 **之前** 执行 `sys.path.insert(0, <_vendor 绝对路径>)`, 保证用自带版本, 不受系统环境影响; `__main__.py` 第一行即 `from . import bootstrap`.
- 体积: `pygments` 最大(含大量 lexer). 处理: 先整包 vendoring 保正确性; 后续优化可裁剪为仅 `pygments` 核心 + Python lexer 所需模块(注意其 lexer 惰性加载/映射表, 裁剪需测试). `prompt_toolkit`+`wcwidth`+`pyserial` 体积可控.
- 纯 Python 校验: 四者均无 C 扩展, 跨平台直接可用; vendoring 前确认未引入需编译的可选依赖.
- 兜底: `bootstrap` 中 `try import`, 若 `_vendor` 缺失/损坏, 给出清晰报错并提示重新安装扩展(不静默回退到系统版本以免行为不一致).

---

## 5. 具体内容(关键逻辑用伪代码)

### 5.1 transport.py — raw-paste 提交与取结果(参考 mpremote)
```python
class Transport:
    def enter_raw_repl(self):
        self._write(b"\r\x01")                       # Ctrl-A
        self._read_until(b"raw REPL; CTRL-B to exit\r\n>")

    def exec_raw_paste(self, src_bytes: bytes, on_output) -> "ExecResult":
        self._read_until(b">")                       # 确认 raw 提示符
        self._write(b"\x05A\x01")                    # 请求 raw-paste
        resp = self._read(2)
        if resp == b"R\x01":
            self._raw_paste_write(src_bytes)         # 走窗口流控, 见 2.3
        else:
            self._raw_fallback_write(src_bytes)      # 256B/10ms + \x04, 读 'OK'
        # follow: 第一个 \x04 前=stdout, 第二个 \x04 前=stderr
        out = self._read_until(b"\x04", on_output)[:-1]
        err = self._read_until(b"\x04")[:-1]
        return ExecResult(stdout=out, stderr=err)

    def interrupt(self):  self._write(b"\x03")           # Ctrl-C: 中断运行中的程序
    def exit_raw_repl(self): self._write(b"\r\x02")      # Ctrl-B: 回 friendly

    def soft_reset(self, on_output) -> None:
        # 在 raw 空提示符发 Ctrl-D 触发 soft reboot(与 mpremote enter_raw_repl(soft_reset)一致)
        self._read_until(b">")                           # 确认处于 raw 空提示符
        self._write(b"\x04")                             # Ctrl-D: soft reset
        self._read_until(b"soft reboot\r\n", on_output)  # 显示 "soft reboot" 横幅
        # 之后到下一个 raw 提示符之间是 boot.py 输出, 一并回显
        self._read_until(b"raw REPL; CTRL-B to exit\r\n", on_output)
```
说明:
- `_raw_paste_write` 严格按设备 2 字节窗口与 `\x01` 续发信号写入(见 2.3), 结束写 `\x04` 并等 `\x04` 确认.
- `soft_reset` 全程留在 raw 模式: raw 空提示符下的 `\x04` 是 "软复位" 而非 "执行", 设备回 `soft reboot\r\n` + boot 输出 + 新的 raw 提示符. 这复刻了 mpy 原生 Ctrl-D 的 soft reboot 体验, 且无需切回 friendly.

### 5.2 executor.py — 复刻 `>>>` 的表达式自动回显
```python
def wrap_for_repl(source: str) -> str:
    # 用宿主 CPython 仅做"是否为单表达式"的分类(MicroPython 是子集, 分类足够可靠)
    try:
        compile(source, "<repl>", "eval")            # 能以 eval 编译 => 表达式
        is_expr = True
    except SyntaxError:
        is_expr = False
    if not is_expr:
        return source                                # 语句/复合块: 原样 exec, 不回显
    # 表达式: 赋给 _ 并仅在非 None 时打印 repr, 匹配 >>> 语义
    return "_=(" + source + ")\nif _ is not None:\n    print(repr(_))\n"

def run_block(transport, source: str, on_output) -> "ExecResult":
    payload = wrap_for_repl(source).encode("utf-8")  # UTF-8 整行, 绕开 readline
    return transport.exec_raw_paste(payload, on_output)
```
注意: 包装会使异常回溯行号偏移(REPL 场景可接受); 可在 Phase 2 优化为只在确为表达式时包装并标注偏移.

### 5.3 session.py — 行编辑/语法高亮/多行续行
```python
from prompt_toolkit import PromptSession
from prompt_toolkit.lexers import PygmentsLexer
from pygments.lexers.python import Python3Lexer

def make_session(history_path) -> PromptSession:
    return PromptSession(
        lexer=PygmentsLexer(Python3Lexer),           # 实时语法高亮
        multiline=True,                              # 配合续行判定
        history=FileHistory(history_path),
        # 自定义: 当 accumulated 文本"未完成"时回车=插入换行(显示 ...),
        #         完成时回车=提交
    )

def is_complete(text: str) -> bool:
    # 复刻 ptpython: 用 compile(text, "<repl>", "exec") 是否抛"未完成"型 SyntaxError 判定
    try:
        compile(text, "<repl>", "exec"); return True
    except SyntaxError as e:
        return not _is_incomplete_error(e)           # 末尾 ':' / 续行 / EOF 视为未完成
```

### 5.4 decode.py — 增量 UTF-8 解码(防分包崩溃)
```python
import codecs
class Utf8Stream:
    def __init__(self): self._dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
    def feed(self, chunk: bytes) -> str:
        return self._dec.decode(chunk)               # 缓冲半个字符, 跨块拼接, 不抛异常
```
输出路径统一经此解码后再打印, 彻底消除 `UnicodeDecodeError`.

### 5.5 __main__.py / cli.py — 主循环(可独立运行的 CLI)
```python
from . import bootstrap                              # 必须最先执行: 注入 _vendor 到 sys.path

def main(argv=None):
    cfg = parse_args(argv)                           # --port --baud --history --no-color
    tr = Transport(cfg.port, cfg.baud); tr.open()
    tr.interrupt(); tr.enter_raw_repl()
    out = Utf8Stream()
    sess = make_session(cfg.history_path)            # 见 5.3
    kb = make_keybindings(tr, out)                   # 见 5.7, Ctrl-C/Ctrl-D/Ctrl-] 统一入口
    print_banner(cfg)
    while True:
        try:
            text = sess.prompt(">>> ", key_bindings=kb)   # 高亮/编辑/多行
        except ExitRepl:                              # Ctrl-] 触发 → 退出客户端
            break
        except KeyboardInterrupt:                     # Ctrl-C 空闲 → 取消当前行
            continue
        if not text.strip():
            continue
        res = run_block(tr, text, on_output=lambda b: sys.stdout.write(out.feed(b)))
        if res.stderr:
            sys.stdout.write(out.feed(res.stderr))    # 异常(可选 ANSI 红色)
    tr.exit_raw_repl(); tr.close()

if __name__ == "__main__":
    main()
```
注: Ctrl-D 不再是 "退出", 而是由键位绑定调用 `tr.soft_reset(...)`(见 5.7); 退出统一用 Ctrl-].

### 5.6 扩展集成(TypeScript 侧, 最小改动)
- 在 `src/board/mpremoteCommands.ts` 的 REPL 启动路径(`getReplTerminal`/`openReplTerminal` 构造命令处), 把 `-m mpremote ... repl` 改为启动客户端:
  `"${pythonPath}" "${extPath}/scripts/mpyrepl/__main__.py" --port ${device} --baud ${baud}`.
- 复用现有 suspend/resume、`replOpen` 上下文.
- 重要语义校正(对应已确认决策 5):
  - `disconnectReplTerminal()` 中原本通过 `sendText("\x18")`(Ctrl-X)退出 mpremote, **改为发 `\x1d`(Ctrl-])** 触发本客户端干净退出(客户端键位见 5.7).
  - `softReset()` 在 REPL 打开时原本依次发 `\x03 \x02 \x04`(适配 friendly REPL). 本客户端处于 raw 模式, `\x02/\x04` 在 raw 下语义不同, 不可直接复用. 改为:
    - 若 REPL 终端打开 → `sendText("\x04", false)`: 客户端键位捕获到 Ctrl-D 后调用 `transport.soft_reset()`, 体验与 mpy 原生一致.
    - Ctrl-C 中断仍是 `sendText("\x03", false)`: 客户端键位捕获后调用 `transport.interrupt()`.
- 依赖检查: 因为依赖已 vendoring, 启动只需校验 `python` 可执行与 `scripts/mpyrepl/_vendor/` 存在, 不再走 pip 流程; 缺失 vendor 时报"扩展安装不完整, 请重装". 

### 5.7 keybindings.py — 与 mpy 自带快捷键一致的统一入口
键位通过 `prompt_toolkit.key_binding.KeyBindings` 注册到 PromptSession; 对扩展通过 `sendText` 注入的同样字节, 在 prompt_toolkit 输入层无差别捕获, 实现"用户敲键"与"扩展注入"走同一处.

| 按键 | 字节 | 空闲(在 `>>>` 输入) | 执行中(等待设备响应) | 与 mpy 对齐 |
|---|---|---|---|---|
| Ctrl-C | `\x03` | 清空当前输入行(`buffer.reset()`) | 透传到设备: `transport.interrupt()` | 同 mpy: 中断 |
| Ctrl-D | `\x04` | 仅当当前输入为空时触发 `transport.soft_reset()`; 非空时按 EOF/删除当前字符忽略 | (执行中不响应, 由设备完成或 Ctrl-C 打断) | 同 mpy: 空行 Ctrl-D = soft reboot |
| Ctrl-] | `\x1d` | 抛 `ExitRepl` → 客户端退出 → 释放串口 | 同左(优先级最高) | 同 mpremote 退出 |
| 回车 | `\r` | 由 `is_complete` 决定: 完整则提交, 不完整则插入换行(显示 `...`) | — | 同 mpy 多行块语义 |

```python
def make_keybindings(tr: "Transport", out: "Utf8Stream") -> "KeyBindings":
    kb = KeyBindings()

    @kb.add("c-c")
    def _(event):
        # 空闲态: 仅清空当前输入; 执行态由 5.5 主循环中临时 SIGINT/守护线程处理
        event.app.current_buffer.reset()

    @kb.add("c-d")
    def _(event):
        buf = event.app.current_buffer
        if len(buf.text) == 0:
            # 空行 Ctrl-D: 软复位设备(与 mpy 一致)
            event.app.exit(result=SOFT_RESET)
        # 非空时不做删除, 也不退出, 保持 mpy 语义(mpy 空行才软复位)

    @kb.add("c-]")
    def _(event):
        raise ExitRepl

    return kb
```

执行态 Ctrl-C 处理: `run_block` 开始前注册 `signal.SIGINT`(POSIX)或在 Windows 用 `prompt_toolkit` 的 `Application.run_async` + 独立读串口任务, 收到 Ctrl-C 字节立即调 `transport.interrupt()` 发 `\x03`, 然后继续从 stderr 通道接收 `KeyboardInterrupt` 异常回显. 具体实现细节(同步 vs 异步主循环)在编码阶段定; 设计原则: **同一字节 `\x03/\x04/\x1d` 无论来自用户键盘还是扩展 `sendText`, 都收敛到 keybindings.py 这一层**.

---

## 6. 注意事项与潜在挑战

- 快捷键收敛(已落到 5.7): `\x03/\x04/\x1d` 无论来自用户键盘还是扩展 `sendText` 注入, 都在 prompt_toolkit 的 `KeyBindings` 一处捕获. 扩展侧 `disconnectReplTerminal()` 改为发 `\x1d`, `softReset()` 在 REPL 打开时改为发 `\x04`(原 `\x03 \x02 \x04` 序列只适配 friendly REPL).
- 端口独占: 同一时刻仅一个进程能开 COM. 客户端运行时, 扩展的轮询监视(`monitor.ts`)与 mpremote 文件操作必须经 `suspendSerialSessionsForAutoSync` 协调, 沿用现状.
- 表达式分类边界: 宿主 CPython 与设备 MicroPython 语法极少数差异可能导致误分类(极端语法). 兜底: 分类失败一律按语句 exec(不回显), 不影响正确性, 只是个别表达式不自动打印.
- 包装导致回溯行号偏移: REPL 可接受; 文档说明.
- 大段粘贴: prompt_toolkit 支持 bracketed paste, 整块一次提交, 经 raw-paste 流控发送.
- 设备端 `input()` / 交互输入: raw-paste 执行期间设备 `input()` 会阻塞读 stdin, 本期不支持交互转发(Phase 2). 文档提示用户避免在 REPL 直接调用阻塞输入.
- 设备主动复位/掉线: `transport` 需识别协议中断(读超时/口消失)并优雅重连或提示.
- 性能: 逐键高亮与窗口流控在 115200 下无压力.
- vendoring 体积与打包: `_vendor/` 必须随 vsix 一并发布, 检查 `.vscodeignore` 不要排除它; `pygments` 体积偏大, Phase 1 整包以保证正确性, Phase 2 可裁剪.
- 许可合规: 借鉴 mpremote `transport_serial.py`(MIT)与 ptpython 思路, 在源文件注明出处; vendored 包各自 LICENSE 完整保留至 `_vendor/LICENSES/`, 在扩展 README 列出第三方组件清单.
- 跨平台: prompt_toolkit 处理 Windows/Unix 输入; VSCode 集成终端(xterm.js)负责 UTF-8 与 ANSI 渲染; 客户端只做字节透传 + 增量解码.

---

## 7. 分阶段实施

Phase 0 — 依赖落地(vendoring):
- 拉取 prompt_toolkit / wcwidth / pygments / pyserial 当时稳定版到 `_vendor/`, 写 `VENDOR.md` 与 `LICENSES/`, 配 `.vscodeignore` 不排除.
- 实现 `bootstrap.py` + 烟雾测试(`python scripts/mpyrepl/__main__.py --help` 不报缺包).

Phase 1 — MVP(CLI 独立可跑):
- `transport.py`(open / enter_raw / exec_raw_paste + 回退 / interrupt / soft_reset / exit_raw / close).
- `decode.py` + `executor.py`(表达式分类与回显).
- `session.py`(高亮 + 多行 + 历史)+ `keybindings.py`(Ctrl-C/Ctrl-D/Ctrl-] 收敛, 见 5.7).
- `cli.py`/`__main__.py` 主循环.
- 自测: PowerShell 直接 `python scripts/mpyrepl/__main__.py --port COM4 --baud 115200`, 跑通第 8 节验收.
- 扩展集成: `src/board/mpremoteCommands.ts` 切换 REPL 启动命令, 校正 `disconnectReplTerminal`/`softReset` 注入字节.

Phase 2 — 增强(本期不做):
- 设备 `dir()` 自动补全; 异常/输出 ANSI 着色; `input()` 交互转发; 状态行(端口/MPY 版本); 重连; 可选 `pygments` 裁剪.

---

## 8. 验收标准

- 客户端可独立运行: 系统 PowerShell 直接 `python scripts/mpyrepl/__main__.py --port COMx --baud 115200` 即进入 REPL.
- 在 Windows VSCode 集成终端中: 键入 `s='中文测试'` 回车, 再键入 `s` 回车显示 `'中文测试'`, `len(s)` 正确; 全程无 `UnicodeDecodeError`.
- `print('中文')`、含中文的异常回溯正确显示.
- 多行 `for`/`def` 块续行(`...`)与提交正常; 历史上下键、行内光标移动、退格跨整字符正常(由 prompt_toolkit 保证).
- Ctrl-C: 空闲清空当前行; 设备死循环时能中断并回到提示符. Ctrl-D(空行)触发设备 soft reboot 并显示 `soft reboot` 横幅. Ctrl-] 干净退出并释放串口.
- 扩展内 "断开 REPL" / "软复位" 分别只注入 `\x1d` / `\x04`, 由客户端统一响应, 与直接按键行为一致.
- 库存固件(未打 readline 补丁)即可工作; 无需联网/pip(`_vendor/` 已自带).
- 扩展 `vsce package` 后 `_vendor/` 含在 vsix 中, 全新安装即可用.

---

## 9. 决策与遗留事项

已确认决策(见文首):
1. vendoring 进 `scripts/` ✓
2. 自动补全留到 Phase 2 ✓
3. 渲染载体为 VSCode 集成终端 ✓
4. 客户端做成可独立运行的 CLI ✓
5. Ctrl-C/Ctrl-D 与 mpy 自带快捷键一致, 由 keybindings.py 统一入口 ✓

编码阶段再定的小项(不阻塞开始):
- 主循环用 prompt_toolkit 同步 `prompt()` + SIGINT 守护, 还是 `Application.run_async` + asyncio 串口读任务. 推荐异步: 执行态需边读串口边响应 Ctrl-C.
- `pygments` 是否在 Phase 2 裁剪以减小体积.
- 历史文件位置(工作区 `.mpy-workbench/repl_history` vs 用户目录), 默认前者, `--history` 可覆盖.
- `_vendor/` 各包具体版本号(vendoring 时锁定并写入 `VENDOR.md`).
