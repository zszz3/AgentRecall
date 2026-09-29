# 桌面启动、退出与应用更新

范围：V1/V2 Electron 主进程的后台启动工作和更新流程。两版使用各自服务和安装身份；下文以 V2 类型说明状态，修改共同行为时同时检查 V1。安装命令和通道规则由 [安装指南](../../Install.md)及 [贡献指南](../../CONTRIBUTING.md)维护。

## 启动任务所有权

窗口出现不代表后台索引、工具服务和更新检查全部完成。可延后的启动工作通过调度器持有计时器，并在退出开始后拒绝触发任务。

[StartupTaskScheduler](../../apps/main-2.0/src/main/startup-tasks.ts)提供：

| 接口 | 语义 |
| --- | --- |
| schedule(delayMs, task) | 延时调度，保存 timer 以便取消 |
| whenSettled(promise, task) | 当前实现是在 promise resolve 后运行，并再次检查退出状态 |
| cancelAll() | 清理尚未触发的 timer；不终止已经运行的任务 |

方法名 whenSettled 不表示 reject 后也会运行任务；不能仅凭名称推断 finally 语义。已启动任务的停止仍由其服务负责。调度器本身也不替业务任务吞掉和展示所有异常。

## 退出顺序约束

退出先阻止新任务，再取消未触发的启动工作，随后由拥有进程、watcher、数据库和运行任务的服务清理资源。V2 Eval 需要取消并等待活动执行，Runtime 驱动需要关闭其子进程，窗口归属的团队预览需要失效。

renderer 卸载不能代替 main-process 清理；反过来，离开一个页面也不应无条件终止产品明确允许后台运行的任务。

## 更新对象

[AppUpdateStatus](../../apps/main-2.0/src/core/app-update-types.ts)包含 currentVersion、developmentBuild、checkedAt、fromCache、updateAvailable、manifest 和 error。缓存结果与刚刚联网检查不同；error 非空不能解释为已经确认没有更新。

Manifest 包含版本、tag、发布时间、发布链接、说明和包下载/校验信息；完整格式由解析器校验。V1 Latest 与 V2 v2-latest 不能混用。

## 检查和安装

[AppUpdateService](../../apps/main-2.0/src/main/services/app-update-service.ts)区分开发模式与发布运行环境：开发环境不提供安装更新。普通检查遵守自动检查设置和缓存；强制检查有明确入口。

安装启动返回 `{ started, version }`，不是最终完成结果。重复安装请求复用活动安装状态，不启动多个竞争安装任务。流程先 stageInstaller，再启动独立安装器，然后请求旧应用退出。

| 进度阶段 | 含义 |
| --- | --- |
| checking | 获取和校验更新信息 |
| downloading / verifying | 下载并验证包 |
| staging / validating | 准备候选安装并验证 |
| restarting | 安装切换/重新启动流程正在进行 |
| completed | 安装流程报告完成 |
| error | 保留失败原因和恢复路径 |

这些阶段来自类型契约，不表示每次调用一定发出所有阶段事件。新进程能启动、窗口已出现和用户数据可正常读取仍需相应运行证据。

## 安装与恢复边界

安装器保留 live、stage、backup 的区分。候选提升失败应保留旧包可用，候选 PostgreSQL 验证失败需要恢复旧包；成功安装后的重启失败与包安装失败分别处理，不能将已完成安装误报为应该重复覆盖安装。

操作的是应用包和更新缓存，不是删除用户数据库。测试不得在当前全局 Node 前缀安装/卸载真实包，必须使用临时 HOME、prefix 和合成包。

## 验收场景

| 场景 | 应观察到的结果 | 测试入口 |
| --- | --- | --- |
| 退出先于启动 timer | 后台服务不被再次启动 | [V2 调度测试](../../apps/main-2.0/src/main/startup-tasks.test.ts) |
| 退出先于等待的 promise resolve | 不继续启动任务 | 同上 |
| V1 相同退出路径 | 保留相同计时器清理行为 | [V1 调度测试](../../apps/main-1.0/src/main/startup-tasks.test.ts) |
| 候选包提升失败 | 旧包仍可用 | [V2 安装器测试](../../apps/main-2.0/scripts/apply-update.test.mjs) |
| 候选 PostgreSQL 验证失败 | 恢复旧包 | 同上 |
| 已安装成功但重启失败 | 区分安装完成与启动问题 | 同上 |
| Manifest/通道或校验异常 | 不将错误候选当成有效更新 | [更新客户端测试](../../apps/main-2.0/scripts/update-client.test.mjs) |

跨平台文件替换、权限、进程退出时序需要相应平台验证，Linux 单测不替代 Windows/macOS 包验收。实际耗时和流畅度要测量，启动任务延迟本身不是性能改善证明。
