# VScodeMicroPython Pylance 代码补全修复计划

- 项目: VScodeMicroPython
- 日期: 2026-05-21
- 版本: v1
- 状态: 仅分析与计划，未开始源码修复

## 1. 目标设定

### 主目标

恢复扩展的 MicroPython 代码补全能力，并避免启用后破坏 Pylance 对标准库与内置模块的正常提示。

### 子目标

1. 修复启用代码补全后提示异常的问题，特别是标准库模块提示缺失或异常退化的问题。
2. 恢复或补回安装匹配版本 pyi、安装指定版本 pyi 的能力。
3. 让源码实现与当前仓库中的 dist 运行逻辑重新一致，避免重新编译后把已存在的正确行为回退掉。
4. 为 Pylance 当前配置语义补充防御性处理，包括 pyright 配置覆盖、无效 stub 根路径、typeshed 根判定。
5. 同步修正文档与最基本的验证脚本，避免后续再次误判。

## 2. 现有参考

### 仓库内参考

1. 当前源码实现位于 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L102)，会直接写入 python.analysis.stubPath 和 python.analysis.extraPaths。
2. 当前源码的配置写入逻辑位于 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L452)，仅处理 stubPath 与 extraPaths，没有处理 typeshedPaths。
3. 当前源码的手动选择逻辑位于 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L731)，只允许从已安装 stub 中选择，缺失安装匹配版本与安装指定版本的入口。
4. 当前 dist 运行产物位于 [dist/completion/codeCompletion.js](dist/completion/codeCompletion.js#L317)，已存在基于 typeshedPaths、stubInspection、pyright 覆盖提示、安装指定版本等更完整的逻辑。
5. 当前 dist 还依赖 [dist/completion/stubSupport.js](dist/completion/stubSupport.js#L1)，但 src 下不存在对应的 TS 源文件，说明源码与产物已漂移。
6. 当前 stub 索引源码位于 [src/completion/stubIndex.ts](src/completion/stubIndex.ts#L1)，能力明显弱于 [dist/completion/stubIndex.js](dist/completion/stubIndex.js#L1)。
7. 仓库根下不存在 code_completion 目录，但源码仍会在 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L379) 回退到该目录。
8. [tests/test-code-completion.js](tests/test-code-completion.js#L13) 仍然假设 tests 下存在 code_completion 目录，验证脚本本身已经过时。
9. [.gitmodules](.gitmodules#L1) 仍残留 code_completion 子模块记录，但当前仓库未实际检出该目录。

### 官方语义参考

1. Pylance 官方文档说明 stubPath 用于“自定义包级 stub 根目录”，每个包应位于自己的子目录下。
2. Pylance 官方文档说明 typeshedPaths 用于“自定义 typeshed 树”，适用于标准库或 typeshed 回退 stub 的替换。
3. Pylance 官方文档明确说明 MicroPython 这类运行时如果要替换标准库类型来源，应考虑 typeshedPaths，但前提是提供完整的 typeshed 风格目录树。
4. Pyright 导入解析顺序中，stubPath 先于工作区与 extraPaths，typeshed 则在后续专门阶段参与标准库与第三方 fallback 解析。

## 3. 已验证问题与结论

### 结论 1: 这不只是 Pylance 更新导致的问题，源码本身已经回退

证据:

1. 当前 src 与 dist 在代码补全核心实现上存在明显能力差异。
2. dist 中已有更完整的 typeshedPaths 与安装入口逻辑，而 src 中缺失。
3. dist 的 source map 仍指向 src/completion/codeCompletion.ts，说明这份更完整逻辑曾经来自同一路径的 TS 源码。

### 结论 2: 当前源码会在缺少工作区 pyi 时写入一个可能无效的 stubPath

证据:

1. [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L192) 在找不到已安装 stub 时会回退到 getStubPath。
2. [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L379) 的 getStubPath 固定返回扩展目录下 code_completion/default 或 code_completion/zh-cn。
3. 当前仓库不存在 code_completion 目录，说明此回退路径在当前仓库上下文下是失效的。

### 结论 3: 当前源码没有正确表达 MicroPython 标准库替换场景

证据:

1. 官方语义中，stubPath 适合补单个包或局部 stub。
2. 官方语义中，typeshedPaths 才适合提供自定义标准库或 typeshed 风格树。
3. dist 中已新增 hasTypeshedRoot 判定与 analysis.typeshedPaths 处理，说明之前已经识别过这一问题。
4. 用户反馈“启用后连 time 提示都没了”，与“标准库类型来源被错误替换或未正确接入”高度吻合。

### 结论 4: 当前源码已经丢失安装其他版本 pyi 的用户入口

证据:

1. [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L731) 只支持 Use Installed 风格流程。
2. [dist/completion/codeCompletion.js](dist/completion/codeCompletion.js#L796) 已包含 Install Matching Version 与 Install Specific Version。
3. 用户当前看到“只有已安装版本，没有当前设备版本”的现象，和当前 src 行为一致。

### 结论 5: 当前语言服务重启流程存在重复重启，和 Pylance 超时报错高度相关

证据:

1. [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L553) 的 updatePythonConfiguration 在配置变化时已经会触发一次语言服务重启。
2. [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts#L834) 的 chooseStub 在调用 updatePythonConfiguration 之后又额外调用了一次 safeRestartLanguageServer。
3. 这会在 Pylance 尚未完成上一轮 stop 或 restart 请求时再次发起停止请求，和用户提供的“Stopping the server timed out”报错现象一致。

## 4. 修复范围设计

### 模块划分

1. stubSupport 模块
   - 新增 src/completion/stubSupport.ts。
   - 负责 stub 根探测、typeshed 根探测、推荐包名生成、pyright 配置覆盖探测。

2. stubIndex 模块
   - 扩展当前 [src/completion/stubIndex.ts](src/completion/stubIndex.ts) 的索引与匹配能力。
   - 支持更稳定的版本解析、端口匹配、板型匹配与目录探测。

3. CodeCompletionManager 模块
   - 改造 [src/completion/codeCompletion.ts](src/completion/codeCompletion.ts) 的启用、禁用、选择、安装、状态持久化逻辑。
   - 统一用 StubInspection 结构而不是裸字符串路径驱动配置更新。
   - 去重语言服务重启请求，避免同一流程内的重复 stop/restart。

4. 文档与验证
   - 更新 [README.md](README.md) 与 [README_zh-CN.md](README_zh-CN.md)。
   - 视情况修复或替换 [tests/test-code-completion.js](tests/test-code-completion.js) 中已经过时的假设。

## 5. 具体实现内容

### 5.1 新增 StubInspection 抽象

建议数据结构:

- root: 实际可用于 Pylance 的 stub 根目录
- hasTypeshedRoot: 是否包含完整 typeshed 根
- availableCoreModules: 当前根下可检测到的核心模块文件列表

用途:

1. 不再把任意字符串路径直接当成有效 stubPath。
2. 统一判断当前目录适合走 stubPath 还是需要额外设置 typeshedPaths。
3. 避免对不存在的 code_completion 目录或错误层级目录写配置。

### 5.2 配置更新逻辑重构

目标:

1. 保留对 python.analysis.stubPath 的支持，用于包级或根级自定义 stub。
2. 当检测到完整 typeshed 风格目录时，同时处理 python.analysis.typeshedPaths。
3. 禁用时仅清理由扩展写入的 stubPath、typeshedPaths、extraPaths，不破坏用户自定义配置。

核心伪代码:

1. 解析当前选中的 stub 根
2. 清理扩展历史遗留的全局配置
3. 更新工作区 extraPaths
4. 如果 stub 根有效:
   - 写入 analysis.stubPath = stubInfo.root
   - 如果 stubInfo.hasTypeshedRoot 为真:
     - 若用户未自定义 typeshedPaths，则写入 analysis.typeshedPaths = [stubInfo.root]
     - 否则提示用户当前 pyright/typeshed 配置优先
5. 如果 stub 根无效:
   - 不写入 stubPath
   - 不写入 typeshedPaths
   - 提示用户先安装或选择有效 stub
6. 若配置变化则重启语言服务

### 5.3 启用流程修复

目标:

1. 先查工作区安装目录下的 stub。
2. 若未找到，则根据设备 release、sysname、machine 生成推荐安装包。
3. 若仍未找到有效 stub，则尝试内置 bundled stub，但必须先通过 inspectStubRoot 验证存在且有效。
4. 若 bundled stub 不存在，则不再写入错误路径，而是引导用户安装或选择。

### 5.4 版本安装与选择流程修复

要补回的入口:

1. Use Installed
2. Install Matching Version
3. Install Specific Version
4. Refresh Index

其中:

1. Install Matching Version 使用设备版本生成推荐包规格。
2. Install Specific Version 支持输入单独版本号或完整 pip 包规格。
3. 版本不匹配时的 QuickPick 也应保留安装匹配版本与指定版本入口。

### 5.5 pyright 配置覆盖提示

如果工作区中存在 pyrightconfig.json 或 pyproject.toml 的 tool.pyright 段，应给出提示：

1. VS Code 的 python.analysis.* 可能被 pyright 配置覆盖。
2. 若补全未生效，需要同步在 pyright 配置中设置 stubPath 或 typeshedPath。

### 5.6 语言服务重启去重

目标:

1. 让 updatePythonConfiguration 成为唯一的配置变更后重启入口。
2. chooseStub、enableCodeCompletion 等上层流程不再重复追加 restart。
3. 如有必要，增加一个简单的重启串行化或节流保护，避免并发 restart 请求。

核心伪代码:

1. 上层流程调用 updatePythonConfiguration
2. updatePythonConfiguration 内部判断是否实际发生配置变化
3. 仅在确有变化时发起一次 restart
4. 上层流程不再显式再次 restart
5. 若 restart 正在进行中，则复用同一 promise 或直接跳过重复请求

### 5.7 文档同步

需要修正的文档问题:

1. README 仍把 enableCodeCompletion 说明成字符串枚举，但 package.json 实际是 boolean。
2. README 需要补充工作区 pyi 安装与版本选择说明。
3. README 需要说明 stubPath 与 typeshedPaths 的区别，以及 MicroPython 标准库替换的注意事项。

### 5.8 验证脚本同步

当前 [tests/test-code-completion.js](tests/test-code-completion.js#L13) 和 [tests/demo-code-completion.js](tests/demo-code-completion.js#L13) 仍依赖旧的 code_completion 目录结构，至少需要做到以下之一:

1. 改成对当前工作区安装目录与有效 stub 根探测逻辑做验证。
2. 或明确标记为旧脚本并从当前验证链中移除。

## 6. 验证方案

### 编码前验证

1. 已验证当前仓库不存在 code_completion 目录。
2. 已验证当前 src 缺失 dist 中已有的 typeshedPaths 与安装指定版本能力。
3. 已验证官方文档当前明确区分 stubPath 与 typeshedPaths 的职责。

### 改码后验证

1. 运行 npm compile，确认 TS 编译通过。
2. 检查 src 与 dist 产物行为一致。
3. 如可行，新增或修正一个最小验证脚本，验证:
   - 无有效 stub 时不会写入错误 stubPath
   - 有 typeshed 风格 stub 根时会正确处理 typeshedPaths
   - chooseStub 可以进入安装匹配版本与安装指定版本流程

## 7. 风险与注意事项

1. typeshedPaths 只使用第一个路径，不能把多个路径当作会自动合并。
2. 指向不完整 typeshed 根会导致 builtins 或标准库提示异常，这是本次最需要避免的回归点。
3. pyrightconfig.json 或 pyproject.toml 会覆盖 VS Code 中的 python.analysis.* 设置，必须提示用户。
4. 不能粗暴清空用户原有的 stubPath 或 typeshedPaths，只能清理扩展自己写入的路径。
5. 当前仓库缺少 code_completion 目录，若仍保留 bundled fallback，必须先判断目录有效再决定是否启用。
6. dist 中已有更完整逻辑，但不能直接依赖 dist，必须把同等逻辑恢复到 src，否则重新编译仍会回退。
7. restartLanguageServer 相关调用必须去重，否则在 Pylance 2026.2.1 上较容易触发 stop timeout。

## 8. 建议执行顺序

### 阶段一: 恢复源码能力

1. 新增 stubSupport.ts。
2. 升级 stubIndex.ts。
3. 重构 codeCompletion.ts 使用 StubInspection 与 typeshedPaths。

### 阶段二: 恢复交互与安装入口

1. 补回 chooseStub 的安装匹配版本与安装指定版本入口。
2. 补回版本不匹配时的安装分支。

### 阶段三: 同步文档与验证

1. 修正 README 与 README_zh-CN。
2. 修正或替换旧验证脚本。
3. 编译并做最小行为验证。

## 9. 当前建议

建议按上述范围修复 src，使其回到 dist 已证明过的方向，并在此基础上补上当前仓库缺失的源文件、文档和验证链。

在未获得用户确认前，不开始实际源码修改。