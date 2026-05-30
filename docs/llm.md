
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
