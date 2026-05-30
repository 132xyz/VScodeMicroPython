# VScodeMicroPython 测试架构与覆盖率提升实施计划 v1

## 1. 目标设定

### 主目标
- 在尽量少改源码的前提下，优先通过外部环境仿真、VS Code API mock、terminal mock、文件系统 mock、mpremote mock 提升 JS 覆盖率。
- 先解决“总体覆盖率为什么低”的结构性阻碍，再决定哪些文件值得拆分。
- 为后续继续把 JS 覆盖率从当前约 33.43% 向 40% 以上推进，建立一条稳定、可复用的测试路线。

### 子目标
- 识别当前真正拉低总体覆盖率的分母文件。
- 区分“当前活跃运行路径”和“遗留但仍计入覆盖率的路径”。
- 给出每个大文件的可测试边界、不可稳定单测的边界、适合仿真的边界。
- 给出最小源码改动原则下的优先级顺序。
- 在必须改源码时，只做高价值抽离，例如路径归一化 helper、终端状态机边界、纯比较 planner。

## 2. 现有参考

### 当前已验证的高收益模式
- extension 激活入口适合 activate smoke test，加命令回调直打。
- codeCompletion 适合直接覆盖私有 helper、状态栏、启停与 Pylance 交互路径。
- fileCommands、syncCommands 适合做命令级 mock-heavy 单测，不必先改源码。
- board/mpremoteCommands 适合做 terminal object mock、fake timers、child_process mock。
- 路径归一化与映射逻辑一旦抽成 helper，测试收益最高且长期稳定。

### 当前覆盖率关键事实
- 总体 JS 覆盖率约 33.43%。
- board 目录 statements 体量接近总体一半，但目录覆盖率只有约 10.44%。
- 已显著提升的文件：
  - src/core/extension.ts
  - src/completion/codeCompletion.ts
  - src/commands/fileCommands.ts
  - src/commands/syncCommands.ts
  - src/board/mpremoteCommands.ts
- 仍是 0% 或接近 0% 的关键大文件：
  - src/board/boardOperations.ts
  - src/board/esp32Fs.ts
  - src/ui/decorations.ts
  - src/python/pythonInterpreter.ts
  - src/board/mpremote.ts
  - src/board/MpRemoteManager.ts

## 3. 需求分析

### 用户真实诉求
- 不要只靠修改源码强行提覆盖率。
- 优先考虑外部环境仿真与 mock 策略。
- 先搞清楚哪些结构阻碍测试，哪些大文件值得拆，哪些几乎不能稳定测。

### 当前结构性阻碍
- board 目录分母过大且长期低覆盖。
- 多个文件重复实现相似逻辑：初始化、路径映射、ignore 文件、auto-suspend、同步入口。
- 大文件经常把 VS Code glue、文件系统、外部进程、设备交互、状态机写在一起。
- 遗留模块仍计入覆盖率，例如 boardOperations 中部分 baseline sync 逻辑不是当前主路径。
- 一些现有测试打的是旧入口，不是当前运行时入口。

### 需要确认的关键判断
- boardOperations 是否还承担未来主路径，还是应只保留 checkDiffs 一类仍在运行的部分。
- esp32Fs 是否值得先补测试而不是先拆，因为它是 0% 且高度可 mock。
- pythonInterpreter 是否应优先作为低风险高收益文件处理。
- mpremote.ts 与 MpRemoteManager 是否需要在后续阶段拆出更明确的 adapter 边界。

## 4. 架构设计

### 现状分层
- VS Code glue 层：extension.ts、各 commands/*.ts
- 同步与路径层：sync/*.ts、activeFileSync.ts、workspaceUtils.ts
- 设备/终端层：board/mpremoteCommands.ts、board/mpremote.ts、board/MpRemoteManager.ts
- 树与装饰层：board/esp32Fs.ts、ui/decorations.ts
- 补全层：completion/codeCompletion.ts 及相关模块
- Python 环境层：python/pythonInterpreter.ts、python/pyraw.ts

### 建议目标分层
- 命令层：只保留 prompt、toast、registerCommand、progress glue
- 服务层：执行同步、删除、重命名、下载上传等业务动作
- 纯逻辑层：路径归一化、路径映射、差异规划、排序、过滤、状态转换
- 适配层：VS Code terminal adapter、mpremote adapter、Python interpreter adapter、filesystem adapter
- 展示层：TreeItem 工厂、status bar presenter、decorations provider

### 直接可拆的边界
- 路径归一化 helper：统一 serial connect 解析、device path 拼接、local path 映射
- diff planner：把 boardOperations 中比较逻辑抽纯函数
- terminal state machine：把 mpremoteCommands 的 run/repl 状态切换抽纯状态机
- tree model：把 esp32Fs 的 merge/filter/sort/cache 从 TreeItem 构造中分离
- interpreter resolution：把 pythonInterpreter 的发现、验证、提示拆层

## 5. 重点模块分析

### src/core/extension.ts
- 现状：activate 内闭包过多，但 smoke test 模式已经验证可测。
- 阻碍：事件注册、workspaceState、watcher、timers、全局对象混在一起。
- 适合继续测试：命令回调、autosave、terminal close、配置变化、workspaceState toggle。
- 是否必须拆分：暂时不必须，继续靠 smoke + callback 直打仍高收益。

### src/completion/codeCompletion.ts
- 现状：已经进入高覆盖区。
- 阻碍：单例状态、用户 prompt、Pylance 交互。
- 适合继续测试：chooseStub 失败分支、disable 清理、language server 重启失败链。
- 是否必须拆分：非必须，可继续靠 helper + mock 推进。

### src/commands/fileCommands.ts
- 现状：命令层可 mock，已经具备持续扩展测试的条件。
- 阻碍：save listener、删除流程、rename 与本地/板端双写。
- 适合继续测试：deleteBoardAndLocal 安全分支、ignored save、rename fallback。
- 是否必须拆分：非必须，后续可按服务层抽离重复逻辑。

### src/commands/syncCommands.ts
- 现状：当前运行时主路径，已经较易测试。
- 阻碍：取消 token、循环进度、Abort/Continue 分支。
- 适合继续测试：取消、中断、错误继续或中止。
- 是否必须拆分：不急，先继续 mock-heavy 测试。

### src/board/mpremoteCommands.ts
- 现状：大活跃文件，覆盖率已有起色，但仍是整体阻碍之一。
- 阻碍：模块级全局状态、terminal 生命周期、Windows shell 分支、custom repl 控制文件。
- 适合继续测试：suspend/restore、handleTerminalClose、custom repl control、interrupt/reset fallback。
- 是否必须拆分：中期值得拆 terminal state machine 与 shell adapter。

### src/board/boardOperations.ts
- 现状：超大 0% 文件，且混有遗留主线。
- 阻碍：IO、UI、tree、decorations、board diff 全绑一起。
- 适合继续测试：优先 checkDiffs；legacy baseline sync 暂不建议先打。
- 是否必须拆分：强烈建议，至少先抽 comparison planner。

### src/board/esp32Fs.ts
- 现状：0%，但理论上非常适合 mock。
- 阻碍：VS Code TreeItem API 与 global decorations 隐式依赖。
- 适合继续测试：cache、merge、filter、sort、local-only、anchor item。
- 是否必须拆分：非必须，可先靠 mock 覆盖；长期可拆 tree model。

### src/ui/decorations.ts
- 现状：0%，高收益低风险。
- 阻碍很小。
- 适合继续测试：几乎整个文件。
- 是否必须拆分：不需要。

### src/python/pythonInterpreter.ts
- 现状：0%，高收益低风险。
- 阻碍：真实环境不可控，但决策树可 mock。
- 适合继续测试：解释器发现、缓存、校验、提示节流、terminal command 格式化。
- 是否必须拆分：建议中期拆 resolution / validation / notification。

## 6. 外部仿真与少改源码策略

### 可以优先依赖外部仿真的点
- VS Code API mock：commands、workspace、window、TreeView、status bar、EventEmitter
- terminal object mock：sendText、show、dispose、window.terminals
- child_process mock：exec、execFile
- 文件系统 mock：fs、fs.promises、path
- mpremote mock：上传、下载、列目录、路径映射
- Python 扩展 API mock：extensions.getExtension、activate、workspace 配置

### 典型仿真模式
- activate smoke + registerCommand callback 直打
- terminal lifecycle mock + fake timers
- onDidSaveTextDocument / onDidChangeConfiguration 事件回调直接调用
- withProgress 包装中的 callback 直接执行
- fake boardData + fake local manifest + fake decorations + fake tree 组合仿真

### 不建议强行仿真的点
- 真实 COM 口竞争与占用时序
- 真实 PowerShell/终端宿主编码行为
- Explorer 最终渲染表现
- 用户机器上的真实 Python 环境差异

## 7. 实施阶段

### 阶段 1：低风险高收益清零
- 新增 decorations 单测
- 新增 pythonInterpreter 单测
- 新增 esp32Fs 单测
- 目标：快速抬升 0% 文件，尽量不改生产代码

### 阶段 2：继续扩大运行时大文件覆盖
- 扩 boardMpremoteCommandsCoverage
- 覆盖 suspend/restore、handleTerminalClose、custom repl、fallback 链
- 目标：让 board 目录这个最大分母开始显著下降

### 阶段 3：补 branch 与错误路径
- 扩 extensionSmoke
- 扩 fileCommandsCoverage
- 扩 syncCommandsCoverage
- 目标：提升 branch coverage，不只是 statements

### 阶段 4：决定是否做结构性拆分
- 对 boardOperations 先做“继续仿真测试”还是“先抽 comparison planner”的决策
- 对 mpremoteCommands 是否抽 terminal state machine 做决策
- 对 esp32Fs 是否抽 tree model 做决策

## 8. 伪代码示意

### 终端状态机抽离示意
```ts
class TerminalSessionState {
  replOpen: boolean
  runOpen: boolean
  replWasOpenBeforeRun: boolean
  userClosedRepl: boolean

  onRunStart() {
    if (this.replOpen) {
      this.replWasOpenBeforeRun = true
      this.replOpen = false
    }
    this.runOpen = true
  }

  onRunClose() {
    this.runOpen = false
    if (this.replWasOpenBeforeRun) {
      this.replOpen = true
      this.replWasOpenBeforeRun = false
    }
  }

  onReplClose(userInitiated: boolean) {
    this.replOpen = false
    this.userClosedRepl = userInitiated
  }
}
```

### diff planner 抽离示意
```ts
type DiffPlan = {
  changed: string[]
  localOnly: string[]
  boardOnly: string[]
}

function buildDiffPlan(localManifest: Manifest, boardManifest: Manifest): DiffPlan {
  // 纯比较逻辑，不做 UI，不做 fs，不做 decorations
}
```

### tree model 抽离示意
```ts
function mergeBoardAndLocalEntries(boardEntries, localEntries, ignoreMatcher, decorations) {
  // 只做 merge/filter/sort/mark
  // 不创建 TreeItem
}
```

## 9. 注意事项

- 不要为了覆盖率去优先硬测遗留且未调用的 legacy sync 方法。
- 优先保证“真实主路径 + 高分母文件”的投入产出比。
- 继续维持少量高价值 smoke test，而不是把所有逻辑都拖成集成测试。
- 遇到模块级状态文件时，优先考虑 reset helper、terminal mock、fake timers，而不是先重构。
- 只有当 mock 成本开始明显高于逻辑复杂度时，才考虑拆分源码。
- 保持路径与串口归一化逻辑集中，避免重复字符串拼接再次制造 bug。

## 10. 推荐下一步

1. 新增 src/ui/decorations.ts 测试
2. 新增 src/python/pythonInterpreter.ts 测试
3. 新增 src/board/esp32Fs.ts 测试
4. 扩 tests/boardMpremoteCommandsCoverage.test.ts 的 suspend/restore/handleTerminalClose/custom repl 分支
5. 再决定是否对 src/board/boardOperations.ts 先做 planner 拆分还是继续仿真测试 checkDiffs
