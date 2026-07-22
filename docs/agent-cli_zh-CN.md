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
| `--timeout SECONDS` | `120` | 客户端操作期限;对 `exec` 同时作为执行输出等待时间. |
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
| `soft-reset` | 无 | 排队执行设备软重置. |

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

## 排队与输出行为

代码执行、文件系统操作、连接、断开、重连、软重置和补全共用 manager 端的串口操作锁.默认 `--busy wait` 使用由 `--queue-timeout` 限制的有界排队;`--busy reject` 会立即返回 `busy` 错误.排队期间客户端断开时,对应请求会被取消.`interrupt` 绕过队列,因此可用于停止正在运行的设备代码.

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
| `5` | 排队、操作、socket 或 `wait-idle` 超时. |
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
