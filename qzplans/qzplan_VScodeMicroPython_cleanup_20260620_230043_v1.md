# VScodeMicroPython 仓库与废弃代码清理计划

## 1. 目标与边界

主要目标:

- 减少 VSIX 打包体积, 避免把测试、coverage、qzplans、release 产物、Python `.cover` 文件打进扩展包。
- 移除确定无引用、无运行价值的废弃代码文件和 placeholder 模块。
- 归档历史计划、草稿和内部调研文档, 保留可追溯性但不让它们进入发布包。
- 保持当前 hidden serial manager / mpyrepl 主链路可运行, 不引入功能行为变化。

非目标:

- 不在本轮重写 `src/board/mpremote.ts` 或 `src/board/mpremoteCommands.ts` 的大体架构。
- 不移除仍被运行路径使用的 `pyraw`, `raw_list_files.py`, `mpremote.ts`, `MpRemoteManager.ts`。
- 不删除用户本地工作区里的开发产物目录, 例如 `node_modules/`, `coverage/`, `release/`, 除非用户明确确认要做本地清理。
- 不做新的功能开发。

成功标准:

- `vsce package` 不再包含 `coverage/`, `qzplans/`, `tests/`, `release/`, `scripts/mpyrepl/*.cover`, `scripts/mpyrepl/_vendor/**/*.cover`。
- 删除的 TS/Python 文件没有任何 import/require/命令注册引用。
- `npm test -- --runInBand`, `npm run compile`, `E:\xm\github\.conda\python.exe scripts\mpyrepl\run_python_tests_with_coverage.py` 全部通过, Python 覆盖率仍 >= 80%。
- 文档不再链接已归档或删除的开发草稿。

## 2. 项目现状

相关目录和文件:

- `src/board/`: 当前仍有新旧传输代码混用。`serialManager*` 是 hidden Python manager 新路径; `mpremote.ts` 仍被文件树、路径映射、兼容工具函数使用。
- `scripts/mpyrepl/`: 当前自定义 REPL 与 manager 的 Python 实现。目录下存在已跟踪的 `.cover` 覆盖率生成物, 包括 vendor 下的大量 `.cover` 文件。
- `.vscodeignore`: 当前规则过宽, 只排除了 `src`, `.github`, `.vscode`, `node_modules`, 但没有排除 `coverage`, `tests`, `qzplans`, `release`, `.cover`。
- `docs/`: `custom-python-repl*.md`, `mpremote-windows-utf8.md`, `TEST_README.md` 是当前文档; `docs/llm.md`, `docs/repl_architecture_plan.md` 更像历史调研/旧方案。
- `qzplans/`: 多个历史计划文件仍在根目录, 当前还有本轮新增计划文件。适合建立 `qzplans/old/` 归档已完成/过期计划。

已确认高置信候选:

- `scripts/mpyrepl/*.cover` 和 `scripts/mpyrepl/_vendor/**/*.cover`: 覆盖率生成物, 已跟踪, 不应保留在源码和 VSIX 中。
- `src/board/monitor.ts`: 旧轮询串口监视器, 目前只有 `extension.ts` 中一行注释引用。
- `src/board/mpremoteOperations.ts`: placeholder exports, 无真实实现, 无 import 命中。
- `src/board/customReplControl.ts`: 旧 JSON 控制文件 RPC 模块, 当前 hidden manager 路径没有 import 命中。删除前仍需再跑一次全仓搜索。

需谨慎候选:

- `microPythonWorkBench.experimentalCustomRepl`: 当前代码里实际强制启用内置 mpyrepl, 设置 false 会被忽略。可以后续删除配置项和文档描述, 但这会影响用户已有设置和测试, 建议单独阶段做。
- `mpremoteCommands.ts` 内的 `buildShellCommand`, `buildLegacyShellCommand`, `useExperimentalCustomRepl` 及 legacy run 分支: 目前存在不可达或兼容残留, 但文件本身承担大量命令入口, 建议小步删除。
- `docs/repl_architecture_plan.md`: README 当前仍引用。若归档, 需同步 README 链接并保留当前架构文档替代。

## 3. 需求与疑问

已确认需求:

- 可以整理仓库和代码。
- 不需要的内容、废弃内容应移除。
- 当前项目是个人项目, 体验优先, 可以接受较大范围重构, 但仍需维护可读性和合理架构。

关键假设:

- 第一批清理以低风险为主: 打包规则、覆盖率生成物、无引用 placeholder/旧模块。
- 对 `experimentalCustomRepl` 配置项和 legacy run 分支的删除属于第二批, 需要确认后再实施。
- qzplan 历史文件可以归档到 `qzplans/old/`, 但不删除。

阻塞性问题:

- 是否允许删除已跟踪的 `scripts/mpyrepl/_vendor/**/*.cover` 文件? 建议允许。
- 是否允许把历史计划移动到 `qzplans/old/`? 建议允许, 不直接删除。
- 是否允许删除旧 `experimentalCustomRepl` 配置项? 建议第二阶段再做, 避免和当前 manager 重构混在一起。

## 4. 方案设计

分层清理:

1. 发布包清理:
   - 重写 `.vscodeignore`, 使 VSIX 只包含运行必需内容。
   - 明确保留 `dist/**`, `media/**`, `scripts/mpyrepl/**`, `README*.md`, `LICENSE*`, `package*.json`, `package.nls*.json`, 必要 docs。
   - 明确排除 `coverage/**`, `release/**`, `tests/**`, `qzplans/**`, `*.cover`, `scripts/bench_upload.py`, 可选开发脚本。

2. 生成物清理:
   - 删除已跟踪 `.cover` 文件。
   - 在 `.gitignore` 增加 `*.cover`, `release/`, 可选 `*.tsbuildinfo`。
   - 不删除本地忽略目录, 只在最终回复说明可选本地清理命令。

3. 无引用代码删除:
   - 删除 `src/board/monitor.ts`, 同步移除 `extension.ts` 中注释 import。
   - 删除 `src/board/mpremoteOperations.ts`。
   - 删除 `src/board/customReplControl.ts`, 但实施前再次搜索 import/require。
   - 跑 `npm run compile` 验证无引用残留。

4. 文档/计划归档:
   - 建立 `qzplans/old/`。
   - 将已完成或明显过期的旧 qzplan 移入 `qzplans/old/`。
   - `docs/llm.md` 建议移动到 `docs/archive/llm.md` 或直接排除发布包。第一批不删除。
   - `docs/repl_architecture_plan.md` 先从 VSIX 排除; 若移动, 同步 README 链接。

5. 第二阶段兼容配置清理:
   - 删除 `experimentalCustomRepl` 配置项和 nls 文案。
   - 删除 `mpremoteCommands.ts` 中总是 true 的 `useExperimentalCustomRepl()` 和 legacy branch。
   - 更新 README/docs/tests。

## 5. 文件级任务

第一阶段预计修改:

- `.vscodeignore`
  - 收紧发布包内容。
  - 排除测试、计划、coverage、release、本地生成物和 `.cover`。

- `.gitignore`
  - 增加 `*.cover`, `release/`, 可选 `*.tsbuildinfo`。

- `scripts/mpyrepl/*.cover`
  - 删除已跟踪覆盖率输出。

- `scripts/mpyrepl/_vendor/**/*.cover`
  - 删除已跟踪 vendor 覆盖率输出。

- `src/board/monitor.ts`
  - 删除旧轮询串口监视器。

- `src/core/extension.ts`
  - 删除 `monitor` 的注释 import。

- `src/board/mpremoteOperations.ts`
  - 删除 placeholder 模块。

- `src/board/customReplControl.ts`
  - 删除旧控制文件 RPC 模块。

- `README.md`, `README_zh-CN.md`
  - 如归档 `docs/repl_architecture_plan.md`, 同步相关链接。第一阶段可只调整发布包, 不改链接。

第二阶段候选修改:

- `package.json`
  - 删除 `microPythonWorkBench.experimentalCustomRepl` 配置项。

- `package.nls.json`, `package.nls.zh-cn.json`
  - 删除对应配置文案。

- `src/board/mpremoteCommands.ts`
  - 删除 `useExperimentalCustomRepl`, `buildShellCommand`, `buildLegacyShellCommand`, legacy run path。

- `tests/boardMpremoteCommandsCoverage.test.ts`
  - 删除对 `experimentalCustomRepl` 的 mock 分支, 更新运行路径断言。

- `README.md`, `README_zh-CN.md`, `docs/custom-python-repl*.md`, `docs/mpremote-windows-utf8.md`
  - 删除 “experimentalCustomRepl 默认开启/兼容性设置” 描述, 改为 “内置 mpyrepl 始终为主传输路径”。

不应修改:

- `src/board/mpremote.ts`: 仍被大量路径映射、文件树和兼容工具函数使用。
- `src/python/pyraw.ts`, `scripts/raw_list_files.py`: 仍被 `boardOperations`, `esp32Fs`, `extension` 使用。
- `scripts/mpyrepl/_vendor/**/*.py`: vendored 运行依赖, 不在本轮删除。
- `dist/`: 编译产物由 `npm run compile` 生成, 不手工编辑。

## 6. 分阶段执行

### 阶段 1: 低风险仓库清理

任务:

- 更新 `.vscodeignore` 和 `.gitignore`。
- 删除 `.cover` 生成物。
- 删除无引用废弃 TS 文件: `monitor.ts`, `mpremoteOperations.ts`, `customReplControl.ts`。
- 移除 `extension.ts` 中的旧注释 import。

验证:

- `rg -n "monitor|mpremoteOperations|customReplControl" src tests package.json`
- `npm run compile`
- `npm test -- --runInBand`
- `E:\xm\github\.conda\python.exe scripts\mpyrepl\run_python_tests_with_coverage.py`
- `git diff --check`

完成标准:

- 编译和测试通过。
- 搜索不到已删除模块引用。
- `.cover` 文件不再出现在 `git ls-files '*.cover'`。

### 阶段 2: 发布包内容验证

任务:

- 运行 `npx @vscode/vsce ls --tree` 或 `npm run package -- --no-yarn` 进行包内容检查。
- 若运行 `build.ps1`, 必须明确是否允许自动 bump 版本; 默认不运行。
- 根据 `vsce ls` 输出继续调整 `.vscodeignore`。

验证:

- VSIX 树中没有 `coverage/`, `qzplans/`, `tests/`, `.cover`, `release/`。
- `scripts/mpyrepl` 中保留运行必需 `.py`, `_vendor` 源文件和许可/元数据。

完成标准:

- 包体积显著下降。
- 发布包只包含运行和用户文档必需内容。

### 阶段 3: 历史计划归档

任务:

- 创建 `qzplans/old/`。
- 移动已完成/过期的 qzplan 到 `qzplans/old/`。
- 不再二次编辑已移动计划。

验证:

- README 不引用 `qzplans/old/` 内文件。
- `git status --short` 能清楚显示 move/rename。

完成标准:

- qzplans 根目录只保留当前仍有效计划。

### 阶段 4: 兼容配置和 legacy 分支清理

任务:

- 删除 `experimentalCustomRepl` 设置项和文档描述。
- 删除 `mpremoteCommands.ts` 中不可达 legacy REPL/run 分支。
- 更新 tests。

验证:

- `npm test -- --runInBand`
- `npm run compile`
- 手动检查命令面板和设置 UI 不再出现废弃配置。

完成标准:

- 内置 mpyrepl 主路径表述一致, 不再保留“可关闭但实际无效”的配置。

## 7. 验证计划

第一阶段必须运行:

```powershell
npm run compile
npm test -- --runInBand
& E:\xm\github\.conda\python.exe scripts\mpyrepl\run_python_tests_with_coverage.py
git diff --check
git ls-files '*.cover'
```

发布包验证建议运行:

```powershell
npx @vscode/vsce ls --tree
```

如果需要实际打包:

```powershell
npm run package
```

不默认运行:

```powershell
.\build.ps1
```

原因: `build.ps1` 会运行测试、自动增加版本号并打包, 容易把清理变更和版本 bump 混在一起。

## 8. 风险与注意事项

- 当前工作区已有大量未提交和未跟踪的 manager 重构文件。实施前不要使用 `git reset`, `git checkout --`, 或任何会覆盖用户变更的命令。
- 删除 `.cover` 文件会改变已跟踪文件集合, 但它们是生成物, 应该通过 `.gitignore` 防止再次出现。
- `.vscodeignore` 过度收紧可能漏打运行时依赖。必须用 `vsce ls --tree` 检查 `dist`, `media`, `scripts/mpyrepl`, `package.nls*.json`, `README*.md`, `LICENSE` 是否仍在包内。
- `src/board/mpremote.ts` 虽然名字旧, 但仍是大量运行路径依赖的核心兼容层, 本轮不要删除。
- `experimentalCustomRepl` 删除会影响用户设置 UI 和文档, 应作为第二阶段单独提交。
- qzplan 归档后按项目规则不应再编辑归档文件。

## 9. 建议执行边界

建议先执行阶段 1 和阶段 2。阶段 3 归档计划文件可以同时做, 但属于仓库组织调整。阶段 4 涉及配置兼容和较多测试更新, 建议等第一批清理稳定后再做。

当前仅完成计划, 尚未开始编码或删除文件, 需用户确认后再实施。
