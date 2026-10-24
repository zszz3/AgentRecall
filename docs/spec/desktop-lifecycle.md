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

V2 本地会话索引线程和内置 PostgreSQL 由下述独立后台持有。重复刷新仍由索引协调器合并；线程完成数据库写入并关闭本轮连接后返回最终结果，桌面收到结果后发布完成状态。线程崩溃使当前请求失败，下次刷新可重建线程。桌面退出关闭自己的连接池并释放租约，不再启动索引后的远端任务。后台自身关闭时先等待活动请求，再终止索引线程、关闭连接池、停止自己管理的数据库。

## V2 常驻搜索后台

当前 checkout 的 V2 CLI 和 Gateway MCP 可在 Dock「退出」或 ⌘Q 完全结束 Electron 后搜索与读取本机会话。它们启动纯 Node 的 [session-backend-entry](../../apps/main-2.0/src/main/session-backend-entry.ts)，不会启动桌面、模型或自动化服务。范围及操作见 [CLI 指南](../v2/cli.md#无窗口本机会话检索)。V1 不使用这个后台。首版不注册开机或登录自启项；可以通过桌面、检索或 backend start 启动。

后台沿用 V2 userData、PostgreSQL 和本地增量索引。启动后持续运行，不因闲置、桌面退出或 MCP 客户端断开而退出；由手动停止、更新/卸载、进程终止或系统关闭结束。桌面未连接时沿用十分钟周期刷新本地索引，搜索与读取前仍立即补齐；桌面连接时使用原桌面刷新周期，后台不重复扫描。周期任务不与活动请求或索引重叠，关闭前等待已启动的扫描结束，不在退出后重新排队。桌面每三十秒续租，租约九十秒过期；正常退出仅释放自己的租约。后台丢失后重连若数据库连接改变，桌面提示重启。

[Host](../../apps/main-2.0/src/main/session-backend-host.ts)在数据库创建前获取 owner 锁，并持有到清理完成。客户端使用另一个启动锁合并冷启动。`session-backend.json` 原子发布协议版本、PID、回环端口、随机 token、安装路径和应用版本；POSIX 权限为 0600。只接受认证 POST，输入最多 32 KiB，完整输出最多 1 MiB。设置损坏、认证失败或业务失败不会被解释为后台不存在并另起一个实例。

终端 backend start 显式启动或复用后台，底层复用 status 请求；status/stop 不会冷启动后台。状态、搜索、读取、刷新、桌面 attach/release 和停止分别对应 `/session/{status,search,get,refresh,attach,release,stop}`。attach 返回的连接串仅供桌面内部使用，公开状态不包含凭据。停止命令在桌面持有租约或请求/索引进行中时返回冲突；成功必须等待旧 PID 退出及发现文件清理，不能只收到确认就报告关闭完成。

升级或卸载先等待桌面退出，再持有启动锁停止后台并等待关闭；后台忙时中止操作。持锁期间禁止另一个客户端冷启动。旧桌面没有租约机制，检测到仍运行时拒绝后台启动；不同版本或安装路径拒绝执行搜索、读取和 attach，但允许状态与停止命令。外部数据库不由后台停止。进程所有权取舍见 [ADR 0012](../adr/0012-on-demand-session-backend.md)。

验证：[Host 生命周期测试](../../apps/main-2.0/src/main/session-backend-host.test.ts)、[客户端并发/维护测试](../../apps/main-2.0/scripts/session-backend-client.test.mjs)、[桌面租约测试](../../apps/main-2.0/src/main/session-backend-client.test.ts)、[真实 Node/PostgreSQL 隔离验收](../../apps/main-2.0/scripts/session-backend-smoke.mjs)。

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

V1/V2 的终端安装器订阅相同的进度事件，显示下载字节数、速度、校验、备份、依赖安装和运行时准备阶段；下载输出限频，等待期间每五秒输出当前阶段及累计时间。阶段提示不代表该阶段已完成。

安装包请求等待响应和读取响应体分别计时：默认连接等待及连续无数据上限均为三十秒，最多尝试三次。中断后的请求携带已写入字节的 Range；仅接受匹配偏移的 Content-Range，服务器返回完整响应时清空旧内容重新下载。成功必须通过完整 SHA-256 校验；校验失败、无效范围和永久 HTTP 错误不会被重试掩盖。续传只限同一次更新调用，退出后不保留跨次续传缓存。

Electron 验证仅读取路径和版本文件，并执行二进制版本探测，不加载可能自动启动下载的 Electron 模块入口。缺失运行时优先从匹配版本的旧包备份及下载缓存恢复。V2 的主下载源尝试最多等待一分钟，再尝试现有备用镜像；显式安装子进程持有超时，进度继续显示当前阶段。

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
