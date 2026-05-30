# VScodeMicroPython 自建 REPL Tab 补全实施计划 (v1)

> **已 supersede**: 请使用 [v2](qzplan_mpy_repl_tab_completion_20260530_v2.md) — 含设备 `dir()`、完整 auto-indent 预填、REPL 补全独立于 Pylance 的已确认决策.

- 创建时间: 2026-05-30
- 目标仓库: E:\xm\github\github\VScodeMicroPython
- 目标范围: 为当前自建 mpyrepl 客户端补上可用的 Tab 补全方案，并明确与多行输入、自动缩进、设备状态一致性的取舍。
- 当前状态: 仅为实施计划，不开始编码，等待确认。

---

## 0. 结论先行

### 0.1 推荐路线

推荐采用“本地静态补全优先，设备侧动态补全后置”的两阶段方案：

1. Phase 1 做本地补全。
2. Phase 2 再评估设备侧 `dir()` 或 helper 查询补全。

理由：

1. 当前自建 REPL 是本地 prompt_toolkit 输入，再通过 raw-paste 提交到设备，不是设备 friendly REPL 的逐字符终端透传。
2. 这意味着 MicroPython 文档里的设备侧 Tab 自动补全不会天然存在。
3. 当前仓库已有 stub 选择、索引、板型匹配基础设施，可以为本地补全提供稳定的数据源。
4. 设备侧动态补全虽然更贴近真实运行态，但会引入额外串口往返、状态同步、执行安全和控制路径竞争问题，不适合直接作为第一版。

### 0.2 Phase 1 的目标定义

Phase 1 不是“完整复刻设备 friendly REPL”，而是做到下面这几个高价值场景：

1. 输入模块名前缀时，Tab 可以补全模块名。
2. 输入 `machine.` 这类点号访问时，Tab 可以补全成员。
3. 已在 REPL 中定义或导入的符号，可以参与补全。
4. 多行输入场景里，Tab 不破坏缩进体验。

### 0.3 Phase 1 明确不做

1. 不追求设备运行态 100% 准确的动态对象成员补全。
2. 不依赖设备固件编译参数来决定是否有补全。
3. 不把 Tab 补全和编辑器 Pylance 补全强耦合成一套实现。
4. 不把 REPL 改回 friendly REPL 逐字符终端模式。

---

## 1. 已确认事实

### 1.1 当前 REPL 输入层没有 completer

当前 [scripts/mpyrepl/session.py](scripts/mpyrepl/session.py) 里，PromptSession 只配置了：

1. lexer
2. history
3. key bindings

没有任何 completer，因此当前“按 Tab 没反应”是实现现状，不是漏传参数。

### 1.2 当前 REPL 执行层走 raw REPL 或 raw-paste

当前 [scripts/mpyrepl/transport.py](scripts/mpyrepl/transport.py) 和 [scripts/mpyrepl/__main__.py](scripts/mpyrepl/__main__.py) 的核心模式是：

1. 主机端维护输入体验
2. 主机端把整段源码提交给 raw REPL
3. 设备只负责执行结果与输出返回

这决定了 MicroPython 文档里的设备侧 friendly REPL Tab 补全，不会自动透传到当前客户端。

### 1.3 当前计划 v2 把设备侧 Tab 自动补全列为了 Phase 2

现有 [qzplans/qzplan_mpy_repl_client_20260530_v2.md](qzplans/qzplan_mpy_repl_client_20260530_v2.md) 已明确写过：

1. 本期不做设备侧 Tab 自动补全。
2. 设备 `dir()` 自动补全属于后续增强。

现在如果要提前做补全，需要先确认路线，不适合直接把“设备侧查询”塞进当前 Phase 1。

### 1.4 仓库已有 stub 选择与索引基础设施，但运行在 TypeScript 侧

当前 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts)、[src/completion/stubIndex.ts](src/completion/stubIndex.ts)、[src/completion/stubSupport.ts](src/completion/stubSupport.ts)、[src/completion/completionPythonConfig.ts](src/completion/completionPythonConfig.ts) 已经能做这些事：

1. 根据板型与版本选择最合适的 stubs。
2. 索引已安装 stub 路径。
3. 识别 workspace 安装根和额外 overlay。
4. 把这些路径配置给 Pylance。

但这些逻辑运行在扩展宿主的 TypeScript 侧，不会自动进入 Python 的 mpyrepl 进程。

### 1.5 当前扩展包不能假设始终有 bundled code_completion 目录可用

从当前仓库根目录和已打包结果看，本期方案不能把“扩展内一定存在 code_completion bundled stubs”当成硬前提。Phase 1 应优先依赖：

1. workspace 已安装 stubs
2. 扩展显式传入的 stubRoot
3. 没有 stubs 时退化为关键词或会话符号补全

---

## 2. 需求拆解

### 2.1 用户真实需求

用户当前最直接的痛点不是“补全不够聪明”，而是：

1. 没有 Tab 自动补全
2. 多行定义函数或类时，缺少足够的输入辅助
3. 当前自建 REPL 和文档里的设备 REPL 体验差距明显

因此 Phase 1 的优先级应当是：

1. 先把模块名和成员名补全做出来
2. 保证 Tab 不破坏多行缩进
3. 再考虑更动态、更昂贵的设备侧补全

### 2.2 需要确认但可先给出推荐答案的点

1. REPL 补全是否应在扩展代码补全关闭时仍可用。
推荐: 是。REPL 补全应独立于编辑器 Pylance 开关。

2. 没有任何 stub 时是否仍要启用 Tab。
推荐: 是。至少保留关键词、meta 命令和会话符号补全。

3. Tab 在多行续行里优先做补全还是缩进。
推荐: 优先缩进；只有当前行前缀已形成标识符或点号表达式时，才触发补全。

4. Phase 1 是否追求设备运行态对象属性准确性。
推荐: 否。Phase 1 只做本地静态和会话级近似。

---

## 3. 架构方案比较

### 3.1 方案 A: 本地静态补全

数据源：

1. Python 关键字
2. REPL meta 命令
3. 本地会话符号表
4. 选中的 stubRoot
5. workspace extra pyi overlay

优点：

1. 延迟低
2. 不占用额外串口往返
3. 容易和当前 prompt_toolkit 架构融合
4. 易于做缓存和单元测试

缺点：

1. 不能反映设备运行时动态对象的真实成员
2. 自定义板上运行期注入的模块和对象可能补不全

### 3.2 方案 B: 设备侧动态补全

数据源：

1. 设备当前 `globals()`
2. 设备侧 `dir(obj)`
3. 注入 helper 返回候选词

优点：

1. 更接近真实设备当前状态
2. 对自定义模块、动态对象更准确

缺点：

1. 每次 Tab 都要额外发设备请求
2. 需要确保当前 REPL 处于安全空闲态
3. 需要处理超时、异常、副作用和控制键并发
4. 会显著增加当前 REPL 状态机复杂度

### 3.3 推荐取舍

推荐采用混合路线：

1. Phase 1: 本地静态补全
2. Phase 2: 设备侧动态补全作为可选增强源

---

## 4. Phase 1 推荐架构

### 4.1 TypeScript 侧职责

TypeScript 侧不做补全计算，只负责提供补全上下文给 Python 进程。

建议在 [src/board/mpremoteCommands.ts](src/board/mpremoteCommands.ts) 的自定义 REPL 启动参数中增加：

1. `--workspace-root`
2. `--stub-root`
3. `--extra-stub-path` 可重复参数

stubRoot 解析优先级建议为：

1. `workspaceState` 中最近一次应用的 `mpy.lastBaseStubPath` 或 `mpy.lastStubPath`
2. `microPythonWorkBench.stubInstallPath` 对应的 workspace 安装根
3. 若都没有，则传空，由 Python 侧退化运行

### 4.2 Python 侧新增模块建议

建议在 [scripts/mpyrepl](scripts/mpyrepl) 下新增以下模块：

1. `completion_models.py`
2. `completion_symbols.py`
3. `completion_stubs.py`
4. `completion_parser.py`
5. `completion_engine.py`

职责划分：

1. `completion_models.py`: CompletionConfig、CompletionCandidate、SymbolInfo
2. `completion_symbols.py`: 维护会话符号表
3. `completion_stubs.py`: 扫描 stubRoot、缓存模块与成员索引
4. `completion_parser.py`: 解析当前光标前文本，识别 bare prefix 或 dotted prefix
5. `completion_engine.py`: 聚合关键词、meta 命令、会话符号、stub 候选，输出 prompt_toolkit Completer

### 4.3 会话符号表设计

会话符号表只记录“补全所需的最小事实”，不做复杂类型推导。

记录内容建议包括：

1. `import machine as m` -> `m` 映射到模块 `machine`
2. `from machine import Pin` -> `Pin` 映射到 `machine.Pin`
3. `def f():` -> `f` 为函数符号
4. `class C:` -> `C` 为类符号
5. `x = 1` -> `x` 为普通变量名，仅参与 bare completion，不参与属性解析

更新时机：

1. 仅在设备执行成功后更新
2. 对执行失败的源码不更新符号表，避免本地状态和设备状态分叉

### 4.4 stub 索引策略

不做全量预解析；采用“模块名预索引 + 文件级懒解析”。

启动时：

1. 递归扫描 stubRoot
2. 建立模块路径到文件路径的映射
3. 只记录模块名层级，不解析每个文件内容

首次请求 `machine.` 时：

1. 找到 `machine.pyi`
2. 解析 AST
3. 提取顶层类、函数、常量名
4. 缓存结果

首次请求 `machine.Pin.` 时：

1. 若 `machine` 模块 AST 已缓存，则直接解析该类节点成员
2. 否则先完成 `machine` 模块解析

### 4.5 Tab 键语义

这是 Phase 1 的关键产品决策，必须写死，避免实现时摇摆。

推荐规则：

1. 当前行只有空白前缀时，Tab 插入缩进，不触发补全。
2. 当前光标位于标识符或点号表达式末尾时，Tab 触发补全。
3. 有唯一公共前缀时，直接补全到最长公共前缀。
4. 有多个候选时，展示候选列表。

这样可以兼顾：

1. def 或 for 多行输入时的缩进体验
2. 正常补全模块和成员时的 Tab 行为

### 4.6 关键词与 meta 命令

即便没有 stubs，也建议始终提供这些补全源：

1. Python keywords
2. `True`、`False`、`None`
3. REPL meta 命令，如 `:q`、`:quit`、`:exit`
4. `_` 以及当前会话已定义的顶层名字

---

## 5. 详细工作流

### 5.1 启动流程

1. 扩展解析 workspaceRoot 和 stubRoot
2. 扩展启动 mpyrepl CLI，并传入补全相关参数
3. Python 侧创建 CompletionConfig
4. Python 侧初始化 StubModuleIndex 和 SessionSymbolTable
5. Python 侧把 completer 注入 PromptSession

### 5.2 输入补全流程

1. 用户按 Tab
2. prompt_toolkit 调用 completer
3. completer 读取 `document.text_before_cursor`
4. parser 判断是 bare prefix 还是 dotted prefix
5. engine 从对应数据源合并候选
6. 返回 prompt_toolkit Completion 列表

### 5.3 执行后更新流程

1. 用户输入源码并执行成功
2. executor 拿到原始源码文本
3. SessionSymbolTable 解析 AST 并提取顶层符号
4. 更新后续补全候选

---

## 6. 关键伪代码

### 6.1 TypeScript 启动参数

```text
stubRoot = resolveReplStubRoot(context, workspaceRoot)
command = python mpyrepl __main__.py --port COM4 async-repl \
  --workspace-root <workspaceRoot> \
  --stub-root <stubRoot> \
  --extra-stub-path <path1> \
  --extra-stub-path <path2>
```

### 6.2 Python 侧 completer 聚合

```text
def get_candidates(text_before_cursor):
    target = parse_completion_target(text_before_cursor)
    if target.kind == "blank-indent":
        return []

    if target.kind == "bare":
        return merge(
            keyword_candidates(prefix),
            meta_command_candidates(prefix),
            session_symbol_candidates(prefix),
            top_level_stub_module_candidates(prefix),
        )

    if target.kind == "dotted":
        resolved = session_symbols.resolve(target.root)
        return stub_index.member_candidates(resolved or target.root, target.attr_prefix)

    return []
```

### 6.3 执行成功后更新符号表

```text
def on_exec_success(source):
    tree = ast.parse(source)
    for node in tree.body:
        if Import:
            record alias -> module
        elif ImportFrom:
            record name -> module.member
        elif FunctionDef:
            record function name
        elif ClassDef:
            record class name
        elif Assign:
            record assigned names as generic symbols
```

---

## 7. 风险与边界

### 7.1 补全准确性风险

Phase 1 只能近似当前设备状态，不能保证：

1. 动态 monkey patch 后的属性
2. 运行期生成的对象成员
3. 板上私有模块的真实 API

### 7.2 自定义板风险

像 `my_custom/boards/ESP32_S3_PET_V3` 这种自定义板，若没有匹配 stubs，Phase 1 补全会退化成：

1. 关键词
2. 会话符号
3. 通用 MicroPython stubs

这不代表补全实现错误，而是数据源精度限制。

### 7.3 Tab 键冲突风险

如果不把“缩进优先”写死，会重新破坏当前刚修好的多行输入体验。

因此 Phase 1 必须坚持：

1. 行首空白场景优先缩进
2. 标识符场景才触发补全

### 7.4 包体与运行时路径风险

当前扩展包不能强依赖某个固定 bundled stub 目录存在，因此补全实现必须支持：

1. 传空 stubRoot 仍能运行
2. 无 stubs 退化模式
3. workspace 本地安装 stubs 优先

---

## 8. 验收标准

### 8.1 Phase 1 验收

1. 输入 `ma` 后 Tab 能补全到 `machine`
2. 输入 `machine.` 后 Tab 能列出或补全成员
3. 输入 `import machine as m` 后，`m.` 可补全
4. 输入 `def f():` 后，多行缩进体验不被 Tab 破坏
5. 没有 stubs 时，至少还有关键词、meta 命令、会话符号补全

### 8.2 明确不作为 Phase 1 验收的内容

1. 设备运行态对象的实时属性补全
2. 100% 对齐 MicroPython friendly REPL 的原生 Tab 行为
3. Ctrl-E paste mode 全量复刻

---

## 9. 推荐实施顺序

1. 先确认 Phase 1 只做本地静态补全，不做设备侧查询。
2. 在 Python 侧独立实现 CompletionEngine，并用本地 stubRoot 做单元测试。
3. 把 completer 接入 PromptSession。
4. 再在扩展侧补 stubRoot 传参与 fallback 逻辑。
5. 最后做真机验证和 UX 微调。

---

## 10. 待你确认的决策

1. 是否接受 Phase 1 先做本地静态补全，不碰设备侧动态补全。
2. 是否接受 Tab 在续行空白场景优先做缩进，而不是补全。
3. 是否要求 REPL 补全在“编辑器代码补全关闭”时仍然工作。

我的推荐答案分别是：

1. 接受
2. 接受
3. 接受

如果这三条确认，就可以进入实现阶段。