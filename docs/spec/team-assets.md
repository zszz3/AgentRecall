# 团队资产

范围：V2 团队空间、CLI 及 workspace-core 的当前实现。V1 没有团队空间或 Turn 分享入口。本文不表示团队功能已进入稳定发布；用户操作、资源目标路径和大小上限分别由 [团队空间指南](../v2/team-workspace.md)、[资产格式指南](../v2/team-assets.md)和 [CLI 指南](../v2/cli.md)维护。

## 资源与范围

- 团队连接 GitHub 资产仓库；一个团队可启用多个本地工作目录，并为目录选择 Codex、Claude Code 或两者。目录无需是 Git 仓库。
- 团队功能默认关闭。连接团队、添加目录或启用开关不代表授权上传个人文件或会话，也不会自动执行同步。
- Git 资产包括 Skills、文档、共享指令、MCP 和公共 Env。清单还兼容 workConfigs；桌面整轮同步不要求安装工作配置。
- 完整会话和 Turn 片段是独立分享快照，通过 GitHub Release 附件传递，不进入资产的 Git 提交历史。个人跨设备 Supabase 同步是另一套能力。

## Pull

拉取默认分支资产快照后，分发到已启用目录中匹配客户端的目标。文件归属和摘要决定是否能更新或撤回：只自动更新本工具管理且未被本地修改的内容；个人同名内容、来源不匹配、损坏记录和链接冲突保留现场。具体冲突策略见 [ADR 0002](../adr/0002-owned-team-asset-updates.md)。

结果按目录和资源记录成功、未变化、冲突或失败；整轮可为部分完成、取消或没有启用目录。取消保留已经完成的写入及备份，不伪装为整轮回滚。停用或断开目录保留已有文件。

Pull 完成仅表示文件分发成功。普通文档不会因此自动被 Agent 阅读；客户端按各自机制加载 Skills、指令和配置。Pull 不执行 Skill 脚本、不启动 MCP、不安装会话 Hook，也不上传会话。

## Push 和会话分享

- Skill、文档、配置或待分享 Turn 都可单独选择。本地 Diff 浏览使用已有缓存；最终预览才核对远端并准备上传快照。
- 预览绑定发起窗口、团队和远端版本，并保存所选内容，十分钟后过期。修改本地文件需要重新预览，不能在确认后暗中替换输入。
- 提交前重新验证上下文、权限和版本。远端变化时拒绝覆盖，要求刷新后重新预览。Push 不自动分发到本地目录。
- 选中的 Git 资源在同一提交中发布；会话附件独立发布。因此混合 Push 可能部分成功，必须按项报告。取消和未确认的远端结果不能报成功，也不能盲目重复上传。
- Turn 分享只打包选择的轮次及其消息、工具记录和可读取附件，不退回整条会话上传。完整会话分享另有明确的预览确认流程。
- 分享不自动脱敏。公开和私有仓库均可使用，预览与确认说明可见范围；分享撤回不能删除成员已经下载的副本。

## 接口与所有权

| 模块 | 责任 |
| --- | --- |
| [workspace-core](../../packages/workspace-core/src/team-assets.ts) | 清单和快照校验、Git 资产操作、安装归属和配置兼容；不依赖 Electron |
| [Pull 分发](../../packages/workspace-core/src/team-pull.ts) | 目录生命周期、安装锁、写入前复核、逐项结果 |
| [桌面服务](../../apps/main-2.0/src/main/services/team-workspace-service.ts) | 桌面操作生命周期和团队上下文 |
| [Push 服务](../../apps/main-2.0/src/main/services/team-push-service.ts) | 所选项预览、窗口归属、确认和结果 |
| [会话分享服务](../../apps/main-2.0/src/main/services/team-session-sharing.ts) | 从本地索引准备分享快照、附件和撤回 |
| [IPC 契约](../../apps/main-2.0/src/shared/ipc/team-workspace.ts) | Renderer 请求边界；renderer 不直接访问文件系统或 Git |

## 格式与当前限制

资产清单目前读取版本 1–4：依次增加工作配置、文档和共享配置；新资源写入遵循显式升级，不静默忽略未知版本。配置、归属记录、Pull 报告和会话包分别有自己的版本，不能统一解释为“团队版本”。字段、限制和兼容细节以指南及 [格式解析器](../../packages/workspace-core/src/asset-format.ts)为准。

CLI 会话分享、自动会话启动同步、桌面贡献 PR 流程尚未提供。Git 推送成功不代表远端客户端已拉取；缓存保存失败与远端提交失败必须区分。

## 验证入口

[整轮 Pull](../../apps/cli/test/team-pull.test.ts)、[资产安装](../../apps/cli/test/team-assets.test.ts)、[共享配置](../../apps/cli/test/team-configuration.test.ts)、[桌面 Push](../../apps/main-2.0/src/main/services/team-push-service.test.ts)、[会话分享](../../apps/main-2.0/src/main/services/team-session-sharing.test.ts)和 [IPC](../../apps/main-2.0/src/main/ipc/team-workspace.test.ts)是相关测试入口。只使用临时 HOME、合成仓库和模拟远端；这些测试不等同于真实两名成员联调或真实上传验收。

## Push 输入与响应模型

[TeamPushItem](../../apps/main-2.0/src/shared/team-push.ts)是三种明确输入，不接收任意目录打包指令：

| kind | 关键输入 | 服务端需要再次核对 |
| --- | --- | --- |
| resource | skills/documents、connectionId、directory、file、资源 id | 目录连接、真实路径、可读取内容与目标资源身份 |
| turn | sessionKey、turnId | 会话与轮次归属、实际消息及附件 |
| configuration | 通过 schema 的 change | 资源类型、当前清单版本、目标冲突 |

Preview 返回 token、expiresAt、repository 和逐项 Diff，状态为 added/modified/unchanged。发布结果逐项返回 published/unchanged/failed/cancelled；不能只返回一个全局布尔值覆盖混合结果。

条目的本地 key 用于关联 UI 选择和结果，不是服务器授权；Renderer 传来的路径、id、revision 和 token 都需要在实际操作边界校验。

## 操作状态与清理

| 阶段 | 可做的操作 | 失效条件 |
| --- | --- | --- |
| 待上传清单 | 勾选、移除、逐项查看本地 Diff | 列表刷新后内容需重新核对 |
| 正式预览准备 | 读取远端版本，冻结所选内容 | 取消、输入错误或上下文变化 |
| 有效预览 | 确认发布或丢弃 | 十分钟过期、窗口关闭、团队变化 |
| 发布执行 | 按预览内容发布并记录每项结果 | 不能在过程中替换成新选择 |
| 发布结束 | 移除成功项，保留失败/取消项供核对 | 远端不确定结果需要先核实 |

这是一张产品阶段表，不是新增的持久化枚举。当前预览由主进程服务持有，窗口 owner 检查和 timer 清理不可只放在 React。关闭应用后未发布草稿不保证恢复。

## IPC 操作边界

[team-workspace 契约](../../apps/main-2.0/src/shared/ipc/team-workspace.ts)采用 action 区分请求：push-inspect 只返回单项检查；push-preview 准备所选项；push-publish 接受已有 token；push-discard 丢弃预览。Reply 用 ok 区分成功 payload 和 code/message/details 错误。

同一接口仍兼容旧 project scope。新桌面导航以团队和工作目录为中心，不应因为类型里仍有 projectId 就重新要求用户创建真实 Git 项目。

上限在 schema、完整序列化输出和后端操作中共同校验。具体数值由 [团队空间指南](../v2/team-workspace.md)维护；列表显示省略和实际上传大小不能共用同一个截断函数。

## 归属与冲突矩阵

| 本地情况 | Pull 处理 |
| --- | --- |
| 尚未存在目标 | 准备受管安装并记录归属 |
| 同团队、受管且未修改 | 更新或判定 unchanged |
| 个人同名文件，哪怕正文相同 | 不自动接管所有权 |
| 用户修改了受管内容 | 报冲突，保留本地修改 |
| 同名内容属于其他团队 | 报来源冲突 |
| 清单移除未修改的受管资源 | 按类型退役并保留需要的备份 |
| 新资源更新已有冲突 | 相关待退役旧副本暂保留，避免新旧都不可用 |
| 归属损坏、链接或不支持版本 | 停止受影响写入并报告原因 |

这不是通用 Git merge 策略；对受管 Markdown 区块、JSON 键、Skill 目录各有具体安装算法。修改冲突策略必须同时检查这三类路径。

## 验收场景

| 场景 | 应观察到的结果 |
| --- | --- |
| 仅开启团队或接入目录 | 不上传个人内容，不隐式 Pull |
| 查看多项本地 Diff | 不为每次点击重复克隆远端，仍可切换选择 |
| 预览后修改本地 Skill | 发布原快照，重新预览才使用新内容 |
| 预览后远端分支变化 | 发布拒绝覆盖，提示重新核对 |
| 另一窗口提交 token | 所有权校验拒绝 |
| 同名个人 MCP/Env | 不静默覆盖 |
| 取消跨目录 Pull | 保留已完成变更，后续项标注取消 |
| Git 资源成功、会话附件失败 | 返回部分结果，重试不重复发布已成功项 |
| Turn 已不属于所选会话 | 拒绝，不退回整条会话上传 |
| 公开仓库分享 | 允许，但明确可见范围和上传内容 |

验收应区分合成服务测试、组件交互验证和真实仓库联调。没有真实上传证据时不能称“团队分享全链路已验收”。
