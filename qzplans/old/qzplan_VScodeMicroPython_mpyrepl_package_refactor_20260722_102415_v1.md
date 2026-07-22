# VScodeMicroPython mpyrepl Package Refactor Plan

Created: 2026-07-22
Status: Implemented and verified

## 1. 目标与边界

### 主要目标

- 将 `scripts/mpyrepl` 从混合运行代码、测试和第三方依赖的扁平目录,重构为职责清晰的 Python 包.
- 保持扩展使用的 `scripts/mpyrepl/__main__.py`入口、现有 CLI 参数、manager RPC 和串口行为兼容.
- 保持 Agent CLI 只加载 Python 标准库路径,不因包重构提前导入 prompt-toolkit、Pygments 或 pyserial.
- 将 Python 测试集中到独立测试目录,同步修正测试发现、覆盖率统计和 VSIX排除规则.
- 补齐中英文README、REPL架构说明和独立Agent CLI参考文档.

### 非目标

- 不改变 raw REPL、文件传输、补全、串口探测、排队或事件广播算法.
- 不新增Python或Node依赖,不替换 `_vendor`内的第三方版本.
- 不修改TypeScript对 `scripts/mpyrepl/__main__.py`的入口约定.
- 不保留未公开的扁平模块导入作为长期公共API.
- 不安装或替换本机VS Code扩展.

### 成功标准

- `python scripts/mpyrepl/__main__.py ...`现有命令全部可用.
- Agent路径仍可在缺少TUI/pyserial导入的情况下完成会话发现和JSON错误输出.
- Python和TypeScript测试数量不下降,覆盖率继续高于80%.
- VSIX包含所有运行模块和 `_vendor`,但不包含Python测试、覆盖率工具或缓存.
- `build.ps1`完整通过,版本从 `0.4.30`自动提升到 `0.4.31`,产物位于 `release/`.

## 2. 项目现状

- `scripts/mpyrepl`当前有38个顶层Python文件,其中12个为测试文件.
- `__main__.py`约33KB,同时包含入口分发、直接串口命令、旧异步REPL和控制通道逻辑.
- `fs_ops.py`、`completion_engine.py`、`transport.py`等领域模块与CLI、测试处于同一级.
- `_vendor`已有独立目录,包含prompt-toolkit、Pygments和wcwidth,该边界合理且继续保留.
- 当前源码使用 `from manager_protocol import ...`等扁平导入;直接移动文件会产生模块重复加载或入口失败.
- `run_python_tests_with_coverage.py`只统计当前目录的 `*.py`,不能覆盖重构后的子包.
- `.vscodeignore`只排除 `scripts/mpyrepl/test_*.py`,需要适配测试目录.
- TypeScript只依赖 `scripts/mpyrepl/__main__.py`路径,内部Python模块名没有跨语言依赖.

## 3. 已确认需求与关键假设

- 用户已确认执行目录结构重构,并要求重构后更新文档.
- 保留现有命令入口比保留内部扁平模块路径优先级更高.
- 测试可以迁移,但测试覆盖的行为和断言不能因移动而减少.
- 使用绝对包导入 `mpyrepl.*`,避免同一文件以扁平名和包名加载两次.
- 入口脚本会把 `scripts/`加入 `sys.path`,因此直接文件运行和 `python -m mpyrepl`都能解析同一包.
- `_vendor`继续由bootstrap置于导入路径前部,仅人工REPL/补全路径使用.

## 4. 目标目录设计

```text
scripts/mpyrepl/
  __init__.py
  __main__.py                 # 轻量入口和Agent早期分流
  bootstrap.py                # 包根与_vendor导入路径
  app.py                      # CLI解析和顶层命令分发
  cli.py
  clients/
    __init__.py
    agent.py
    repl.py
  manager/
    __init__.py
    protocol.py
    server.py
    session.py
  runtime/
    __init__.py
    decode.py
    models.py
    operation_gate.py
    transport.py
    filesystem.py
  completion/
    __init__.py
    device.py
    engine.py
    fallbacks.py
    parser.py
    state.py
    stubs.py
  repl/
    __init__.py
    async_runner.py
    indent.py
    lexer.py
    semantics.py
    session.py
    control.py
  tests/
    __init__.py
    test_*.py
    run_with_coverage.py
    requirements.txt
  _vendor/
```

### 模块边界

- `clients`: 人工交互客户端和标准库Agent客户端.
- `manager`: NDJSON协议、TCP服务、多客户端会话.
- `runtime`: 串口、文件系统、数据模型、解码和串行门控.
- `completion`: 补全解析、stub索引、运行时属性查询和会话符号.
- `repl`: prompt-toolkit会话、编辑行为、语义改写、旧异步REPL运行器和控制文件兼容路径.
- `app.py`: 只负责构造配置和分发命令,不继续承载具体协议实现.

## 5. 关键调用流

### 普通入口

```text
__main__.py
  -> bootstrap.configure_import_path()
  -> mpyrepl.app.main()
  -> manager / clients.repl / repl.async_runner / runtime
```

### Agent低依赖入口

```text
__main__.py detects first command == agent
  -> mpyrepl.clients.agent.main()
  -> mpyrepl.manager.protocol
  -> Python standard library only
```

`clients/__init__.py`和 `manager/__init__.py`不得主动导入重模块,否则会破坏Agent低依赖保证.

## 6. 文件级任务

### 入口与运行代码

- 修改 `scripts/mpyrepl/__main__.py`: 保留薄入口和Agent早期分流.
- 新增 `scripts/mpyrepl/app.py`: 承接顶层参数解析与命令分发.
- 新增 `scripts/mpyrepl/clients/`,移动 `agent_client.py`和 `repl_client.py`.
- 新增 `scripts/mpyrepl/manager/`,移动manager协议、server和session.
- 新增 `scripts/mpyrepl/runtime/`,移动transport、fs、models、decode和gate.
- 新增 `scripts/mpyrepl/completion/`,移动所有completion模块.
- 新增 `scripts/mpyrepl/repl/`,移动session、lexer、semantics、indent、control,并从旧 `__main__.py`抽出 `async_runner.py`.
- 修改所有运行代码为唯一的 `mpyrepl.*`绝对包导入.

### 测试与构建

- 新增 `scripts/mpyrepl/tests/`,迁移所有 `test_*.py`.
- 将覆盖率脚本迁移为 `scripts/mpyrepl/tests/run_with_coverage.py`,递归统计运行包并排除 `_vendor`和 `tests`.
- 更新测试导入为 `mpyrepl.*`,避免手工插入模块目录和扁平导入.
- 修改 `build.ps1`与 `package.json`的Python测试命令.
- 修改 `.vscodeignore`,排除 `scripts/mpyrepl/tests/**`.
- 更新 `docs/TEST_README.md`中的路径、测试命令和覆盖率说明.

### 文档

- 更新 `README.md`和 `README_zh-CN.md`的manager架构、Agent入口和测试路径.
- 更新 `docs/custom-python-repl.md`和 `docs/custom-python-repl_zh-CN.md`的目录结构和共享manager说明.
- 新增 `docs/agent-cli.md`和 `docs/agent-cli_zh-CN.md`.
- Agent文档覆盖发现顺序、完整命令表、排队/超时、stdout/stderr、JSON结构、退出码、安全限制和示例.
- 更新本计划的实施结果,但不修改历史归档计划.

### 不应修改

- 不修改 `src/board/serialManagerProcess.ts`中的入口文件名.
- 不修改manager RPC方法名或描述文件schema/protocol版本.
- 不修改 `_vendor`源码.
- 不调整与mpyrepl无关的扩展视图、同步或补全设置.

## 7. 分阶段执行

### 阶段1: 建立包入口和基础模块

- 调整bootstrap,保证直接脚本和模块方式共享 `mpyrepl`包身份.
- 移动runtime、manager和clients模块并更新导入.
- 保持旧 `__main__.py`功能暂时可调用,先通过manager/agent定向测试.

完成标准: Agent、manager和人工REPL客户端可导入,无重复模块名.

### 阶段2: 拆分主入口与REPL模块

- 将旧异步REPL实现移至 `repl/async_runner.py`.
- 将命令分发移至 `app.py`,把 `__main__.py`缩减为稳定入口.
- 移动completion和REPL编辑模块,统一绝对包导入.

完成标准: 所有现有CLI参数和返回码保持不变,`__main__.py`不再承载业务实现.

### 阶段3: 测试与覆盖率迁移

- 迁移测试目录和测试导入.
- 更新递归覆盖率收集,确保只统计项目运行源码.
- 更新build、npm命令和VSIX排除规则.

完成标准: Python测试全过且覆盖率不低于80%,VSIX不包含测试.

### 阶段4: 文档与发布验证

- 同步双语README和REPL文档.
- 新增双语Agent CLI完整参考.
- 使用默认 `build.ps1`执行编译、Jest、Python覆盖率、版本提升和release打包.

完成标准: 版本为 `0.4.31`,产物只在 `release/`,不执行扩展安装.

## 8. 验证计划

### 定向验证

```powershell
python scripts/mpyrepl/__main__.py agent --session .mpy-workbench/missing.json status
python -m unittest discover scripts/mpyrepl/tests
npm run compile
```

### 完整验证

```powershell
.\build.ps1
```

检查项:

- Python测试数量不下降,本地源码覆盖率不低于80%.
- 26套Jest测试和110项TypeScript测试继续通过.
- `npx @vscode/vsce ls`确认新子包存在、测试目录不存在.
- 根目录没有VSIX,`release/mpy-0.4.31.vsix`存在.
- Agent缺少会话时只输出一条JSON且不尝试打开串口.
- 人工REPL、Run Active File、manager重连和后台输出相关测试保持通过.

## 9. 风险与注意事项

- 最大风险是同一源码被扁平名和 `mpyrepl.*`包名重复导入,导致类身份、全局状态和mock失效;实施时必须一次性统一导入方式.
- 直接脚本运行时 `__package__`为空,入口必须先加入 `scripts/`而不是仅加入 `scripts/mpyrepl/`.
- `clients.agent`的包初始化链必须保持标准库-only,不能从包 `__init__.py`导入manager session或transport.
- 覆盖率改为递归后分母会变化,必须明确排除 `_vendor`、tests和生成缓存,不能降低阈值掩盖问题.
- 移动测试后 `.vscodeignore`必须同步,否则VSIX会显著增大.
- 默认 `build.ps1`会自动提升版本;只有全部修改和定向测试完成后才能执行一次.
- 工作区已有其他未提交修改,重构必须基于当前内容移动,不得恢复或覆盖先前功能修复.

## 10. 实施结果

- `scripts/mpyrepl` 已按 `clients`、`manager`、`runtime`、`completion`、`repl` 和 `tests` 完成分包.
- `scripts/mpyrepl/__main__.py` 已缩减为稳定入口,业务分发迁入 `app.py`,异步 REPL 实现迁入 `repl/async_runner.py`.
- 所有内部运行导入已统一为 `mpyrepl.*`;Agent 早期入口验证未加载 `serial`、`prompt_toolkit` 或 `pygments`.
- Python 测试迁入 `scripts/mpyrepl/tests/`,递归覆盖率脚本排除了 `_vendor` 和测试源码.
- README、REPL 文档和测试文档已同步,并新增中英文 Agent CLI 完整参考.
- `build.ps1` 完整通过:26 个 Jest suites、110 项 TypeScript 测试、187 项 Python 测试,Python 包源码覆盖率 81.8%.
- 版本已从 `0.4.30` 提升到 `0.4.31`,产物为 `release/mpy-0.4.31.vsix`,未安装扩展.
