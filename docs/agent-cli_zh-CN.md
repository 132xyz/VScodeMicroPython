# Agent CLI 参考

[English](agent-cli.md)

## 用途

Agent CLI 允许另一个本机进程复用 MicroPython 工作台的共享串口 manager.它可以附着扩展启动的 manager,也可以通过 `connect` 冷启动后台 manager.只有 manager 进程打开物理串口,Agent 客户端不会直接使用 pyserial 占用设备.

`agent` 的早期入口仅使用 Python 标准库,不会导入 `pyserial`、prompt-toolkit、Pygments 或其他 TUI 依赖.

## 调用方式

在当前源码仓库中执行:

```bash
python scripts/mpyrepl/__main__.py agent [全局选项] <命令> [命令选项]
```

全局选项必须写在具体命令之前:

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `--session PATH` | 空 | 显式指定 `serial-manager.json`. |
| `--workspace PATH` | 空 | 使用 `PATH/.mpy-workbench/serial-manager.json`. |
| `--busy wait\|reject` | `wait` | 有界排队,或在忙碌时立即失败. |
| `--queue-timeout SECONDS` | `30` | 排队操作开始前的最长等待时间. |
| `--timeout SECONDS` | `120` | 客户端操作等待时间;对 `exec` 同时控制执行输出等待,对 `soft-reset` 控制整个复位协议等待. |
| `--progress` | 关闭 | 将当前传输对应的进度 JSONL 写入 stderr. |

## 会话发现

CLI 按以下顺序解析 manager 描述文件:

1. `--session PATH`
2. `MPY_MANAGER_SESSION`
3. `--workspace PATH`
4. 从当前目录逐级向上查找 `.mpy-workbench/serial-manager.json`

扩展或 manager 自身会在就绪后原子写入描述文件,manager 退出时按 token 和实例 ID 条件清理.CLI 会校验 schema 和协议版本,要求地址为本机回环地址,使用描述文件中的 token 认证,并核对 manager 实例 ID.

除 `connect` 外,描述文件缺失、无效、过期或版本不兼容都会直接失败.`connect` 在没有描述文件或确认 endpoint 已失效时会启动新的后台 manager;显式 `--workspace` 时发布到该工作区,否则使用当前目录.它不会回退到旧的直接串口命令.

## 命令

| 命令 | 参数 | 结果 |
| --- | --- | --- |
| `status` | 无 | manager/设备状态、客户端数量和队列状态. |
| `wait-idle` | `--idle-timeout SECONDS` | 轮询直到没有正在执行或排队的操作. |
| `exec` | `--code SOURCE` | 不经过主机 REPL 插桩,直接执行源码. |
| `exec-file` | `LOCAL_PATH` | 读取 UTF-8/UTF-8-BOM 本地文件并执行. |
| `ls` | `[DEVICE_PATH]` | 列出目录,默认 `/`. |
| `tree` | `[DEVICE_PATH]` | 返回递归目录树,默认 `/`. |
| `stat` | `[DEVICE_PATH]` | 返回路径元数据,默认 `/`. |
| `get` | `DEVICE_PATH LOCAL_PATH` | 下载一个设备文件. |
| `put` | `LOCAL_PATH DEVICE_PATH` | 上传一个本地文件. |
| `mkdir` | `DEVICE_PATH [--no-parents]` | 创建目录,默认同时创建父目录. |
| `rm` | `DEVICE_PATH --yes [--recursive]` | 删除文件或目录,必须显式确认. |
| `mv` | `SOURCE_PATH TARGET_PATH` | 重命名或移动设备路径. |
| `interrupt` | 无 | 立即发送带外 Ctrl-C. |
| `connect` | `PORT [--baudrate N]` | 连接或切换到指定串口;没有 manager 时自动冷启动. |
| `disconnect` | 无 | 释放物理串口,保留 manager 和描述文件. |
| `reconnect` | 无 | 由 manager 关闭旧句柄并重连原串口,等待时长由 `--timeout` 控制. |
| `shutdown` | 无 | 关闭共享 manager;会断开人工 REPL 和其他 Agent. |
| `soft-reset` | 无 | 排队执行软复位,等待新 raw REPL 提示符和 helper 就绪. |

示例:

```bash
python scripts/mpyrepl/__main__.py agent --workspace C:\qzrobot\mpy --timeout 20 connect COM5 --baudrate 115200
python scripts/mpyrepl/__main__.py agent status
python scripts/mpyrepl/__main__.py agent --busy reject exec --code "print(1)"
python scripts/mpyrepl/__main__.py agent --queue-timeout 60 --timeout 300 exec-file mpy/main.py
python scripts/mpyrepl/__main__.py agent --progress get /sd/data.bin ./data.bin
python scripts/mpyrepl/__main__.py agent put ./main.py /sd/main.py
python scripts/mpyrepl/__main__.py agent mkdir /sd/logs
python scripts/mpyrepl/__main__.py agent rm /sd/old --recursive --yes
python scripts/mpyrepl/__main__.py agent interrupt
python scripts/mpyrepl/__main__.py agent disconnect
python scripts/mpyrepl/__main__.py agent --timeout 20 reconnect
python scripts/mpyrepl/__main__.py agent shutdown
```

## 文件传输格式

文件传输快路径使用 stdio 连续流,但数据仍经 Base64 编码,不是无编码的裸二进制协议.上传端在设备支持 `stdin.buffer.readinto` 时启动一个接收程序,接收编码数据并解码写文件;下载端启动一个发送程序,逐块读取文件并持续输出 Base64 数据行.这些流式路径不会为每个数据块重新执行一条 REPL 命令;设备不支持 stdin 流式接收时,上传仍保留原有逐块兼容回退.

下载的 Base64 是 ASCII,因此使用文本 `sys.stdout.write()` 输出,避免二进制 `stdout.buffer.write()` 在 `dupterm` 副输出短写时,把主串口已经发送的尾部再次发送.原文件仍按二进制读取和保存,文本输出只作用于传输记录,不会转换原文件中的换行或其他字节.缓冲已满的 WebREPL 镜像不保证完整显示文件传输数据.

开始/结束标记、最终长度校验和字节进度保持不变.下载先写 `.mpydownload` 临时文件,全部校验成功后才替换本地目标;失败时保留已有目标并清理临时文件.

内部记录现在另外带有每次操作独立 nonce 和字节长度的帧.下载块含序号和解码长度,结束时核对设备与主机 SHA-256 后才替换目标.固件需提供 `hashlib.sha256` 或 `uhashlib.sha256`.帧外后台文本送人工控制台;交错或损坏的记录导致校验失败,不会混进文件.流式传输和既有临时目标保护保持有效.

升级扩展后,已常驻的旧 manager 不会自动重新加载 Python 代码.验证修复前应确认所附着 manager 的启动脚本属于新版本;需要结束旧实例时,先安排好所有共享客户端,不要中断正在使用的设备会话.

## 软复位与 REPL 恢复

`soft-reset` 只发送一次 Ctrl-D.发送前的 raw 提示符、`soft reboot` 标记、复位后的 raw banner 和真实 `>` 提示符共用由 `--timeout` 指定的完整期限,不会因为启动过程中 100ms 没有输出就提前失败.人工 REPL/扩展未传期限时继续使用 manager 的默认协议期限,通常为 10 秒.成功结果保持 `{"ok":true,"result":true}`,此时 helper 也已重新注入.

CLI 通过 `device.softReset` 的可选 `softResetTimeoutMs` 参数传递毫秒期限,必须为正有限数.省略参数时沿用 manager 配置;这是复位协议的期限,排队和 helper 初始化另有等待开销.

完整期限内仍未恢复时,返回 `repl_sync_timeout` (退出码 5),不关闭原串口句柄.错误 `details` 包含:

- `resetSent`: 本次协议中是否已经发送 Ctrl-D.
- `resetObserved`: 是否已经收到 `soft reboot` 标记.它不是最终 REPL 就绪的证明.
- `replReady`: 此时为 `false`,表示协议需要重新同步.

这时 `status.state` 仍表示原串口连接,例如 `ready`,新增 `status.replReady=false` 表示不能直接开始 raw 协议操作.下一次执行、文件系统或补全命令会在原 manager、原串口句柄上通过 Ctrl-C/Ctrl-A 恢复 raw REPL 并重新注入 helper,不会再次发送 Ctrl-D.`status` 本身只查询状态,不会触发恢复.实际串口读写失败仍返回 `transport_lost`,关闭失效句柄并进入 `stopped`.

不要仅因同步超时就直接重试 `soft-reset`,因为第一次 Ctrl-D 可能已经生效;特别是 `resetSent=true`、`resetObserved=false` 时,复位结果尚不能确定.先用下一条正常命令恢复 REPL.人工 REPL 会继续保留,不会因这类同步错误收到断线状态.

执行和文件系统命令缺少 raw stdout/stderr EOF 时也返回 `repl_sync_timeout`,保留原串口句柄.这表示协议状态不确定,不能据此认定物理断线,失败操作不会自动重放.下一条主动命令恢复 REPL 时可能通过 Ctrl-C 中断尚未结束的设备代码,重试写入或其他有副作用的操作前应先确认其实际结果.`ls` 只读取单个目录;显式 `tree` 仍递归扫描,大目录或慢文件系统需要更多时间.

## 排队与输出行为

代码执行、文件系统操作、连接、断开、重连、软重置和补全共用 manager 端的串口操作锁.默认 `--busy wait` 使用由 `--queue-timeout` 限制的有界排队;`--busy reject` 会立即返回 `busy` 错误.排队期间客户端断开时,对应请求会被取消.`interrupt` 绕过队列,因此可用于停止正在运行的设备代码.

新版 manager 公布 `request-cancel` 和 `ordered-output` 能力.`request.cancel` 在同一已认证连接上接收 `requestId`: 排队请求直接移除,不向设备发字节;运行中请求只能中断自己的串口操作,并在中断发送完成后才释放操作锁.客户端本地超时仅在 manager 声明能力时使用它,旧 manager 不会回退为全局中断.取消代表请求停止,不代表回滚设备副作用.

状态可包含 `activeOperation`,提供客户端 ID、请求 ID、方法、阶段和已运行毫秒数.事件 `sequence` 标识 manager 输出顺序.这些 ID 表示当前主机操作,不能证明输出来自设备上的哪个线程.CLI 使用 monotonic 总等待期限,持续收到事件也不会无限延期.扩展文件请求使用 2 秒排队预算和有界设备操作预算,视图超时不会重启共享 owner.

执行 `machine.reset()` 或设备重新枚举后,manager 可能暂时进入 `stopped`.`reconnect` 会释放 manager 持有的旧串口句柄,在 `--timeout` 范围内重复打开同一个已配置端口,然后重新进入 raw REPL 并注入 helper.整个过程仍由现有 manager 完成,Agent 不会直接打开 COM 口,也不需要操作 VS Code 界面.

设备重新枚举为不同 COM 编号时使用 `connect NEW_PORT`.`disconnect` 只释放串口并保持 endpoint 可用;`shutdown` 才会停止 manager.冷启动错误保存在 `.mpy-workbench/serial-manager-startup.log`,ready token 不会写入该日志.

人工 REPL 保持为完整实时控制台,会接收所有客户端触发的设备 stdout/stderr,也包括后台线程输出.Agent 命令按自己的请求 ID 过滤 manager 事件,并且只向 stdout 写一条最终 JSON,因此其他设备输出不会破坏机器可读结果.启用 `--progress` 后,匹配当前请求的进度事件以 JSONL 写入 stderr.

成功格式:

```json
{"ok":true,"result":{}}
```

失败格式:

```json
{"ok":false,"error":{"code":"busy","message":"serial manager is busy","details":{}}}
```

`exec` 或 `exec-file` 执行失败时还会包含 `result`,调用方可以读取设备 stdout 和 stderr.

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功. |
| `2` | 参数无效、本地文件缺失或未提供必须的确认参数. |
| `3` | manager 发现、描述文件、schema、协议或过期实例错误. |
| `4` | 使用 `--busy reject` 时 manager 正忙. |
| `5` | 排队、操作、REPL 同步、socket 或 `wait-idle` 超时. |
| `6` | manager 不可用、传输断开或设备未就绪. |
| `7` | 设备/文件系统错误,或 MicroPython 执行产生 stderr. |
| `8` | 其他 manager RPC 错误. |
| `130` | 本机 Ctrl-C 中断. |

## 安全与生命周期

- manager 绑定本机回环地址,CLI 会拒绝非回环描述文件.
- 描述文件包含 bearer token.必须保持 `.mpy-workbench/` 被 Git 忽略,不要打印、提交或共享该文件.
- `connect` 可在扩展尚未打开串口时创建后台 manager;扩展后续会通过同一描述文件附着该实例.
- Agent 客户端断开不会关闭 manager 或人工 REPL.
- `shutdown` 是显式的全局生命周期操作,会关闭共享 manager 及其所有客户端.
- manager 持有串口时,不要再启动第二个直接连接同一 COM 设备的串口客户端.
