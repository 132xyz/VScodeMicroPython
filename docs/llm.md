
增加自动构建工作流

发布到扩展插件市场内

详细分析此vscode扩展C:\qzrobot\mpy\VScodeMicroPython代码,分析以下问题,先不改代码,先详细全面阅读代码,分析程序运行逻辑,如果确定方法,最后给出一个完整的面向你自己修改代码的详细工作列表,具体要修改哪些代码有哪些注意事项


- 完整分析和了解我的扩展 E:\xm\github\github\VScodeMicroPython ,在同步文件功能中只能同步所有文件,或差异化同步,还差一个只同步已经打开的文件的功能,看看要怎么实现
~
- 完整分析和了解我的扩展 E:\xm\github\github\VScodeMicroPython , 现有的mpy官方repl对utf-8功能兼容不好,我想参考thonny的串口功能实现自己的repl,这github\VScodeMicroPython\qzplans\qzplan_mpy_repl_client_20260530_v1.md是一个初步计划,先详细分析,看看有什么问题要要确认的项目


- 同步路径错了,我本地路径是mpy\try_v3.py 同步到板子上应该是在根目录,应该我的同步目录是mpy这就是根目录,但实际是同步到了/mpy_testroot/try_v3.py 
- 同步后要自动刷新板子上的文件路径,要不然我还要手动刷新才能看到文件,这也不太合理
[Extension Host] [DEBUG] cpToDevice: Creating parent directories for: /mpy_testroot
workbench.desktop.main.js:sourcemap:1002 [Extension Host] [DEBUG] cpToDevice: ✓ Directory already exists: /mpy_testroot
workbench.desktop.main.js:sourcemap:1002 [Extension Host] [DEBUG] cpToDevice: Executing command: "c:\Users\30901\AppData\Local\Python\pythoncore-3.14-64\python.exe" -m mpremote connect COM4 fs cp e:\xm\github\mpy\try_v3.py :/mpy_testroot/try_v3.py
workbench.desktop.main.js:sourcemap:1002 [Extension Host] [DEBUG] cpToDevice: Device path: /mpy_testroot/try_v3.py -> /mpy_testroot/try_v3.py -> :/mpy_testroot/try_v3.py
workbench.desktop.main.js:sourcemap:1002 [Extension Host] [DEBUG] clearFileTreeCache: Cache cleared

~
- 删除文件后记得也自动刷新展示列表
~ 
- 删除功能还是不行,要根据E:\xm\github\github\micropython\tools\mpremote实际代码行为和mpy文档等资料确认情况后再修改代码
notificationsAlerts.ts:42 Failed to delete /mpy_testroot from board: Command failed: c:\Users\30901\AppData\Local\Python\pythoncore-3.14-64\python.exe -m mpremote connect COM4 fs rm /mpy_testroot mpremote: rm: /mpy_testroot: No such file or directory.
- 我尝试展开一个目录时会一直再转圈提示运行,但日志没有显示有在运行命令,实际应该是没有执行ls命令
~
- 先直接使用python独立验证功能先不直接修改扩展的js代码,验证后在集成到扩展内
~
- 历史问题记录：安装最新扩展后没看到当时的实验 REPL 配置项
- 你可以直接改E:\xm\github\.vscode\settings.json看看没有生效

- 重启vscode扩展后配置项出现了
- 2. `Ctrl-D`现象是退出而不是重启,但这应该是重启功能
(base) PS E:\xm\github> & "c:\Users\30901\AppData\Local\Python\pythoncore-3.14-64\python.exe" c:\Users\30901\.vscode\extensions\webforks.mpy-0.3.65\scripts\mpyrepl\__main__.py --port COM4 async-repl --control-file C:\Users\30901\AppData\Local\Temp\vscodemicropython\mpyrepl-COM4.json
>>> a=3
>>>                                                                                                                                                                                                                                                       
(base) PS E:\xm\github> (C:\ProgramData\anaconda3\shell\condabin\conda-hook.ps1) ; (conda activate py313t)
(py313t) PS E:\xm\github> & "c:\Users\30901\AppData\Local\Python\pythoncore-3.14-64\python.exe" c:\Users\30901\.vscode\extensions\webforks.mpy-0.3.65\scripts\mpyrepl\__main__.py --port COM4 async-repl --control-file C:\Users\30901\AppData\Local\Temp\vscodemicropython\mpyrepl-COM4.json
>>> a
3

- 3. `Ctrl-]` 应该是退出,但没反应
~
- 安装完扩展并重启后,开发板操作项小图标的repl项正常应该是用于打开repl,但默认状态确实关闭repl ,并且按下后无效,按下面的open repl也无效
~
- 安装后功能还是停止,应该需要是打开repl才对,截屏了,看"E:\now\屏幕截图 2026-05-30 160428.png", 但这次点了后提示已关闭repl,但我刚重启repl,状态应该是还没打开才对,再次点击后才打开了repl,也就是重启后要点两下.


-  `Ctrl-D`重启显示有问题:
>>>
OK
MPY: sr>>>

- 我实际是有python环境的,但有时候会弹提示让我安装python,应该是vscode的python环境启动比较慢
~ 
- 应该是好了, CTRL-B 应该和`Ctrl-]`一样也可以退出,其他组合按键参考mpremote文档和https://docs.micropython.org/en/latest/reference/repl.html ,顺便看看按tab自动补全为什么没有,还是因为编译时没带上还是参数?my_custom\boards\ESP32_S3_PET_V3
- 我在编辑窗口粘贴时经常回卡住显示显示正在运行粘贴处理程序,单击可取消并进行基本粘贴,是你扩展有使用这个功能吗?理论上说即使使用应该也是终端有效才对,之所以怀疑是mpy扩展的问题是,我mpy扩展是工作区安装,其他工作区没有安装这个扩展,就没有这个问题
~
- 由于没有自动tab补全或其他功能,导致无法在repl定义函数,写完定义在回车就直接执行了,于是直接报错
>>> def f():
Traceback (most recent call last):
  File "<stdin>", line 2
SyntaxError: invalid syntax
>>>
~


- 另一个llm模型给的改进建议,逐个核实并根据实际情况研判判断哪些有改进的必要,那些不一定要改或者哪些需要二次确认的,先进行询问和确认
Python 侧问题
1.[中] follow 超时是硬上限,静默 >10s 的命令会杀死整个会话。 follow 里 read_until(b"\x04", timeout=10) 把 10s 当"字节间最大间隔",time.sleep(20) 这类静默长任务会超时 → TransportError 冒泡出 run_async_repl → 进程退出(main 返回 2)。普通中断(控制文件)没问题(设备会回 KeyboardInterrupt+\x04),但合法长任务会误杀。建议:执行态 follow 用 timeout=None 无限等,靠控制文件 interrupt 当逃生口;或捕获执行期 TransportError 后保活会话(重新对齐 raw 提示符)而非退出。

2.[中] 多行只认"行尾冒号"。 ReplInputBuffer.consume_line 仅当首行 endswith(":") 才累积。括号续行(x = [ / f()、反斜杠续行、三引号字符串都会被当完整行直接提交 → 设备 SyntaxError。建议按计划用"尝试 compile / 括号配平"判断完整性。

3.[低] read_until 对单字节终止符 \x04 仍会 emit 给 consumer。 safe_limit = len(data) - max(0, len(ending)-1) 对 1 字节 ending 退化为不保留 → \x04 照样写进 stdout(多数终端不可见但不正确)。应在追加新字节后先判 endswith 再决定是否 emit。

4.[低] __mpy_repl_helper.last_non_none_repl_value 是死状态(写了从不读,实际用的是全局 _)。可删,减少设备命名空间污染。

5.[低] run_async_repl 控制流偏绕。 apply_pending_action 在三处被检查 + 散落的 input_buffer.reset(),可读性差。建议把"待处理动作 + 缓冲重置"收敛成一个小辅助函数/状态机。

6.[低] instrument_source 的 unparse 会让 traceback 行号偏移;已有 SyntaxError → 原样返回 兜底,基本可接受,文档记一笔即可。

vendoring / 打包
7.[中] pyserial 没 vendoring。 _vendor 里有 prompt_toolkit-3.0.52 / pygments-2.20.0 / wcwidth-0.7.0(都带 dist-info+license),但没有 serial。自定义 REPL 实际靠系统/mpremote 装的 pyserial。通常都在,但与"全部 vendoring"的决策不符,是隐式依赖。建议:要么把 pyserial 也 vendor,要么 bootstrap/启动时显式校验 import serial 并给清晰报错。

8.[低] 缺 _vendor/VENDOR.md(版本号已体现在 dist-info 目录名,但计划要求的来源/许可汇总文件没见到)。补一个便于审计与合规。

9.[低] prompt_toolkit/pygments 整包 vendoring(含 contrib/telnet、ssh、widgets、progress_bar 等用不到的子包),体积偏大。计划 Phase 2 的裁剪可排上。

扩展 TS 侧
10.[中] 自定义 REPL 不传 --baudrate,永远 115200。 buildCustomReplCommand 只传 --port/--control-file,无视 microPythonWorkBench.baudRate 配置。非 115200 设备会连不上/乱码。应把配置 baud 传进去。

11.[低] 自定义控制分支抛错未兜底。 serialSendCtrlC/stop 的 await sendCustomReplControl(...) 无 try/catch,写文件失败会变未处理拒绝;softReset 自定义分支在 try 内,但 catch 后会 fall through 到 mpremote connect ... reset——此时串口被自定义 REPL 占着,reset 必失败。建议自定义分支失败时给明确提示,而非落到会冲突的 mpremote 路径。

12.[低] 控制文件启动竞态。 Python 端 channel.prepare()(删文件)在进程起来、进 raw、注入 helper 之后才跑;启动那一小段内扩展发的控制命令会被 prepare() 删掉丢失。概率低,记一笔。

13.[低/架构] mpremoteCommands.ts 近 900 行、职责过载(终端管理 + mpremote 命令 + 自定义 REPL 启动/控制 + auto-suspend/restore + robustInterrupt + 路径映射委托)。建议把自定义 REPL 相关(buildCustomReplCommand/sendCustomReplControl/clear*/resetCustomReplState/状态变量)抽到独立模块如 board/customRepl.ts,降低耦合、便于测试。

测试
14.[中] 完全没有测试。 计划 section 10 的 Python/TS 测试都没落地。建议优先给纯逻辑加单测(不需要真机):Utf8StreamDecoder(分包)、instrument_source(表达式/语句/多语句/语法错误兜底)、consume_line(多行判定边界)、FileControlChannel.read_next(序列单调/非法 payload)、raw_paste_write(用假串口验证窗口流控)。

优先级建议
先修:#1(长任务杀会话)、#10(baudrate)、#7(pyserial 依赖兜底)——这三个是真用户会撞到的。
再补:#2(多行完整性)、#14(单测)。
整理:#13(TS 拆模块)、#5(async 控制流)、#3/#4/#8 顺手清。

- 写了一个关于tab 和自动缩进的plan[E:\xm\github\github\VScodeMicroPython\qzplans\qzplan_mpy_repl_tab_completion_20260530_v1.md],看看有没有什么问题或哪些地方建议改进的
~
- 在自动缩进内部按方向上键时应该是光标上移而不是执行历史命令补全,但现在是执行历史命令补全了,这个应该是个bug,导致多行编辑时根本就没法编辑之前的代码
- 确实还差不少补全是没有的,应该是可以参考thonny 或其他带代码补全和高亮的工具的功能,或者直接参考最新python这最新版本是带补全和高亮的参考mpy 文档和源码确定有哪些默认补全的,继续完善和打磨体验
比如range没有补全,sys没有等
- 没import的库补全是否合理要考虑一下,能否解决比如socket还没import就有补全导致误判报错,不过这属于低优先级
>>> socket
Traceback (most recent call last):
  File "<stdin>", line 1, in <module>
NameError: name 'socket' isn't defined
~
- 现在方向键历史补全完全失效了,方向键历史补全是不是应该是补全一个代码块呀,而不只是补全一行,比如我先定义了一个函数,想要修改一点功能,这时候按上键应该是把整个函数都补全出来,而不是只补全一行,不然就只能恢复一个函数定义但没有内容

- 这个repl功能已经比较复杂和全面了,是不是应该有完善的测试呀,要不然任意出现修了bug出现新bug

- 配置了com口后,回自动连接开发板,但板子内的文件不会自动刷新

~ 
- 历史功能还是完全不对,设计逻辑也是完全不对,应该是处于新代码块时按方向键混动历史,开始编辑后就不应该启用历史功能了,现在现象是新代码块内按方向键没反应,好好仔细检查一下
- 把尽可能多的功能都加入测试,并且在运行.\build.ps1脚本时除了测试js也测试py,并且github流水线也加入py测试内容
- 有个旧问题,打开串口后无法关闭,并且开发板操作列表的还是开口串口而没有在打开串口后变成关闭串口
~
- 切一轮 DTR/RTS 之后恢复是不对的,这根本就没有这个功能,我合适usb cdc串口没有复位功能,刚刚是我手动复位了设备,应该是哪里出问题了,别继续在错误的道路上狂奔了
~ 
- 按方向键补全历史功能现在依然是完全失效的,确认一下python是不是被正确打包到了最新包内,我现在安装的是0.3.74版本
- 你py测试不能模拟键盘进行测试的吗?
- 你py测试覆盖率是多少需要显示出来,并且让覆盖率尽可能高
~
- 历史功能能工作了,可以尝试继续拉高py的测试覆盖率
- 同时也可以看看js能不能显示测试覆盖率,并尝试拉高
- github流水线报错了,是不是没装依赖

~
- 这个workbench.desktop.main.js:sourcemap:442   ERR [WebForks.mpy]: The 'css' contribution point is proposed API
这是什么问题详细分析一下
- 代码块运行会出现不合理超时,不应该假设代码多久内就会返回吧
>>> import time
>>> time.sleep(60)
Traceback (most recent call last):
TimeoutError: timed out

- 可以参考thonny 添加一个连接后同步设备时钟的功能
- 现在运行报错了:
>>> 1
Traceback (most recent call last):
  File "c:\Users\Administrator\.vscode\extensions\webforks.mpy-0.4.6\scripts\mpyrepl\__main__.py", line 954, in <module>
    sys.exit(main())
             ~~~~^^
  File "c:\Users\Administrator\.vscode\extensions\webforks.mpy-0.4.6\scripts\mpyrepl\__main__.py", line 896, in main
    return run_repl_client(args.endpoint, args.token)
  File "c:\Users\Administrator\.vscode\extensions\webforks.mpy-0.4.6\scripts\mpyrepl\repl_client.py", line 238, in run_repl_client
    result = client.call("repl.exec", {"source": source})
  File "c:\Users\Administrator\.vscode\extensions\webforks.mpy-0.4.6\scripts\mpyrepl\repl_client.py", line 97, in call
    raise RuntimeError(str(error.get("message") or "manager request failed"))
RuntimeError: ReadFile failed (PermissionError(13, '设备不识别此命令。', None, 22))

[mpyrepl] REPL client exited with code 1. Terminal kept open for diagnostics.
PS C:\qzrobot\mpy> (Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned) ; (& c:\qzrobot\mpy\.venv\Scripts\Activate.ps1)

Pylance found a large number of source files in this workspace. Adding exclude paths may improve performance.