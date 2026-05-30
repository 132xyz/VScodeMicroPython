# VScodeMicroPython 当前打开文件同步功能实施计划 (v1)

- 创建时间: 2026-05-30
- 目标仓库: E:\xm\github\github\VScodeMicroPython
- 当前状态: 已完成现状分析，待用户确认后再开始编码
- 推荐方向: 在不破坏现有树节点单文件同步的前提下，新增一条“当前活动编辑器文件 Local → Board”命令，并抽出共享上传 helper，避免继续复制自动同步逻辑

---

## 1. 目标设定

### 1.1 主目标

在扩展的“同步文件”功能中新增“只同步当前已经打开并处于活动状态的文件”这一能力，让用户不必执行“同步全部文件”或“差异同步”，可以直接把当前编辑器中的本地文件上传到开发板。

### 1.2 子目标

- 在 Sync Files 视图中新增一个明确的动作入口，和现有“上传全部”“差异同步”并列。
- 命令行为和现有自动保存上传保持一致：
  - 只允许同步位于 sync local root 内的文件。
  - 遵守 .mpyignore 忽略规则。
  - 复用 rootPath 到设备路径的映射规则。
  - 复用串口自动挂起/恢复逻辑，避免 REPL 或 Run 占用串口时同步失败。
- 保持现有树视图右键单文件同步能力不退化。
- 支持从命令面板触发该能力，而不要求必须在文件树上选中节点。

### 1.3 验收标准

- 当活动编辑器是 sync local root 内的文件时，执行该命令会先保存，再上传到开发板对应路径。
- 当活动编辑器不在 sync local root 内、无活动编辑器、文件未落盘、或文件被 .mpyignore 忽略时，会给出清晰反馈，不进行危险操作。
- 当 REPL/Run 正在占用串口时，同步仍能通过自动挂起恢复机制成功执行。
- Sync Files 视图中能看到新的“当前文件同步”入口。

### 1.4 非目标

- 本期不做“同步所有已打开 tab”。
- 本期不做“当前活动文件 Board → Local”对向入口，除非你后续明确要求。
- 本期不做新的网络能力、遥测或额外后台进程。

---

## 2. 现有参考与工作原理 (已在仓库中核实)

### 2.1 Sync Files 视图目前只有批量动作，没有“当前文件”动作

src/sync/syncView.ts 当前只返回以下节点：

- AutoSync 开关
- Upload all files
- Download all files
- Check for differences
- Sync changed Files Local → Board
- Sync changed Files Board → Local
- Delete ALL files on Board

也就是说，当前截图里的菜单能力就是由这里硬编码出来的，缺失“当前文件同步”首先是视图层没有入口。

### 2.2 命令注册层已经有“单文件同步”概念，但它面向文件树节点

src/core/extension.ts 当前已经注册：

- microPythonWorkBench.syncFileLocalToBoard
- microPythonWorkBench.syncFileBoardToLocal

但它们用于文件树右键菜单，不是面向活动编辑器。

### 2.3 现有单文件同步实现只接受 Esp32Node，不适合直接拿来做活动文件同步

src/commands/fileCommands.ts 里的 syncFileLocalToBoard 现状：

- 输入参数固定是 Esp32Node。
- 它先从板端路径反推本地相对路径，再从本地上传回板子。
- 这条链路天然要求“先在设备文件树里选中一个节点”。

所以现在缺的不是“有没有上传能力”，而是“有没有一条以活动编辑器文档为输入的同步链路”。

### 2.4 fileCommands.ts 里的 withAutoSuspend 仍是占位实现

src/commands/fileCommands.ts 里目前存在：

- withAutoSuspend<T>(fn) { return fn(); }

这意味着 fileCommands 这条路径并没有真正复用 extension.ts 和 syncCommands.ts 里那套串口自动挂起/恢复逻辑。

这也是为什么不能只在现有 syncFileLocalToBoard 外面简单套一层 UI。若直接复用现有 fileCommands 路径，会把一个新的用户入口挂在一条“没有真正 auto-suspend”的实现上，后续很容易在 REPL 打开时出错。

### 2.5 自动保存上传逻辑已经有一条更权威的实现，可作为“当前文件同步”的真实参考

src/core/extension.ts 的 onDidSaveTextDocument 监听当前已经做了这些事：

- 根据文档所属 workspace 判断是否可同步。
- 解析 syncLocalRoot。
- 拒绝 workspace root 外的路径。
- 读取 .mpyignore 并判断是否忽略。
- 根据 rootPath 计算设备目标路径。
- 根据 replRestoreBehavior 计算恢复命令。
- 使用真正的 withAutoSuspend 包装 mp.cpToDevice。

这条逻辑和“当前打开文件同步”的目标行为高度一致，是当前仓库里最接近真实需求的参考实现。

### 2.6 Actions 视图里已经出现了半成品痕迹

src/core/actions.ts 里已经有 syncCurrent 图标分支，但 getActionNodes 并没有把这个节点真正 push 进去。

这说明产品形态上，仓库此前已经接近考虑过“当前文件同步”，只是没有完成命令和 UI 的闭环。

### 2.7 当前测试覆盖里没有这一块的现成保护

tests 目录下没有针对 SyncTree、当前文件同步命令、或 fileCommands 活动文件路径解析的现成测试。

结论：这次新增功能时，至少需要补一个轻量测试面，否则后续很容易因为命令参数形态或视图节点顺序变化再次回归。

---

## 3. 需求分析

### 3.1 我对“已打开文件”的默认解释

推荐默认语义为：

- 只处理当前活动编辑器对应的文档。
- 不处理所有已打开 tab。
- 只做 Local → Board。

原因：

- VS Code 中“当前打开文件”最稳定的技术定义就是 vscode.window.activeTextEditor。
- 多 tab 批量同步会与“差异同步”“全量同步”边界重叠，复杂度明显上升。

### 3.2 建议默认行为

- 若文档有未保存修改，先自动保存，再上传。
- 若文件不在 syncLocalRoot 内，提示并拒绝上传。
- 若文件命中 .mpyignore，明确提示“该文件被忽略，未上传”。
- 若当前没有活动编辑器，提示无活动编辑器。
- 若当前文档是 untitled 或非 file scheme，提示无法同步。

### 3.3 待你确认的产品细节

虽然技术方案已经能收敛，但开始编码前仍建议确认以下 3 个细节：

1. “当前文件”是否就按活动编辑器定义，而不是所有打开 tab。
2. 该功能是否只做 Local → Board，不在本期同时增加 Board → Local。
3. 该入口是否只放在 Sync Files 视图，还是顺手也放到 Actions 视图里。

若你不特别指定，我建议采用：

- 活动编辑器
- 仅 Local → Board
- 先只放 Sync Files 视图和命令面板

---

## 4. 架构设计

## 4.1 控制路径判断

当前行为缺口并不在 mpremote 上传能力，而在“输入模型”和“接线位置”：

- 文件树右键同步的输入模型是 Esp32Node。
- 当前文件同步的输入模型应该是 TextDocument / activeTextEditor。
- Sync Files 视图只展示了批量动作，没有展示当前文件动作。

因此这次实现应当新增一条“活动编辑器 → 解析同步目标 → auto-suspend 上传”的命令链路，而不是硬把批量同步逻辑改造为支持单文件。

## 4.2 方案对比

### 方案 A: 直接复用现有命令 ID，令 syncFileLocalToBoard 同时支持 node 和 active editor

优点：

- 代码改动最少。
- 不需要新增命令标题和本地化 key。
- Sync Files 视图可以直接调用已有命令。

缺点：

- 现有命令语义会从“树节点命令”变成“上下文敏感命令”，行为更隐式。
- 命令面板里仍只显示“Sync File Local → Board”，用户未必知道这是“同步活动文件”。
- 容易让后续维护者误判此命令的调用前提。

### 方案 B: 新增专门命令 syncActiveFileLocalToBoard，并抽出共享 helper

优点：

- 语义清晰，命令名和入口都明确针对“当前活动文件”。
- 不破坏现有树节点右键命令的调用方式。
- 后续如果你要把这个能力放进 Actions 视图或编辑器标题栏，也更自然。

缺点：

- 需要多加一个命令注册和本地化条目。

### 4.3 推荐方案

推荐采用方案 B。

理由：

- 这是新增产品能力，不是原树节点命令的自然扩展。
- 命令语义清晰比省一个命令 ID 更重要。
- 当前仓库已经存在同步逻辑分散的问题，再让已有命令变成“双模式”只会继续增加隐性复杂度。

## 4.4 推荐目录和模块改动

建议涉及以下文件：

- src/commands/fileCommands.ts
- src/core/extension.ts
- src/sync/syncView.ts
- package.json
- package.nls.json
- package.nls.zh-cn.json
- tests 下新增或补充一个轻量测试文件

如需做得更稳妥，建议额外新增一个共享 helper 模块，例如：

- src/sync/activeFileSync.ts

这个 helper 模块负责：

- 校验活动文档是否可同步。
- 解析 local path、relative path、device path。
- 统一处理 ignore 检查。
- 统一处理 auto-suspend 和 REPL 恢复参数。

这样 extension.ts 的自动保存上传和新的“当前文件同步”命令都能走同一套核心逻辑，而不是继续复制判断代码。

---

## 5. 具体内容设计

## 5.1 核心数据模型

不建议直接用裸对象在多个函数之间传散乱字段，建议定义一个小类型：

```ts
type ActiveFileSyncTarget = {
  workspacePath: string;
  localRootDir: string;
  localPath: string;
  relativePath: string;
  devicePath: string;
  replBehavior: "runChanged" | "executeBootMain" | "openReplEmpty" | "none";
  resumeReplCommand?: string;
};
```

这样做的原因：

- 当前这条链路需要跨多个步骤传递多个字段。
- 用结构化类型更容易加提示和复用，不会退化成字符串 key 字典。

## 5.2 关键 helper 设计

### resolveActiveFileSyncTarget(document)

职责：

- 检查文档是否存在、是否为 file scheme、是否属于 workspace。
- 解析 syncLocalRoot。
- 计算 relativePath。
- 校验 relativePath 没有越界到 syncLocalRoot 之外。
- 检查 .mpyignore。
- 计算 devicePath。
- 生成 REPL 恢复信息。

伪代码：

```ts
async function resolveActiveFileSyncTarget(document: vscode.TextDocument): Promise<ActiveFileSyncTarget> {
  if (document.isUntitled || document.uri.scheme !== "file") {
    throw new Error("Active document is not a saved file");
  }

  const ws = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!ws) {
    throw new Error("Active document is outside any workspace folder");
  }

  const localRootDir = getLocalSyncRoot();
  const relativePath = path.relative(localRootDir, document.uri.fsPath).replace(/\\/g, "/");
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Active document is outside the configured sync local root");
  }

  const matcher = await createIgnoreMatcher(ws.uri.fsPath);
  if (matcher(relativePath, false)) {
    throw new Error("IGNORED_FILE");
  }

  const rootPath = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.rootPath", "/");
  const devicePath = toDevicePath(relativePath, rootPath);
  const replBehavior = normalizeReplBehavior(...);
  const resumeReplCommand = buildResumeCommand(devicePath, replBehavior);

  return { ... };
}
```

### uploadSyncTarget(target)

职责：

- 真正执行 mp.cpToDevice。
- 用真正的 auto-suspend 包装。
- 在成功后给出用户提示。
- 如有需要，触发文件树刷新或最小 cache 更新。

伪代码：

```ts
async function uploadSyncTarget(target: ActiveFileSyncTarget): Promise<void> {
  await withAutoSuspend(
    () => mp.cpToDevice(target.localPath, target.devicePath),
    {
      resumeReplCommand: target.resumeReplCommand,
      replBehavior: target.replBehavior
    }
  );
}
```

## 5.3 新命令设计

建议新增命令：

- microPythonWorkBench.syncActiveFileLocalToBoard

命令行为：

1. 读取 vscode.window.activeTextEditor。
2. 若存在脏文档，先保存。
3. 调用 resolveActiveFileSyncTarget。
4. 调用 uploadSyncTarget。
5. 给出成功/失败消息。

伪代码：

```ts
async function syncActiveFileLocalToBoard(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    Localization.showError("messages.noActiveEditor");
    return;
  }

  await editor.document.save();

  try {
    const target = await resolveActiveFileSyncTarget(editor.document);
    await uploadSyncTarget(target);
    vscode.window.showInformationMessage(`Synced active file local → board: ${target.relativePath}`);
  } catch (error) {
    handleActiveFileSyncError(error);
  }
}
```

## 5.4 UI 接线设计

### Sync Files 视图

在 src/sync/syncView.ts 增加一个节点，推荐放在“Upload all files”之后、“Check for differences”之前，顺序如下：

1. AutoSync
2. Upload all files
3. Upload active file
4. Download all files
5. Check for differences
6. Sync changed Files Local → Board
7. Sync changed Files Board → Local
8. Delete ALL files on Board

这样做的原因：

- “当前文件上传”在语义上更接近“上传全部文件”的窄化版本。
- 放在 Download all files 前面，能保持 Local → Board 的操作靠前聚合。

### Command Palette

只要在 package.json 里注册命令，默认就可以从命令面板触发。

### Actions 视图

本期建议先不放进去，保持最小可复审改动。

原因：

- 你的明确需求来自 Sync Files 视图。
- Actions 视图目前主打运行和 REPL 操作。
- 虽然存在 syncCurrent 半成品痕迹，但一次把两个视图一起改会扩大验证范围。

后续如果你确认想统一入口，再把该命令加进 src/core/actions.ts 即可。

## 5.5 本地化与消息

建议新增或补充以下文案：

- commands.syncActiveFileLocalToBoard.title
- messages.activeFileSyncOutsideRoot
- messages.activeFileSyncIgnored
- messages.activeFileSyncUntitled
- messages.activeFileSyncSuccess

也可以少加几条 key，直接复用现有 messages.noActiveEditor、messages.selectSpecificPort 等通用提示。

---

## 6. 关键技术取舍

## 6.1 为什么不能直接把 SyncTree 节点指向现有 syncFileLocalToBoard

因为现有实现默认参数是 Esp32Node；从 Sync Files 视图触发时没有这个节点参数。

如果直接接线，要么运行时报错，要么需要把一个本来树节点专用的命令改成上下文敏感命令。前者不可用，后者可做但语义更差。

## 6.2 为什么推荐抽 helper，而不是直接复制 extension.ts 的自动保存上传代码

因为当前仓库的同步逻辑已经分散在：

- src/core/extension.ts
- src/commands/syncCommands.ts
- src/commands/fileCommands.ts

如果这次再复制一次活动文件上传逻辑，后面会出现：

- 自动保存上传一套路径判断
- 树节点单文件上传一套路径判断
- 当前文件上传再来一套路径判断

届时 rootPath、ignore、REPL 恢复、状态提示很容易再次漂移。

## 6.3 为什么 fileCommands.ts 里的 withAutoSuspend 必须处理

它现在是占位实现，这意味着只要新增功能仍然落在 fileCommands 当前路径上，就有概率在 REPL 打开时和串口占用产生冲突。

因此本次实现至少要做到以下二选一：

1. 把真正的 auto-suspend helper 下沉成共享函数给 fileCommands 用。
2. 新命令完全绕开 fileCommands 当前占位路径，直接走共享 helper。

推荐第 2 种，并顺手给 fileCommands 后续复用这个 helper，逐步收口实现。

---

## 7. 具体实施步骤

### Phase 1: 抽共享同步 helper

- 新增 src/sync/activeFileSync.ts。
- 放入 ActiveFileSyncTarget 类型、resolve helper、upload helper。
- 复用 createIgnoreMatcher、getLocalSyncRoot、mp.cpToDevice、suspendSerialSessionsForAutoSync、restoreSerialSessionsFromSnapshot。

### Phase 2: 新增当前活动文件命令

- 在 src/core/extension.ts 注册 microPythonWorkBench.syncActiveFileLocalToBoard。
- 命令实现读取活动编辑器并调用共享 helper。
- 保证 dirty 文件先保存。

### Phase 3: UI 接线

- 在 src/sync/syncView.ts 增加“Upload active file (Local → Board)”节点。
- 在 package.json 注册命令和本地化 title。
- 如有必要，为消息文案增加 nls 条目。

### Phase 4: 补强旧路径

- 视改动量决定是否让 fileCommands.syncFileLocalToBoard 也复用新的 upload helper。
- 目标是避免 tree-node 单文件同步和活动文件同步分裂成两套完全不同的上传实现。

### Phase 5: 验证

- 跑 npm compile。
- 验证 Sync Files 视图是否出现新节点。
- 手工验证 5 类场景：
  - 活动文件位于 sync root 内，上传成功。
  - 活动文件有未保存修改，先保存再上传。
  - 活动文件位于 sync root 外，拒绝上传。
  - 活动文件命中 .mpyignore，提示跳过。
  - REPL 打开时上传，自动挂起与恢复正常。

---

## 8. 测试设计

### 8.1 推荐最小自动化测试

建议新增一个轻量测试文件，优先测试“纯解析逻辑”，避免把大量 VS Code UI mock 塞进单测：

- relative path 解析是否拒绝 sync root 外路径
- device path 映射是否符合 rootPath 规则
- ignored 文件是否被正确标记为不可同步

若这次为了控制改动面不抽纯函数，也至少补一个 SyncTree 节点顺序测试，保证新动作不会被后续改动删掉。

### 8.2 手工验证清单

- 选择一个 syncLocalRoot 内的 Python 文件，执行当前文件同步，确认板端路径正确。
- 开着 REPL 时执行同步，确认不会出现串口占用失败。
- 在 untitled 文档上执行，确认提示明确。
- 在 package.json 或 README.md 这类 sync root 外文件上执行，确认不会误传到板子。

---

## 9. 风险与注意事项

- 当前仓库里 fileCommands 的 withAutoSuspend 是空实现，若不收口 helper，这个问题未来还会继续扩散。
- extension.ts 里的自动保存上传逻辑目前写在激活文件内部局部函数里，若直接复用需要适当下沉，否则新命令只能继续复制代码。
- 如果后续你想把“当前文件同步”也放入 Actions 视图，需要额外决定它和 Run Active File 的排序关系。
- 多工作区场景下，应优先基于活动文档所属 workspace 判断，而不是无条件使用 workspaceFolders[0]。这点建议在实现时顺手修正到新 helper 上。

---

## 10. 结论与建议

### 10.1 结论

这个功能实现难度不高，真正要避免的是“为了快而把新入口接到现有占位实现上”。

当前最稳妥的实现路径是：

- 新增专门命令 syncActiveFileLocalToBoard
- 以活动编辑器为输入模型
- 抽共享 helper 复用自动上传那条已验证逻辑
- 只在 Sync Files 视图与命令面板先落地

### 10.2 建议的默认决策

若你不再额外指定，我建议按以下默认值编码：

1. 当前文件 = 活动编辑器文件
2. 方向仅 Local → Board
3. 入口先放 Sync Files 视图和命令面板
4. dirty 文件先保存后上传
5. 忽略文件和 root 外文件给出显式提示

### 10.3 待确认后执行的文件改动清单

- src/sync/activeFileSync.ts
- src/core/extension.ts
- src/sync/syncView.ts
- src/commands/fileCommands.ts
- package.json
- package.nls.json
- package.nls.zh-cn.json
- tests/ 下新增或补充一个轻量测试文件

当前文档仅为实施计划，不包含业务代码变更。等待你确认后，再开始实际编码。