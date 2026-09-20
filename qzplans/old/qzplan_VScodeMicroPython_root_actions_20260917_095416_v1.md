# 文件树根目录操作入口

状态: 已完成实现、宿主回归与打包,归档后不再编辑. 基线为已有未提交的0.4.40/0.4.41修复,全部保留.
授权: 用户确认目录/文件/标题栏/根节点入口方案后要求 "可以,开始改吧".

目标: 根目录上传和新建无需依赖空白区域右键;右键文件可上传到其所在目录;根节点不显示删除/重命名.
语义: 根目录专用命令明确指设备物理根 `/`,不跟随选中节点或配置rootPath. 现有目录菜单仍跟随其node.path.
非目标: 不修改VS Code原生空白菜单,不改串口/同步/上传算法,不操作设备,不安装或提交.

已检查: package.json上传菜单仅dir;uploadToBoard.ts已支持文件parent及无节点根目录;root anchor目前contextValue为dir;标题栏命令需忽略VS Code可能传入的视图context参数.
相关源码作者未确认,保留原函数和风格,只增加菜单/注册包装和root节点context类型.

文件任务:
- package.json、package.nls*.json: 根目录上传/新建三个专用命令,标题栏及溢出菜单入口,修正item条件并移除无效!viewItem项.
- src/core/extension.ts: 三个根命令以无node参数调用现有操作.
- src/board/esp32Fs.ts: 根anchor context=root,已有删除/重命名guard不改.
- tests: 菜单配置、root无破坏操作、根命令忽略选中对象、file父目录/dir/anchor/无node上传回归.
- README*.md: 说明标题栏/根节点/文件节点入口和物理根语义.

验证: 定向Jest;./build.sh patch;git diff --check;VSIX内容校验. 本次不需要真实串口.
阶段: 菜单和注册 -> 定向验证 -> 文档和完整构建 -> 记录结果.

执行记录:
- 菜单、命令注册、root context和README说明已更新. 标题栏上传使用navigation组,新建命令使用溢出菜单;root节点仍可右键上传/新建/刷新.
- 定向Jest 4 suites / 25 tests通过,覆盖文件父目录上传和根命令忽略传入视图参数. git diff --check通过.
- 正在使用build.sh patch运行完整编译测试和打包;没有设备操作或安装.
- 最终build.sh patch成功: TypeScript编译通过,Jest 30 suites / 132 tests通过,Python 276 tests通过,覆盖率86.9%. 版本0.4.41 -> 0.4.42,产物release/mpy-0.4.42.vsix.
- VSIX压缩完整性通过,package.json/中英文命令文案/编译后的注册代码及树节点代码/中文README与工作树逐字节匹配. git diff --check通过.
- 本次没有连接设备、修改其文件、安装扩展或提交Git. 没有创建一次性工具或待清理样本. 菜单验证为manifest与VSCode mock回归,实际安装后的界面由用户验证.
