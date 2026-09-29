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
