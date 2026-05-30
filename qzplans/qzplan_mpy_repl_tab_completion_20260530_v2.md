# VScodeMicroPython 自建 REPL Tab 补全与自动缩进 实施计划 (v2)

- 创建时间: 2026-05-30
- 目标仓库: `E:\xm\github\github\VScodeMicroPython`
- 上位文档: [qzplan_mpy_repl_client_20260530_v2.md](qzplan_mpy_repl_client_20260530_v2.md)
- 当前状态: 实施计划(已确认决策), 待编码

---

## 0. 已确认决策

| # | 决策 | 说明 |
|---|---|---|
| 1 | **dotted 成员补全走设备 `dir()`** | 不在 Python 侧重写 stub AST 解析; 属性/成员以设备运行态为准 |
| 2 | **完整 auto-indent(预填缩进)** | 不只是 "Tab 插 4 空格"; 续行进入时预填, Tab/Backspace 配合层级 |
| 3 | **REPL 补全独立于编辑器 Pylance** | 不读 `enableCodeCompletion`; 有 stub 路径时作 bare 前缀增强, 无则退化 |

---

## 1. 目标与边界

### 1.1 Phase 1 目标(本计划范围)

1. **Tab 补全**
   - bare 前缀: 关键词、meta 命令、会话符号、可选 stub 顶层模块名
   - dotted 前缀(`obj.` / `machine.`): **设备 `dir()` 实时查询**
   - 唯一候选 → 直接补到最长公共前缀; 多个 → 候选列表
2. **自动缩进**
   - `def`/`class`/`for`/`if`/`with`/`try`/`elif`/`else`/`except`/`finally`/`while` 等以 `:` 结尾 → 续行**预填**上一级 + 4 空格
   - 普通续行 → 预填与上一行相同缩进
   - 空续行(仅回车) → 提交多行块(与 CPython REPL 一致)
   - Tab: 空白/仅缩进前缀 → 再缩进一级; 标识符/点号末尾 → 补全
   - Backspace: 在仅缩进前缀上 → 退一级(4 空格)
3. **与现有架构兼容**
   - 不回到 friendly REPL 逐字符模式
   - 补全/缩进仅在 **idle**(提示符输入态) 触发; 执行中禁用设备查询
   - 扩展侧只传上下文参数, 不做补全计算

### 1.2 明确不做(Phase 1)

1. 设备运行态 100% 类型推导(如 `x=Pin(...)` 后自动知道 `x` 的成员类型)
2. 字符串/注释内的 "智能" 补全(应禁用)
3. 与 Pylance 共用一套 CompletionProvider
4. Ctrl-E paste mode 全量复刻
5. 补全候选的 docstring/签名浮层(可 Phase 2)

---

## 2. 现状与集成基线(已在代码中核实)

### 2.1 输入层 — `scripts/mpyrepl/session.py`

- `PromptSession`: lexer + InMemoryHistory + key_bindings; **无 completer**
- `multiline=False`: 多行由 `ReplInputBuffer` 逐行 `prompt_async` 累积

### 2.2 多行与最小缩进 — `scripts/mpyrepl/__main__.py` → `ReplInputBuffer`

已有逻辑(需升级, 非从零):

```python
# consume_line: 首行 endswith(":") → 进入续行
# _normalize_continuation_line: 续行无 leading whitespace 时, 复制上一行缩进; 上一行 endswith(":") 再加 4 空格
```

**缺口**: 预填发生在**提交后**对整行字符串做 normalize, 用户看到的是空行再自己输入, 不是 prompt 的 `default=` 预填; 未用 `compile()` 判断块是否完整; Tab/Backspace 未绑定缩进层级。

### 2.3 执行层 — raw-paste + `execute_once`

- `run_async_repl` 中 `execute_once` 返回值**当前被丢弃**, 符号表更新需改为捕获 `ExecResult` 并仅在 `stderr` 为空时更新
- 符号表应解析**原始** `prepared_code`, 非 instrument 后源码

### 2.4 扩展侧 — `src/board/mpremoteCommands.ts`

- 自定义 REPL 经 `buildCustomReplCommand` 启动 `async-repl`
- 当前**未传** `--workspace-root` / `--stub-root` / `--baudrate` 等补全/配置参数
- stub 路径在 TS 侧: `context.workspaceState` 的 `mpy.lastStubPath` / `mpy.lastBaseStubPath`, 以及 `microPythonWorkBench.stubInstallPath`

---

## 3. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│  VS Code 扩展 (TypeScript)                                   │
│  - 解析 workspaceRoot / stubRoot / extraStubPaths / baud   │
│  - 启动 mpyrepl async-repl (与 enableCodeCompletion 无关)    │
└──────────────────────────┬──────────────────────────────────┘
                           │ CLI 参数
┌──────────────────────────▼──────────────────────────────────┐
│  mpyrepl Python 进程                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │ indent.py   │  │ completion_* │  │ session.py          │ │
│  │ 预填/default│  │ engine+dir() │  │ completer+Tab绑定   │ │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬──────────┘ │
│         │                │                      │            │
│         └────────────────┼──────────────────────┘            │
│                          ▼                                    │
│              run_async_repl (idle 输入 / executing 执行)      │
│                          │                                    │
│              ReplInputBuffer + transport.exec_raw           │
└──────────────────────────┼──────────────────────────────────┘
                           │ raw-paste
┌──────────────────────────▼──────────────────────────────────┐
│  MicroPython 设备                                            │
│  - exec 用户源码 / dir(expr) 查询 / 会话 globals             │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 补全数据源策略(混合, 已拍板)

| 场景 | 数据源 | 理由 |
|---|---|---|
| bare 前缀 `ma` | 本地: keywords + meta + 会话符号 + stub 顶层模块名(可选) | 零串口往返, 模块名 stub 索引足够 |
| dotted `machine.` | **设备 `dir(machine)`** | 运行态准确, 自定义板/动态成员 |
| dotted `m.` (import as m) | 会话符号解析 → `machine` → **设备 `dir()`** | 绑定关系在本地, 成员在设备 |
| 无 stub | bare 仍可用; dotted 仍走 `dir()` | 退化可接受 |

不在 Python 侧实现 `completion_stubs.py` 的 AST 成员解析; 仅保留**模块名索引**(扫描 stub 目录文件名 → 模块路径列表), 供 bare 前缀.

### 3.2 设备 `dir()` 查询设计

**触发条件**: completer 解析出 `CompletionTarget.kind == "dotted"`, 且 `state.executing == False`.

**查询方式**: 经已有 `transport.exec_raw` 执行一次性表达式(走 instrument 包装仅当需要 echo 时 — **dir 查询不应 echo**):

```python
# 注入到 repl_semantics 或 completion_device.py
DIR_QUERY_TEMPLATE = """
_names = dir({expr})
print('\\n'.join(repr(n) for n in _names if not n.startswith('_')))
""".strip()
```

或更稳妥: 使用已有 helper 通道, 执行:

```python
import json
print(json.dumps([n for n in dir({expr}) if not str(n).startswith('_')]))
```

MicroPython 是否有 `json` 需实测; 若无, 用 `repr` 分行输出 + 主机侧 `ast.literal_eval` 解析.

**超时**: 单独 `dir_query_timeout`(默认 2s), 短于 `follow_timeout`; 超时 → 返回空候选, 不杀 REPL 会话.

**串口独占门(必须新增)**:

所有会打到 `transport` 的操作, 必须经同一个串行化门控, 不能只靠 `complete_in_thread=True`。

建议新增 `SerialOperationGate` 或等价锁, 统一包住：

1. 用户代码执行
2. 设备 `dir()` 查询
3. helper reinject
4. soft reset / interrupt-reset
5. control watcher 触发的中断与退出前动作

约束规则：

1. 任一时刻只允许一个 transport 操作占用串口
2. `dir()` 查询若发现 gate 已被执行态占用, 直接返回空候选, 不等待长队列
3. control watcher 的 `interrupt` 可以打断正在执行的设备代码, 但实际写串口动作仍通过同一 gate 进入
4. soft reset 与 helper reinject 必须作为一个串行事务完成, 中间不插入补全查询

**并发**: Tab 补全在 prompt 线程; `dir()` 必须 `asyncio.to_thread(transport.exec_raw, ...)` 且通过上述 gate 进入。执行态期间禁止第二次 Tab 查询(可直接忽略或返回空候选)。

**副作用**: `dir()` 只读, 不修改 globals; 若 expr 含副作用(如 `open()`), 文档注明 "仅对简单名称补全".

**缓存**: 同一 idle 周期内, `(expr, attr_prefix)` → 候选列表缓存 1 次; 执行用户代码成功后清空缓存.

---

## 4. 自动缩进(完整设计)

### 4.1 原则

1. **预填优先**: 进入续行 prompt 时, 通过 `prompt_async(..., default=computed_indent_prefix)` 让用户看到已填好的空格, 可直接继续输入或回车提交
2. **compile 完整性**: 是否还需续行, 用 `compile(text, '<repl>', 'exec')` + SyntaxError 的 `msg`/`lineno` 判断(incomplete), 替代仅 `endswith(":")`
3. **Tab / Backspace 与补全分离**: 自定义 `@bindings.add("tab")` / `"backspace"`, 见 4.4

### 4.2 新增模块 `indent.py`

```python
INDENT = "    "  # 4 spaces, 与 MicroPython REPL 一致

def leading_indent_width(line: str) -> int:
    """返回行首空格数(不处理 tab, Phase 1 统一空格)."""

def continuation_default(previous_lines: list[str]) -> str:
    """根据已缓冲行计算下一行 default 前缀(仅空格, 无用户代码)."""

def is_block_complete(source: str) -> bool:
    """compile(source, '<repl>', 'exec') 成功 → 可提交; SyntaxError incomplete → 继续续行."""

def tab_insert_at_cursor(line: str, cursor_col: int) -> tuple[str, int]:
    """空白区域 Tab: 插入一级 INDENT, 返回新文本与新光标."""

def backspace_dedent_prefix(line: str, cursor_col: int) -> tuple[str, int] | None:
    """若光标前仅为 INDENT 的整数倍, 退一级; 否则 None 交默认退格."""
```

**`continuation_default` 规则**:

1. 无缓冲行 → `""`
2. 上一行 `strip()` 以 `:` 结尾 → `leading_indent(上一行) + INDENT`
3. 否则 → 与上一行相同 leading indent 字符串
4. `else:` / `elif:` / `except:` / `finally:` 与上一逻辑块对齐(Phase 1 可简化为: 复制上一行 indent; Phase 1.1 再按 AST  dedent)

### 4.3 改造 `ReplInputBuffer` 与 `run_async_repl`

**流程**:

```text
loop:
  prompt = ">>> " or "... "
  default = continuation_default(buffer.lines) if buffer.lines else ""
  line = await session.prompt_async(prompt, default=default)

  if buffer empty and line complete single: execute
  else:
    append line to buffer
    if is_block_complete(join(buffer)): execute on empty next line OR explicit submit
    else: continue loop
```

**与现有 `consume_line` 对齐**:

- 保留 "空续行提交" 语义: 缓冲非空且当前 `line.strip()==""` → 拼接执行
- 用 `is_block_complete` **替代** 仅 `endswith(":")` 进入续行, 支持 `(` `[` `{` 续行
- `_normalize_continuation_line` 可废弃或仅作 fallback(预填已覆盖大部分场景)

**prompt_toolkit `default=` 语义(必须写死)**:

默认缩进前缀只是一种“预填显示”, 不能直接等同于用户真实输入。

必须定义成下面这套规则：

1. 进入续行时, `default` 仅用于显示建议缩进
2. 若用户未在 `default` 后输入任何非空白内容就直接回车, 这次输入应视为“空续行”
3. 空续行在缓冲非空时表示“提交多行块”, 而不是把一串纯空格作为真实代码送到设备
4. 只有当用户在 `default` 后真正输入了内容, 才把 `default + user_text` 视为有效源码行

因此 Enter 绑定不能直接使用 prompt_toolkit 默认提交行为, 而应显式比较：

1. `document.text`
2. 当前 `default` 前缀
3. 去掉 `default` 后的真实用户输入

再决定是：

1. 提交空续行
2. 接受当前源码行并继续续行
3. 立即执行

### 4.4 Tab / Backspace 键位(写入 `session.py` 或 `keybindings.py`)

| 键 | 条件 | 行为 |
|---|---|---|
| Tab | 当前行仅空白或光标前为空白缩进前缀 | `tab_insert_at_cursor` 插入 4 空格 |
| Tab | 光标位于标识符/点号表达式末尾(且不在字符串/注释) | 触发 `Completer.get_completions` |
| Tab | 补全无候选 | 回退为插入 4 空格(与 CPython 一致) |
| Backspace | 光标前为纯 INDENT 前缀 | 退一级 4 空格 |
| Backspace | 其他 | 默认删字符 |

**Enter**: 自定义绑定 — 若 `is_block_complete(accumulated)` 且非 "空续行提交" 模式, 提交; 否则若 incomplete, 接受当前行并进入下一续行(带新 default).

(若 Enter 自定义与 prompt_toolkit 默认冲突, 参考 ptpython 的 `_accept_line` 实现.)

---

## 5. Tab 补全模块设计

### 5.1 文件结构

```text
scripts/mpyrepl/
  completion_models.py    # CompletionConfig, CompletionTarget, CompletionCandidate
  completion_parser.py  # parse_target(text_before_cursor) → bare|dotted|none; 跳过 str/comment
  completion_locals.py  # keywords, meta, session symbols, stub 模块名索引
  completion_device.py  # build dir() query, exec via transport, parse names
  completion_engine.py  # MpyReplCompleter(prompt_toolkit Completer)
  indent.py             # 见第 4 节
```

不新增 `completion_stubs.py` 大 AST 解析; stub 仅 **模块名列表**:

```python
def list_top_level_modules(stub_root: str) -> list[str]:
    # 扫描 stub_root 下 *.pyi, 映射 a/b/c.pyi → a.b.c
```

### 5.2 会话符号表 — `completion_locals.py`

记录最小事实(执行成功且 stderr 空后更新):

| 语句 | 记录 |
|---|---|
| `import machine as m` | `m` → 模块 `machine` |
| `from machine import Pin` | `Pin` → `machine.Pin` |
| `def f():` / `class C:` | 顶层名 → kind function/class |
| `x = 1` | `x` → generic (bare only) |
| `with open() as f:` / `AnnAssign` | Phase 1 尽量覆盖 |

解析: 对**原始**提交源码 `ast.parse`; 失败则不更新.

**dotted 解析**: `m.Pin.` → resolve `m` → `machine.Pin` → device `dir(machine.Pin)` 或 `dir(Pin)` 若已在设备 globals.

### 5.3 `completion_parser.py`

```python
@dataclass
class CompletionTarget:
    kind: Literal["none", "bare", "dotted", "blank_indent"]
    prefix: str           # bare: 标识符前缀
    root_expr: str        # dotted: "machine" or "m"
    attr_prefix: str      # dotted: "P" for Pin
```

- 用 `tokenize.generate_tokens` 或简单反向扫描, **跳过字符串与注释**
- 光标必须在标识符或 `.` 之后

### 5.4 `MpyReplCompleter` — `completion_engine.py`

```python
class MpyReplCompleter(Completer):
    def __init__(self, config, session_symbols, stub_modules, transport, state, loop):
        ...

    def get_completions(self, document, complete_event):
        target = parse_target(document.text_before_cursor)
        if target.kind == "blank_indent":
            return
        if target.kind == "bare":
            yield from local_candidates(...)
        if target.kind == "dotted":
            if state.executing:
                return
            names = device_dir_members(transport, target.root_expr, session_symbols, cache)
            yield from filter_prefix(names, target.attr_prefix)
```

**`complete_in_thread=True`**: prompt_toolkit 建议在 completer 可能阻塞时使用; 设备 `dir()` 必须在此模式或 async 包装下运行.

### 5.5 本地候选(始终可用, 与 Pylance 无关)

1. `keyword.kwlist` + `True`/`False`/`None`
2. `:q` / `:quit` / `:exit`
3. 会话顶层符号 + `_`
4. stub 顶层模块名(若 `--stub-root` 非空)

---

## 6. CLI 与扩展集成

### 6.1 新增 CLI 参数 — `cli.py` / `ReplConfig`

| 参数 | 说明 |
|---|---|
| `--workspace-root` | 工作区根, 解析相对 stub 路径 |
| `--stub-root` | 可选; bare 模块名补全 |
| `--extra-stub-path` | 可重复; overlay |
| `--dir-query-timeout` | 默认 2.0 |
| `--no-repl-completion` | 关闭补全(仅缩进) |

**不新增** `--follow-editor-completion`; REPL 补全默认开启(在 experimentalCustomRepl 下).

### 6.2 TypeScript — `buildCustomReplCommand`

```typescript
function resolveReplStubRoot(context, workspaceRoot): string | undefined {
  // 1. workspaceState mpy.lastBaseStubPath || mpy.lastStubPath
  // 2. workspaceFolder + stubInstallPath
  // 3. undefined
}

// 与 microPythonWorkBench.enableCodeCompletion 无关
args.push('--workspace-root', quote(workspaceRoot));
if (stubRoot) args.push('--stub-root', quote(stubRoot));
for (const p of extraPaths) args.push('--extra-stub-path', quote(p));
args.push('--baudrate', String(baud));  // 与既有评审一致
```

可选配置: `microPythonWorkBench.replCompletionEnabled`(默认 true), 仅控制 REPL, 与编辑器补全无关.

### 6.3 `build_prompt_session` 改造

```python
def build_prompt_session(
    completer=None,
    extra_bindings=None,
) -> PromptSession:
    return PromptSession(
        lexer=PygmentsLexer(PythonLexer),
        multiline=False,
        history=FileHistory(...) or InMemoryHistory(),  # Phase 1.1: 持久 history
        key_bindings=merge(soft_reset, exit, tab, backspace, enter),
        completer=completer,
        complete_in_thread=True,
        ...
    )
```

`run_async_repl` 内创建 `MpyReplCompleter` 并传入; 创建 `SessionSymbolTable` 并在执行成功后更新.

---

## 7. 执行后更新与 soft reset

| 事件 | 符号表 | dir 缓存 | helper |
|---|---|---|---|
| 执行成功(stderr 空) | 更新 | 清空 | 保持 |
| 执行失败 | 不更新 | 清空 | 保持 |
| soft reset | **清空** | 清空 | **重新 inject** |
| 用户 `:quit` | 丢弃 | — | — |

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Tab 时 `dir()` 阻塞 UI | `complete_in_thread=True` + 短超时 |
| 执行中误触 Tab | `state.executing` 门控; completer 返回空 |
| 控制文件与 dir 查询抢串口 | executing 期间 control watcher 仍可调 interrupt; dir 查询也设 executing |
| `dir()` 对未定义名抛错 | try/except 包裹 exec; 返回空候选 |
| 预填 default 与用户输入混淆 | 文档 + Enter 绑定测试 |
| stub 模块名与设备不一致 | dotted 以设备为准; bare 模块名仅辅助 |
| 中文/UTF-8 | 补全标识符 ASCII 为主; 不影响 |

---

## 9. 测试计划

### 9.1 单元测试(无设备)

- `completion_parser`: bare/dotted/字符串内/注释内/链式 `a.b.c.`
- `completion_locals`: import/as/from 符号记录
- `indent.continuation_default`: `def f():`, `else:`, 普通续行
- `indent.is_block_complete`: `(`, `[`, `{` 未完成
- `list_top_level_modules`: 临时目录 pyi 扫描

### 9.2 集成测试( mock transport )

- `device_dir_members`: mock exec 返回 `['Pin', 'PWM']`
- Tab 绑定: 空白 → 4 空格; 有 prefix → 调 completer

### 9.3 人工验收

1. `ma` + Tab → `machine`(stub 或会话)
2. `import machine` 回车 → `machine.` + Tab → 列出 Pin 等(设备 dir)
3. `import machine as m` → `m.` + Tab → 同 2
4. `def f():` 回车 → 续行预填 4 空格; 再输入 `pass` 回车; 空续行提交
5. `for i in range(3):` 续行预填; Tab 在空白处加 4 空格; Backspace 退一级
6. 关闭编辑器代码补全, REPL Tab 仍可用
7. 执行 `while True: pass` 时 Tab 不触发 dir 查询(或 executing 门控)

---

## 10. 实施顺序

1. **`indent.py` + 改造 `ReplInputBuffer` / Enter 逻辑 + default 预填** — 先交付 auto-indent 体验
2. **`completion_parser` + `completion_locals` + bare 本地 completer** — 无设备即可测
3. **`completion_device` + `MpyReplCompleter` dotted 路径** — 真机验证 dir
4. **Tab/Backspace 绑定与 `complete_in_thread`**
5. **扩展传参 stub-root / workspace-root / baud**
6. **执行后符号表更新(捕获 ExecResult)**
7. **单元测试 + 文档**

---

## 11. 验收标准(Phase 1)

- [ ] 输入 `machine.` + Tab 能列出设备成员( dir )
- [ ] 输入 `ma` + Tab 能补全模块名或关键词
- [ ] `def f():` 后续行自动预填一级缩进; 空行提交块
- [ ] Tab 在续行空白处增加缩进; 在 `foo` 后触发补全
- [ ] 关闭 `enableCodeCompletion` 后 REPL Tab 仍工作
- [ ] soft reset 后 helper 与符号表恢复正确
- [ ] 执行长任务/executing 时 Tab 不发起 dir 查询

---

## 12. Phase 2(后续, 本计划不实施)

1. 补全 docstring / 签名提示
2. `FileHistory` 持久化到 `.mpy-workbench/repl_history`
3. `else`/`elif` 基于 AST 的智能 dedent
4. 设备 `globals()` 增量同步(可选, 减少 import 后解析依赖)

---

## 13. 与 v1 计划差异摘要

| v1 | v2(本文) |
|---|---|
| Phase 1 纯本地 stub AST 成员 | **dotted 用设备 dir()** |
| Tab 缩进仅 4.5 一行描述 | **完整 auto-indent 专章 + indent.py** |
| 5 个 completion_* 含 stubs 解析 | 精简为 locals + device + parser + engine |
| 待确认三项 | **已确认并写入第 0 节** |

---

## 14. 参考

- MicroPython REPL: paste/raw 模式; 设备 friendly Tab 不适用于本客户端
- prompt_toolkit: `Completer`, `complete_in_thread`, `PromptSession(default=...)`, custom Tab binding
- 现有代码: `ReplInputBuffer._normalize_continuation_line`, `repl_semantics.instrument_source`, `FileControlChannel`
