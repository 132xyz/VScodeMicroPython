
增加自动构建工作流

发布到扩展插件市场内

详细分析此vscode扩展C:\qzrobot\mpy\VScodeMicroPython代码,分析以下问题,先不改代码,先详细全面阅读代码,分析程序运行逻辑,如果确定方法,最后给出一个完整的面向你自己修改代码的详细工作列表,具体要修改哪些代码有哪些注意事项




log.ts:460   ERR [Extension Host] [CodeCompletion] Failed to restart Pylance: Error: command 'python.analysis.restartLanguageServer' not found
    at lZe.n (vscode-file://vscode-app/c:/Users/Administrator/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/workbench/workbench.desktop.main.js:1348:3890)
    at lZe.executeCommand (vscode-file://vscode-app/c:/Users/Administrator/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/workbench/workbench.desktop.main.js:1348:3822)
error @ log.ts:460
error @ log.ts:565
error @ logService.ts:51
Uxs @ remoteConsoleUtil.ts:58
$logExtensionHostMessage @ mainThreadConsole.ts:38
S @ rpcProtocol.ts:458
Q @ rpcProtocol.ts:443
M @ rpcProtocol.ts:373
L @ rpcProtocol.ts:299
（匿名） @ rpcProtocol.ts:161
C @ event.ts:1212
fire @ event.ts:1243
fire @ ipc.net.ts:652
l.onmessage @ localProcessExtensionHost.ts:385
console.ts:139 [Extension Host] [CodeCompletion] Failed to restart Pylance: Error: command 'python.analysis.restartLanguageServer' not found
    at lZe.n (vscode-file://vscode-app/c:/Users/Administrator/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/workbench/workbench.desktop.main.js:1348:3890)
    at lZe.executeCommand (vscode-file://vscode-app/c:/Users/Administrator/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/workbench/workbench.desktop.main.js:1348:3822)