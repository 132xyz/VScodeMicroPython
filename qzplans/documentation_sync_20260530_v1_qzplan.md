# VScodeMicroPython 文档同步实施计划 v1

## 1. 目标设定

### 主要目标

- 基于当前仓库真实代码能力、当前 CI/测试脚本、当前跨平台行为，完整更新英文与中文主文档。
- 让 README.md 与 README_zh-CN.md 对功能、配置、测试、CI、限制、运行方式的描述与当前实现一致。
- 补充/修正文档中已经过时或容易误导的内容，尤其是测试体系、REPL 行为、代码补全、同步逻辑与跨平台说明。

### 子目标

- 更新英文主文档 README.md。
- 更新中文主文档 README_zh-CN.md。
- 更新 docs/TEST_README.md，使其反映当前 Jest + Python REPL 测试体系与当前命令。
- 视差异情况决定是否同步更新 docs/mpremote-windows-utf8.md、docs/llm.md 中与现状明显不一致的片段。

## 2. 现有参考

### 已确认的真实实现依据

- package.json
  - 当前版本 0.3.78。
  - 当前测试命令：
    - npm run test:js:coverage
    - npm run test:py
    - npm run test:coverage
- 当前 CI workflow
  - .github/workflows/ci.yml
  - 当前矩阵：ubuntu-latest / windows-latest / macos-latest
  - 当前 Node 版本：24、22
  - 当前 Python 版本：3.11
  - 已升级 actions/checkout@v6、actions/setup-node@v6、actions/setup-python@v6
- 当前代码能力
  - 设备文件树、双向同步、差异检测、自动保存同步、代码补全、REPL/Run terminal、auto-suspend/restore、Python helper REPL 子系统。
- 当前验证结论
  - JS 全量测试通过，20 suites / 74 tests，JS coverage 42.65%。
  - Python 全量测试通过，53 tests，Python coverage 81.0%。
  - 已修复的近期跨平台问题：
    - Jest 预期 console 噪音
    - macOS runActiveFile 平台特定断言
    - Python 未闭合字符串解析差异
    - Windows cp1252 stdout Unicode 输出崩溃

### 现有文档问题

- README.md / README_zh-CN.md 中仍保留“覆盖不足”“测试建议”等旧表述，但未准确体现当前测试结构和运行命令。
- docs/TEST_README.md 偏旧，仍主要按早期测试基础设施描述，缺少当前 coverage 命令、Python REPL 测试子系统和当前重点覆盖模块。
- 中英文 README 的章节顺序和内容粒度不完全对齐，未来维护成本高。

## 3. 需求分析

### 已明确需求

- “根据实际代码完整更新中英文文档”。
- 文档应基于当前代码现状，不应继续沿用过时描述。
- 中英文内容要尽量同步，不是只改一侧。

### 仍需执行时确认的小范围选择

- 是否只更新主文档与测试文档：README.md、README_zh-CN.md、docs/TEST_README.md。
- 是否顺带更新更专题的 docs 文件：例如 docs/mpremote-windows-utf8.md。

## 4. 架构设计

### 文档分层设计

#### 层 1：README.md / README_zh-CN.md

- 面向用户和贡献者。
- 负责描述：
  - 核心功能
  - 快速开始
  - 关键配置
  - REPL / Run / Sync / Code Completion 行为
  - 测试与 CI 入口
  - 已知限制与当前验证范围

#### 层 2：docs/TEST_README.md

- 面向开发者与维护者。
- 负责描述：
  - JS 与 Python 两套测试体系
  - 当前命令入口
  - 覆盖率口径
  - 常见 mock 方式
  - 当前优先覆盖模块与后续建议

#### 层 3：专题文档（按需）

- docs/mpremote-windows-utf8.md
- docs/llm.md
- 仅在发现内容与现状明显冲突时同步修正。

## 5. 具体内容

### README 系列拟更新模块

1. 项目简介
   - 统一描述扩展定位：MicroPython 文件管理、同步、REPL、运行、代码补全。

2. 快速开始
   - 当前安装、编译、打包、依赖安装方式。

3. 功能说明
   - Files view / Sync / Run / REPL / Code Completion / Auto-suspend。

4. 配置说明
   - 精炼列出高频配置，不重复 package.json 全量配置。

5. 测试与 CI
   - 明确 JS / Python 命令与 CI 运行平台。
   - 避免写死会很快过期的细粒度统计数字，除非明确标注为“当前状态”。

6. 已知限制
   - 只保留仍然成立的限制，如板卡验证范围、部分低覆盖高风险区域。

### TEST_README 拟更新模块

1. 当前测试基础设施
2. JS 测试覆盖的关键文件与模式
3. Python REPL 子系统测试覆盖范围
4. 当前命令入口与 coverage 命令
5. 当前维护建议与新增测试原则

### 核心执行逻辑（伪代码）

```text
collect_current_capabilities()
  read README / README_zh-CN / TEST_README
  read package.json scripts
  read CI workflow matrix
  read recent verified behaviors from current implementation

diff_docs_against_code()
  mark outdated sections
  mark missing sections
  mark bilingual drift

rewrite_docs_in_layers()
  update README.md first
  mirror same structure to README_zh-CN.md
  update docs/TEST_README.md with current test reality
  patch topic docs only when concrete mismatch exists

validate_docs()
  check markdown structure
  check file diagnostics
  ensure EN/ZH headings and command examples stay aligned
```

## 6. 注意事项

- 不要把“当前一次性 coverage 数字”写成长期承诺；如需写入，应明确是“当前 CI/本地验证状态”。
- 不要再保留已移除功能，例如旧烧录流程的误导性描述。
- 中英文章节尽量同构，避免英文有、中文没有或反过来。
- 对测试部分要明确区分：
  - JS 扩展测试
  - Python mpyrepl 子系统测试
- 对跨平台说明要避免写死某一平台命令形态，尤其是 Windows PowerShell 特有行为。

## 7. 总结输出

### 计划执行顺序

1. 更新 README.md
2. 同步更新 README_zh-CN.md
3. 更新 docs/TEST_README.md
4. 检查是否需要补 docs/mpremote-windows-utf8.md
5. 运行文档相关静态诊断并做一次主回归说明

### 建议本轮实际修改文件

- README.md
- README_zh-CN.md
- docs/TEST_README.md
- （按需）docs/mpremote-windows-utf8.md

### 当前状态

- 本文件仅为实施计划。
- 在用户确认前，不开始正式改写上述文档内容。