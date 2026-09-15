# stdio 流式下载重复数据修复计划

- 项目: `/home/qz/qzrobot/mpy/VScodeMicroPython`.
- 创建时间: 2026-09-04 14:36:15 +0800.
- 基线: `main`, `8f6d91e17c1f35ae312830b4f93a16c049fa513d`, `package.json` 版本 `0.4.37`.
- 规划前工作树: clean.
- 状态: 主机侧修复、回归测试、打包及 ESP32_S3_AMOLED 新发送器/主机解析器实机数据验证完成.新版本 manager 原生文件 RPC 和 VS Code 界面验收待用户安装后进行,不归档.用户于 2026-09-04 明确回复“可以开始”,授权按本计划的范围实施.
- 授权不包含安装 VSIX、热替换已安装扩展、重启设备或任意关闭共享 manager.
- 最新测试边界: 用户指定仅使用 **ESP32_S3_AMOLED** 测试和验证.**cstptesp32s3 正在开发使用,后续禁止对其进行任何诊断 RPC、文件传输、连接切换、中断或重启**.

## 1. 目标与边界

### 目标

修复串口下载在设备同时启用 qzweb/WebREPL `dupterm` 时,文件数据尾部重复发送,导致 `size_mismatch` 或 Base64 解码失败的问题.

成功标准:

1. 在 ESP32_S3_AMOLED 上用与原故障等价的 4026 字节样本、多块文件和二进制样本验证下载,长度及内容与参考一致.不再用正在使用的 cstptesp32s3 做验收.
2. 任意二进制文件仍逐字节保真,不对原文件做文本编码、换行转换或内容清理.
3. 保持一次启动设备发送程序、持续输出数据的流式方案,不退回逐块执行 REPL 命令.
4. 保留字节级进度、最终大小校验、临时文件和成功后原子替换目标的行为.
5. 使用项目构建脚本测试、递增版本并产出 `release/*.vsix`,由用户安装.

### 本次不做

- 不移除 Base64,不设计新的裸二进制协议.
- 不修改上传的 `stdin.buffer.readinto` 路径.
- 不修改默认分块大小、超时、队列策略、串口波特率和重试策略.
- 不关闭或临时摘除 `dupterm`,不停止 qzweb,不软重置或硬复位设备.
- 不访问 cstptesp32s3,不因它更容易复现而临时改用该设备.
- 不修改 MicroPython C 固件或 `my_custom` 中的业务、硬件和 WebREPL 代码.
- 不重构 manager、transport、REPL UI、同步清单或“Continue/Abort”交互.
- 不删除校验,不忽略重复尾部,不按目标大小截断数据后宣告成功.
- 接收协议新增 CRC、序号、专属数据帧以及严格 Base64 校验属于另一个加固任务,本次不捆绑实施.

## 2. 项目现状与诊断证据

### 2.1 当前数据链路

```text
上传: 文件 bytes -> Base64 bytes -> 串口 -> stdin.buffer.readinto
      -> Base64 解码 -> 设备临时文件 -> 替换目标

下载: 设备文件 bytes -> Base64 bytes -> stdout.buffer.write
      -> 串口 raw REPL stdout -> 主机逐行 Base64 解码
      -> .mpydownload 临时文件 -> 校验成功后 os.replace
```

当前是 stdio 连续流式传输,不是无编码裸二进制.上传实现明确保留 Base64,以避免文件中的 REPL 控制字节被输入链路解释为控制操作.

相关代码:

- `scripts/mpyrepl/runtime/filesystem.py`:
  - `DeviceFsClient._write_file_stdin_base64`: 当前上传流式实现,本次只读参考.
  - `DeviceFsClient.read_file`: stat、临时文件、失败清理和原子替换.
  - `DeviceFsClient._read_file_stdout_base64`: 开始/结束标记、Base64 解码、长度校验和进度.
  - `DeviceFsClient._stdout_base64_sender_code`: 本次唯一拟修改的生产代码区域.
- `scripts/mpyrepl/manager/session.py`: `fs_operation` 通过现有 gate 串行执行文件传输.
- `scripts/mpyrepl/clients/agent.py`: `get` 映射到同一 `fs.readFile` RPC.
- `src/commands/syncCommands.ts`: `syncBaselineFromBoard` 经 `cpFromDeviceWithProgress` 进入共享文件传输路径.
- `scripts/mpyrepl/tests/test_fs_ops.py`: 可复用 `FakeTransport`、`ExecResult`、`_download_stdout` 和临时目录测试.

### 2.2 已观察到的实机事实

来源: 本任务 2026-09-04 的用户截图和在用户限定测试板之前完成的只读诊断.这些是 cstptesp32s3 上的历史证据,不得当作 ESP32_S3_AMOLED 或修复后验收结果,也不得据此再次访问 cstptesp32s3.

- 故障文件 stat: `size=4026`, `is_readonly=true`.
- 原下载链路通过 Agent 连续两次失败,主机分别累计 `4980`、`7284` 字节,设备结束标记均报告 `4026` 字节.
- 捕获的一次响应先含完整的 `5368` 字符 Base64 数据行,随后又含相同数据从编码偏移 `4096` 开始的 `1272` 字符尾部.
- 完整数据行解码为 `4026` 字节,与可信本地参考文件内容相同.重复尾部又解码为 `954` 字节.
- 设备 stdout 为 `TextIOWrapper`,存在 `.buffer`.
- 设备 qzweb 运行中,通过 `peer.session.repl_owner.attached` 观察到 `dupterm` 已挂接,桥接输出缓冲容量为 `4096`.

同一设备、同一文件、同一 manager 的 A/B 结果:

| 设备输出 API | 原文件分块字节数 | 主机解码字节数 | 结果 |
| --- | ---: | ---: | --- |
| `sys.stdout.buffer.write` | 4096 | 7284 | 重复尾部,失败 |
| `sys.stdout.buffer.write` | 1024 | 4580 | 仍重复,不能靠减小分块可靠修复 |
| `sys.stdout.write` | 4096 | 4026 | 连续 3 次字节级一致 |

本次参考文件主机 SHA-256 为 `82e75ec6ca84be41533a6313a5ea898ad4e20a8b7f399072c2103c784d9cee90`.它只是诊断样本指纹,不得写入生产逻辑;后续文件变化时应重新计算参考值.

### 2.3 根因解释与证据强度

已证实的是重复的文件尾部,不是普通日志.此前“后台日志混入”的推测已被这次原始响应分析替代.解析器对其他 stdout 行缺少隔离仍是独立风险,不能把它误当成本次实机根因.

以下固件调用链与实测现象一致,是高置信度原因;未做固件调试器级单步追踪:

1. `/home/qz/qzrobot/mpy/github/micropython/shared/runtime/sys_stdio_mphal.c` 中 `stdio_buffer_write` 返回 `mp_hal_stdout_tx_strn` 的计数.
2. `/home/qz/qzrobot/mpy/github/micropython/ports/esp32/mphalport.c` 中 `mp_hal_stdout_tx_strn` 向主输出和 `dupterm` 分发数据,并取成功通道返回计数的最小值.
3. USB 已发送完整片段时,`dupterm` 因缓冲空间不足返回短写长度,仍可能拉低该返回计数.
4. `/home/qz/qzrobot/mpy/github/micropython/py/stream.c` 中 `mp_stream_rw` 按短写计数自动补写剩余尾部.这次补写又经过 USB,造成重复.
5. 尾部长度取决于副输出缓冲的可用空间.能解码时表现为大小不符;截断位置不符合 Base64 四字符边界时表现为编码错误.

`.buffer` 是字节接口,并不代表独占物理串口或绕过 `dupterm`.

## 3. 需求、授权与代码保护

| 项目 | 状态与来源 | 本计划的处理 |
| --- | --- | --- |
| 需要给出具体修复计划 | 用户规划阶段明确请求 | 先新增此计划文档 |
| 开始实施 | 用户后续明确回复“可以开始” | 按本计划限定范围修改代码、测试、文档并构建;不安装或扩大设备操作权限 |
| 保持现有 stdio 流式方案 | 用户追问及前述方案解释 | 不改变一次运行持续发送的模式 |
| Base64 文本输出规避重复 | 实机 A/B 已验证,当前仍是提案 | 仅限定发送函数中的输出辅助函数 |
| 用户自行安装扩展 | 本任务历史明确要求 | 只生成新版本 VSIX,不安装或替换 |
| 实机目标仅 ESP32_S3_AMOLED | 用户最新明确要求“测试时使用 ESP32_S3_AMOLED...cstptesp32s3 正在开发和使用” | 所有实机操作与验收限定该测试板,cstptesp32s3 禁止操作 |
| 保护设备及本地原文件 | 用户历史允许恢复环境的测试,并明确要求测试文件放 SD 目录 | 主机诊断落到临时目录;仅允许在已确认的 ESP32_S3_AMOLED SD 卡独立临时目录准备样本,不覆盖原文件,测后清理恢复 |
| 扩展下载代码作者身份 | 未发现专门人工保护记录,身份未确认 | 不按 Git 提交作者推断人工/AI 来源;保留函数结构、命名及相邻实现 |
| 设备业务和固件代码 | 本任务未授权修改 | 只作为根因参考,不修改、不格式化 |

用户已明确要求按本方案开始,修改范围仅为下述文件及函数区域.若出现需要改固件、WebREPL 桥、上传或管理器生命周期的问题,必须先在对话中说明并重新确认,不能自行扩大范围.

## 4. 方案设计

### 4.1 最小生产修复

在 `DeviceFsClient._stdout_base64_sender_code` 生成的 `write_bytes(data)` 内,去掉优先使用二进制 `.buffer` 的分支,统一使用已有文本回退路径:

```python
def write_bytes(data):
    sys.stdout.write(data.decode())
```

这里的 `data` 已由 `binascii.b2a_base64` 产生,是 ASCII 字节,不是原文件.保留当前 `.decode()` 的用法,不引入新的编码 API 兼容性要求.

只补一条简短的主机侧代码说明,解释为什么有意不使用 `stdout.buffer`: 副输出短写可能让二进制流重发主串口已经发送的尾部.不要在该修复中重命名生成器、抽象传输层或调整无关注释和换行.

### 4.2 保持不变的行为

- `DEFAULT_CHUNK_SIZE=4096` 不变.
- 仍用 `f.read(chunk_size)` 和 `binascii.b2a_base64` 逐块发送,不整文件驻留内存.
- START/END/ERROR 标记、JSON 字段、Base64 数据行和 RPC 方法不变,不提升 RPC 协议版本.
- 文本 stdout 可能把传输记录的 LF 转为 CRLF,现有解析器的逐行拆分和 `strip()` 已可处理.原文件的 CR/LF/NUL 等字节在 Base64 内,不会被转换.
- 主机仍验证设备声明大小、解码累计大小、设备错误和 stderr.
- `read_file` 仍只在全部成功后替换目标;失败保留旧目标并清理 `.mpydownload`.
- Agent `get` 和 VS Code 下载走同一修复,不分别实现第二套逻辑.
- 上传、人工 REPL 输出代理、串口 gate 和 UI 进度接口均不改.

### 4.3 兼容性限制

这是面向主串口下载的兼容性修复,不是固件多路 stdout 的全面修复.副输出缓冲已满时,不能承诺 WebREPL 镜像仍完整显示所有文件传输 Base64 数据.不改变正常业务打印的调用路径,不关闭镜像,也不新增输出丢弃策略.

其他固件/USB 实现仍可能发生主输出短写或其他传输故障.必须保留校验并用较大文件实测,不能仅凭该 4KB 样本宣称所有平台已修复.如果新路径出现数据缺失,停止扩大修补并重新确认固件级方案.

## 5. 文件与区域任务

以下是本次实施的限定修改范围,不是整文件重写授权.

| 文件 | 区域与修改目的 |
| --- | --- |
| `scripts/mpyrepl/runtime/filesystem.py` | 仅 `_stdout_base64_sender_code` 的输出辅助函数和必要说明.其它传输函数保持不变 |
| `scripts/mpyrepl/tests/test_fs_ops.py` | 新增生成发送器的回归测试及窄测试辅助对象,复用现有 FakeTransport.不改变旧断言以迎合新实现 |
| `docs/agent-cli_zh-CN.md` | 补充上传/下载都是 stdio + Base64 流式传输、`dupterm` 兼容处理和版本验证说明 |
| `docs/agent-cli.md` | 同步上述说明,避免将 stdio 字节接口称为无编码二进制协议 |
| `docs/TEST_README.md` | 仅新增本次发送器回归和实机验证方法,不重写无关测试快照 |
| `package.json`, `package-lock.json` | 仅由完整构建脚本执行 patch 版本更新 |

明确不修改: `src/commands/syncCommands.ts`, `scripts/mpyrepl/runtime/transport.py`, `scripts/mpyrepl/manager/*`, `scripts/mpyrepl/clients/repl.py`, `.vscode/settings.json`, `scripts/mpyrepl/_vendor/`, 已安装扩展目录, `my_custom/`, `github/micropython/`.

风格参考限定为该生成器现有的字符串拼接、异常类型和 `test_fs_ops.py` 的 unittest/mock/TemporaryDirectory 用法.不得借此格式化整文件或统一其他作者的风格.

## 6. 分阶段执行

### 阶段 A: 核对基线,先补回归测试

1. 获得实施确认,重新检查 HEAD、版本及脏文件.保留用户或其他任务的改动.
2. 在测试中执行实际生成的发送程序,使用可记录文本写入的模拟 stdout.
3. 该对象同时提供会模拟“主通道完整发送,副通道短写导致尾部重发”的 `.buffer.write` 分支.用明确标注的模拟复现原代码问题,不能把模拟结果写成真实固件验证.
4. 断言实际接收的数据记录与预期 Base64 数据记录一致,而不只搜索生成源码中的某个字符串.

完成标准: 修复前新回归能捕捉重复数据或不应调用的二进制 stdout 路径,现有测试基线清楚.

### 阶段 B: 修改发送辅助函数

1. 只按 4.1 修改输出 API.
2. 运行定向测试,验证 ASCII 传输记录及任意原文件字节保真.
3. 检查 diff,确认上传、大小校验、原子替换和超时均未改变.

完成标准: 新旧定向测试均通过;下载仍为一次设备发送程序,没有逐块 RPC.

### 阶段 C: ESP32_S3_AMOLED 实机验证

1. 先从主机串口枚举、稳定 USB 标识和明确的设备对应关系确认 ESP32_S3_AMOLED.不能仅凭 `ttyACM0/ttyACM1` 名称、历史端口或通用 ESP32-S3 型号判定.身份仍有歧义时,先向用户确认,不试探性操作 cstptesp32s3.
2. 所有调用显式指定已确认属于 ESP32_S3_AMOLED 的 manager 描述文件,校验实例 ID.禁止默认向上发现主工作区 `.mpy-workbench/serial-manager.json`,它可能仍指向 cstptesp32s3.
3. 测试板已有 manager 时只附着该实例.确实没有时,实施获得确认后才可为该测试板建立独立测试会话,不覆盖业务工作区描述文件,不另开竞争串口客户端.先查询忙闲状态,操作采用 `queuePolicy=reject`;忙时退出,不抢占.
4. 记录 ESP32_S3_AMOLED 当前固件、挂载、业务运行和 WebREPL 挂接状态.主要回归需要 `dupterm` 短写条件;若测试板当前没有相应环境,先报告并确认如何准备,不得自行覆盖 `dupterm` 槽、停止原服务或重置设备.不能把无 WebREPL 的通过结果冒充本缺陷条件下的验证.
5. 按用户既有 SD 测试约束,确认 SD 挂载和空间后,只在其下面新建不与既有内容冲突的临时目录.准备 4026 字节、跨多块及任意二进制样本,记录目录和样本清单.参考数据由主机生成;不再从 cstptesp32s3 获取原文件.上传只用于准备样本,不改上传实现.
6. 在测试板 manager 上通过 `repl.exec` 执行新发送器时,使用独立 globals 的 `exec(source, {})`.先通知用户共享 REPL 可能出现诊断数据.结果仅保存在主机临时目录,不覆盖工作区业务文件,不输出凭证或配置内容.
7. 在测试板的目标 WebREPL 条件下对 4026 字节样本重复 20 次,再测试多块和二进制样本.逐次核对长度和 SHA-256/主机参考内容,同时核对原有服务未被中断.
8. 在 `finally` 清理仅本次新增的样本与临时目录,不递归删除无法证明属于本次测试的内容.复用的原 manager 保持原运行状态;仅本次新建的专用测试 manager 可在确认没有其它使用者后关闭.恢复测试开始前环境,保留脱敏结果;若清理失败须明确报告残留路径,不得隐藏.

验证边界: 经 `repl.exec` 收集发送器结果并用主机解析器检查,只能验证实机发送数据和解析兼容性.不能冒充“新 manager 原生 fs.readFile 的逐块进度和完整 GUI 同步验收”.这些还需阶段 E.

完成标准: ESP32_S3_AMOLED 上重复样本和多块文件无重复、无缺失,内容匹配;测试环境恢复,cstptesp32s3 全程未被操作.如失败,保留错误类别和长度等脱敏信息,不放宽校验.

### 阶段 D: 文档、全量测试与打包

1. 更新第 5 节限定文档.
2. 使用 `./build.sh patch`,由脚本依次完成 TypeScript 编译、Jest、Python 覆盖率测试、版本递增及打包.
3. 基线仍为 `0.4.37` 时,预期生成 `release/mpy-0.4.38.vsix`;如果实施前版本已经变化,从实际版本递增,不要强制写回 `0.4.38`.
4. 检查 VSIX 内的 `extension/scripts/mpyrepl/runtime/filesystem.py` 确实包含修复,产物不留在根目录.
5. 不运行安装命令,不覆盖 `/home/qz/.vscode/extensions/`.

完成标准: 完整脚本成功,覆盖率不低于项目门槛,最终产物及验证记录可交付.

### 阶段 E: 用户安装后的端到端确认

1. 用户自行安装新 VSIX.必要时由用户安排结束旧 manager 并通过新扩展重新打开串口;没有明确授权不得替用户关闭共享 manager.
2. 上述切换和后续操作仅针对 ESP32_S3_AMOLED 测试会话,不能结束 cstptesp32s3 的 manager 或更改其工作窗口的串口配置.核对测试板新 manager 的启动脚本路径及版本.仅安装扩展并不保证已常驻的旧 manager 自动加载新 Python 代码.
3. 用测试板新 manager 的 Agent `get` 下载等价故障样本到主机临时目录,验证长度、内容和完成进度.
4. 在绑定 ESP32_S3_AMOLED 的测试窗口中执行 VS Code “Download all files”,下载目标使用独立测试目录,确认代表样本及后续文件无同类错误.不对 cstptesp32s3 重跑原第 6 个文件作为验收.

完成标准: 新 manager 原生传输和用户原始界面流程均确认通过.如果尚未安装或未做 GUI 回归,交付时标为待验证,不宣称全部端到端完成.

## 7. 验证计划

### 主机用例

- 原文件长度: `0, 1, 2, 3, 1024, 3071, 3072, 3073, 4026, 4096, 8192`.
- 输入包含完整 `0..255` 字节范围,尤其 `0x03`, `0x04`, NUL, CR/LF 和非 UTF-8 序列.
- 测试发送 stdout 有无 `.buffer` 两种环境,均走相同文本写路径.
- 模拟副通道接受 `4096` 以及非 Base64 四字符对齐的短长度,新发送器不得访问会触发补写的二进制路径.
- 将生成结果以不同切片边界送入生产接收回调,覆盖标记、CRLF 和 Base64 行跨串口块拆分.
- 验证失败仍保留已存在的本地目标,清理临时文件,不发成功完成事件.
- 既有大小不符、缺文件、设备 stderr、缺少结束标记等测试保持原语义;遇到真实重复/损坏数据仍报错.

### 命令

在 `/home/qz/qzrobot/mpy/VScodeMicroPython` 执行.本机没有可用的裸 `python` 命令,因此定向检查明确使用已验证的解释器:

```bash
/usr/bin/python3 -m unittest discover -s scripts/mpyrepl/tests -p 'test_fs_ops.py'
/usr/bin/python3.14 -m unittest discover -s scripts/mpyrepl/tests -p 'test_fs_ops.py'
/usr/bin/python3 scripts/mpyrepl/tests/run_with_coverage.py
git diff --check
./build.sh patch
```

`build.sh` 会选择可用的 `python3`,不应为这次任务修改全局 Python 配置.项目覆盖率门槛由 `run_with_coverage.py` 的 `MINIMUM_COVERAGE_PERCENT` 决定,当前为 `80.0`.

### 性能记录

记录成功传输的实际字节数、总耗时和进度,不能把“重复发送后失败”的旧路径吞吐率当作有效基准.不承诺通过 4KB 样本就证明大文件速度;大文件比较必须以内容校验成功为前提.

## 8. 风险与交接注意事项

- 同名文件的错误只是这一底层输出问题的表现,不得针对 `http.py`、固定长度或某个哈希写特判.
- 目前只有特定 ESP32/MicroPython/qzweb 组合做过诊断.其它板型和 Windows 主机尚未实测,报告须明确区分主机测试与真实硬件覆盖.
- 不同 USB 主输出实现的短写行为可能不同.若文本输出发生缺字节,不能靠增加缓冲或减小块后未经验证就宣布解决.
- 开始/结束标记之间的普通输出混入、严格编码验证、帧校验和重同步属于后续独立加固范围.本计划不会声称修复所有 stdout 干扰.
- “Continue” 的现有含义是继续后面的文件,不是重试失败文件.本次不改变该 UI 语义,验收不能只看整批流程结束提示.
- 更新代码后若 manager 仍为旧版本,需先完成明确授权的生命周期切换,不直接修改运行中的安装目录.
- 若安装 VSIX 或重载扩展会影响 cstptesp32s3 所在业务窗口,只交付产物,等待用户安排独立测试窗口或合适时机;不得为完成验收停止其开发和使用.
- 不提高波特率、不运行第二个直接串口客户端、不删除既有设备文件、不让主机诊断产生的新文件触发工作区大范围扫描.
- SD 测试样本仅在已确认的 ESP32_S3_AMOLED 上创建和清理.不得为节省准备工作改用 cstptesp32s3;测试板身份或复现环境不明时先停下确认.
- 实施完成且验收记录齐全后,才可按约定把本计划移入 `qzplans/old/`.归档后不再二次修改.

## 执行记录

- 2026-09-04: 仅创建计划,核对相关源码、构建脚本和此前实机诊断证据.
- 2026-09-04: 根据用户最新约束,把实机目标改为 ESP32_S3_AMOLED,将 cstptesp32s3 标为禁止操作对象,并补充设备身份确认、显式 manager 选择和 SD 临时样本清理要求.
- 规划轮次未改生产代码、测试、版本、用户设置或固件,未执行新一轮设备测试.
- 2026-09-04 14:49: 用户已明确回复“可以开始”.开始阶段 A,新增发送器回归测试,生产函数暂未修改.
- 主机枚举显示两个通用名称的 ESP32 USB CDC 设备,正在向用户确认 ESP32_S3_AMOLED 对应的稳定 USB 序列号.确认前不发送任何设备 RPC.
- 阶段 A 完成: 新回归在旧实现上 3 个子用例失败,其中响应行长度精确复现 `[5368, 1272]` 和 `[5368, 2653]`.
- 阶段 B 开始: 仅替换生成发送器的 `write_bytes` 实现为文本 stdout,其余生产传输路径未改.
- 阶段 B 完成: `test_fs_ops.py` 的 27 个测试在 Python 3.12 和 3.14 下均通过,包括发送器、二进制边界、分片接收和失败保留目标用例.
- 阶段 D 文档已更新;阶段 C 等待测试板身份确认,尚未访问设备.
- 后续主机证据确认: `my_custom/doc/ESP32_S3_AMOLED/tinyuf2.md` 和该板分区迁移记录绑定 UID `1020ba460994`、USB 位置 `1-11.2`,与当前主机枚举一致.专用描述文件 `/tmp/qzmpyweb-acm1/.mpy-workbench/serial-manager.json` 的 PID `331342` 实际持有该板 `/dev/ttyACM0`,未使用业务工作区的默认描述文件.
- 阶段 C 尚未完成: 对上述测试板会话进行独立 globals 的身份/SD 只读查询时,等待 stdout EOF 超时,manager 自动转为 `stopped`.尚未准备任何设备测试文件或运行修复后下载回归.已向用户请求仅重连测试板会话的许可,没有自行发送 Ctrl-C、重连或复位,也没有对 cstptesp32s3 发出 RPC.
- 阶段 D 构建通过: `./build.sh patch` 完成 26 个 Jest 套件/112 个测试,Python 3.12 下 231 个测试及 89.0% 覆盖率,版本升为 `0.4.38`,产物位于 `release/mpy-0.4.38.vsix`.
- 额外主机验证: Python 3.14 下全量 231 个测试通过,其 trace 覆盖率为 84.3%,同样超过 80% 门槛.两种解释器的覆盖统计分别记录,不混为同一测量.
- VSIX 解压校验及打包的 `filesystem.py` 与工作树 SHA-256 一致性校验通过.未安装 VSIX.阶段 E 未开始.
- 文档最终补充上传兼容回退说明后,使用 `./build.sh -S` 保持已递增的 `0.4.38` 再次全量测试和打包,结果同样全部通过.本计划不归档,实机和 GUI 验收仍待完成.
- 用户随后明确回复“可以”,允许仅重连 ESP32_S3_AMOLED 测试会话并发送进入 raw REPL 所需的 Ctrl-C.已确认该 manager 未启用 soft-reset-on-connect,没有执行软重置、硬复位或操作 cstptesp32s3.
- 恢复后设备实际返回 UID `1020ba460994`,`ESP32-S3-AMOLED with ESP32S3`,MicroPython `1.29.0`.挂载表含 `/sd` 与 `/`,均为 LittleFS2.qzweb 运行,已有 WebREPL owner 为 attached,缓冲容量为 4096,无需新建或替换 dupterm 环境.
- SD 空间查询在延长诊断等待后成功,可用 15,569,832 个 512-byte 块.首次临时目录创建等待超时后,查明目录已创建但为空,已清理后重新准备.只延长临时诊断脚本的等待并加入完成标记,没有修改生产传输超时;这些环境超时不计为修复后下载失败或通过证据.
- 在 `/sd/.mpy-stdio-G7Neyw04` 准备 0、1、4026、8192、65536、262144 字节样本.根据主机已知的 `0..255` 循环模式在测试板生成,并通过设备读取后的 SHA-256 与主机参考校验.未修改上传实现,未使用业务板原文件.
- 旧发送 API 的实机基线复现: 4026 字节样本被主机统计为 4980 字节,返回 `size_mismatch`.
- 新发送器实机验证: 4026 字节样本连续 20 次成功,另外 5 个尺寸各 1 次成功,共 25 次长度和 SHA-256 均一致.生产主机解析器的进度数值单调、最终完成事件及临时文件清理断言通过.
- 本次测试通过已有测试 manager 的 `repl.exec` 运行独立 globals 的新发送器,再由新 `DeviceFsClient` 主机解析器处理结果.响应经 RPC 收集后交给接收回调,因此不能作为新 manager 原生 `fs.readFile` 流式时序或 GUI 验收记录.阶段 E 仍未执行.
- 清理复核通过: SD 测试目录已不存在,主机样本/下载数据已删除,挂载表和 WebREPL attached/capacity 状态与测试前一致,qzweb 继续运行,测试 manager 状态为 ready.未重启 Python manager 进程,未安装或替换扩展.
- 脱敏实机记录和临时验证脚本保留在 `/tmp/mpy-stdio-validation-G7Neyw04/results.json` 与同目录 `validate.py`.本计划上述摘要为持久交接记录,不依赖临时目录长期存在.
