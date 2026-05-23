# VScodeMicroPython 代码补全配置层小重构计划

- 项目: VScodeMicroPython
- 日期: 2026-05-23
- 版本: v1
- 状态: 仅计划，待确认后实施

## 1. 目标设定

### 主目标

把代码补全中的 Python 与 Pylance 配置写入逻辑从 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L391) 中抽离出来，降低单文件职责耦合，提高可维护性与可测试性。

### 子目标

1. 让 CodeCompletionManager 只保留编排职责，不再直接承载大段配置清理与写入逻辑。
2. 把 stubPath、typeshedPaths、extraPaths、diagnosticSeverityOverrides 的写入与恢复收敛到单独模块。
3. 为抽出的配置层补充更可控的单元测试入口，减少对 manager 级别大范围 mock 的依赖。
4. 保持现有行为不回退，尤其是 overlay stub 根、typeshedPaths 处理、reportMissingModuleSource 托管恢复、旧路径清理逻辑。

## 2. 现有参考

1. 当前配置写入主逻辑集中在 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L391)。
2. 诊断项 reportMissingModuleSource 的托管逻辑位于 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L561)、[src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L581)、[src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L615)。
3. 当前 manager 在多个入口调用配置写入，包括 extraPaths 变更回调 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L84)、启用流程 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L185)、手动 chooseStub [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L1046)。
4. overlay 文件合成逻辑已经抽到 [src/completion/stubOverlay.ts](src/completion/stubOverlay.ts#L23)，说明“把纯逻辑从 manager 中剥离”是可行方向。
5. 现有 Jest 测试更适合覆盖纯函数或轻依赖模块，参考 [tests/stubOverlay.test.ts](tests/stubOverlay.test.ts#L12)、[tests/stubSupport.test.ts](tests/stubSupport.test.ts#L12)。

## 3. 需求分析

### 已明确需求

1. 这一步只做小重构，不做大规模重写。
2. 目标是提升可维护性，而不是改变用户可见行为。
3. 改完必须继续保持编译通过，并通过现有 Jest 测试。

### 本步不处理的内容

1. 不在本步抽离 chooseStub 的安装与选择逻辑。
2. 不在本步抽离状态栏展示逻辑。
3. 不在本步改变现有配置 schema 或用户文档语义。

## 4. 架构设计

### 目标模块划分

保留:

1. CodeCompletionManager
   - 负责事件监听、命令入口、流程编排、状态栏刷新触发。

新增:

1. completionPythonConfig.ts
   - 负责 Python/Pylance 配置写入与旧配置清理。
   - 负责 reportMissingModuleSource 托管状态的保存与恢复。
   - 负责返回配置变更结果，供 manager 决定是否提示用户手动刷新语言服务。

### 模块关系

1. CodeCompletionManager 组装调用参数。
2. completionPythonConfig 接收 workspaceState、stub 信息、路径上下文与配置对象。
3. completionPythonConfig 返回应用结果，例如:
   - effectiveTypeshedPath
   - settingsChanged
   - diagnosticChanged
4. CodeCompletionManager 仅负责持久化 manager 自己的状态，并展示用户提示。

## 5. 具体实现内容

### 5.1 新增配置应用上下文对象

不要继续用分散字符串和局部闭包在 manager 内拼接参数，而是定义一个明确的配置上下文对象，例如:

- workspaceRoot
- workspaceInstallRoot
- lastStubPath
- lastTypeshedPath
- oldExtensionPaths
- userExtraPaths
- stubInfo

这样后续继续拆 chooseStub 或状态栏时，不会继续把更多隐式状态埋回 manager。

### 5.2 抽离配置写入主函数

计划把 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L391) 中的大部分逻辑迁移到一个独立函数，例如:

- applyPythonCompletionConfiguration

它负责:

1. 清理 Global 级遗留配置。
2. 清理 Workspace 级旧 extraPaths 与 autoComplete.extraPaths。
3. 写入或移除 analysis.stubPath。
4. 根据 hasTypeshedRoot 写入或恢复 analysis.typeshedPaths。
5. 根据 stub 是否启用，设置或恢复 reportMissingModuleSource。
6. 返回变更摘要。

### 5.3 抽离 diagnostic override 状态机

把以下函数迁移到配置模块内部:

1. getDiagnosticSeverityOverrides
2. clearManagedMissingModuleSourceState
3. ensureMissingModuleSourceSuppression
4. restoreManagedMissingModuleSourceOverride

这些逻辑和 manager 的主流程编排无关，但和配置层强相关，应该与配置写入保持同一边界。

### 5.4 保持 manager 侧最小改动

manager 侧只保留:

1. 组装调用上下文。
2. 调用配置模块。
3. 接收返回的 lastTypeshedPath 或 changed 标记。
4. 在确实有配置变化时显示状态栏提示。

### 5.5 核心伪代码

```text
manager.updatePythonConfiguration(stubInfo):
  context = buildConfigContext(...)
  result = applyPythonCompletionConfiguration(context)
  this.lastTypeshedPath = result.appliedTypeshedPath
  persist result.appliedTypeshedPath
  if result.settingsChanged:
    show status bar hint
```

```text
applyPythonCompletionConfiguration(context):
  cleanupGlobalLegacyPaths(context)
  cleanupWorkspaceLegacyPaths(context)
  updateStubPath(context)
  updateTypeshedPaths(context)
  updateMissingModuleSourceOverride(context)
  return summary
```

## 6. 注意事项

1. 这一步不要顺手改 chooseStub、状态栏或 stub 选择流程，否则验证面会扩大。
2. 需要保留当前 overlay stub 根策略，不能退回到 extraPaths 直写方式。
3. 要特别注意 workspaceState 读写的归属，避免把 manager 的状态和配置模块的状态再次混用。
4. 由于 tests/setup.ts 对核心模块有全局 mock，新测试若走文件系统或真实 path 逻辑，可能仍需局部 unmock。
5. 当前无外部引用的 restart 遗留方法不在本步处理，避免把“删除死代码”和“抽离配置层”混成一个提交面。

## 7. 分阶段实施任务

### 阶段 1

1. 新增 completionPythonConfig 模块与必要类型。
2. 迁移 updatePythonConfiguration 的配置写入主体逻辑。
3. 迁移 diagnostic override 相关函数。

### 阶段 2

1. 简化 CodeCompletionManager 中的 updatePythonConfiguration。
2. 调整 lastTypeshedPath 的回写与持久化位置。
3. 保持 enable、chooseStub、extraPaths 变更入口行为不变。

### 阶段 3

1. 为新模块补最小单测。
2. 运行 npm run compile。
3. 运行 npm test -- --runInBand。

## 8. 预期结果

1. [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts) 明显缩短，编排职责更清楚。
2. 配置写入逻辑拥有独立边界，后续继续拆 stub 流程时更稳。
3. 后续若继续做第二步重构，可以直接围绕 manager 与配置模块的接口演进，而不必再回到超长函数中做拼装。