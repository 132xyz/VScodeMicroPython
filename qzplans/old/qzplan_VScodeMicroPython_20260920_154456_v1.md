# CI Python 测试挂起修复

## 目标与授权
- 用户已要求修复. 本计划记录已授权实施范围, 不重复请求确认.
- 实时输出用例, 有界失败并保留线程堆栈, 定位 CI 挂起. 不操作设备或替换扩展.

## 现状与边界
- CI 六个任务使用 Python 3.11, 均停在 Python 测试. 本地 3.12 的 276 项约 26 秒完成.
- run_with_coverage.py 使用 StringIO 延迟输出; 异步测试有无限等待路径; workflow 没有步骤级超时.
- 尚未确定具体挂起用例. 不盲目修改 manager 的取消或串口行为.
- 未发现本范围内的人类代码保护标记; 保持现有 unittest/trace 结构, 不重构运行时代码.

## 实施
1. 测试入口增加标准库 faulthandler watchdog, 单例默认 60 秒, 整套默认 300 秒. 使用真实 stderr 输出用例和超时堆栈, 超时进程非零退出, 包含 teardown.
2. 增加子进程回归验证正常完成、测试挂起、清理挂起、总预算及无效配置. 不依赖设备.
3. CI Python 步骤 10 分钟兜底, 实时日志. 保持 Python 3.11, 不通过升级掩盖问题.
4. 尝试 3.11 环境复现, 有证据后仅修具体失败用例的等待及清理.
5. docs/TEST_README.md 更新诊断和超时说明.

## 验证与交付
- npm run test:py, 故意挂起子进程测试, npm run compile, npm run test:js:coverage.
- Python 3.11 不可用时如实记录. CI 远端通过需重新推送后确认.
- 本次为 CI/测试修复, 不需要安装 VSIX, 不自动提交或推送. 新临时环境由 uv 缓存管理, 不加入 Git.

## 定位与实施记录
- 对比 b1d4df2 与 cace947: 后者新增 manager/output_queue.py, worker 使用 while True.
- Python 3.10 实际复现 test_server_dispatches_requests_and_shutdown 挂起, asyncio task 栈显示 close 等待 worker, worker 停在 queue.get. 3.12 未复现.
- wait_for 的完成/取消竞争可吞掉 worker.cancel. 将循环条件改为 not self.closed, 不改变正常输出次序或串口协议.
- 新确定性回归测试在旧实现失败, 新实现通过. 3.10 manager 22 项通过.
- 因涉及实际运行时修复, 使用 build.sh patch 发布新包, 但不安装或替换用户扩展.
- 完成: build.sh patch 生成 release/mpy-0.4.44.vsix, TypeScript 编译、132 项 JS、281 项 Python 3.12 测试通过, Python 覆盖率 86.9%.
- Python 3.10 全套 281 项约 32 秒完成, 其中一项可选 VT100 验证因缺 pexpect 跳过; Python 3.12 全部约 28 秒完成.
- 3.11 下载超时, 未完成该版本或远端 CI 验证. 已确认 VSIX 内含运行时修复. 无设备操作、自动安装、提交或推送.
