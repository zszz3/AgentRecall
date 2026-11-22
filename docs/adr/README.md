# 架构决策

ADR 记录重要边界的背景、取舍和后果，当前行为由 [功能规格](../spec/README.md)描述。记录状态不证明某次测试通过或某版本已发布。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| 0001 | [V1/V2 产品数据隔离](0001-product-data-isolation.md) | 已采用，补录现有实现 |
| 0002 | [团队资产按归属更新并保留冲突](0002-owned-team-asset-updates.md) | 已采用，补录现有实现 |
| 0003 | [特权操作由主进程持有](0003-electron-operation-ownership.md) | 已采用，补录现有实现 |
| 0004 | [Runtime 调用与原生会话分开记录](0004-runtime-invocation-ledger.md) | 已采用，补录现有实现 |
| 0005 | [Workflow 恢复绑定现场证据](0005-workflow-recovery-evidence.md) | 已被 0021 替代 |
| 0006 | [长期记忆按目录明确启用](0006-directory-memory-opt-in.md) | 已被 0022 替代 |
| 0007 | [团队会话内容块与分享归属分离](0007-team-session-blocks.md) | 已采用 |
| 0008 | [团队分享复用本地会话索引](0008-team-session-local-index.md) | 已采用 |
| 0009 | [服务商配置使用独立身份](0009-named-provider-configurations.md) | 已采用 |
| 0010 | [资源文件夹独立于安装路径](0010-resource-folder-metadata.md) | 已采用 |
| 0011 | [分开会话搜索与资源搜索](0011-separate-agent-search.md) | 已采用 |
| 0012 | [V2 本机会话检索使用独立常驻后台](0012-on-demand-session-backend.md) | 已采用 |
| 0013 | [移除 Agent Team 引擎，加载时忽略历史团队数据](0013-remove-agent-team-engine.md) | 已采用 |
| 0014 | [团队 Agent 角色只共享定义，不共享渠道](0014-team-agent-roles.md) | 已采用，不再提供“启用到本机” |
| 0015 | [团队资源信任只在本机按内容记录](0015-local-team-trust.md) | 已采用 |
| 0016 | [团队 Workflow 模板引用角色，个人副本记录来源并确认脚本](0016-team-workflow-templates.md) | 已被 0021 替代 |
| 0017 | [按角色筛选工作目录的 Skill](0017-install-skills-by-role.md) | 已采用 |
| 0018 | [运行成果以 Markdown 记录入库，会话全文按 ID 引用](0018-team-outcomes.md) | 部分被 0021 替代 |
| 0019 | [团队资源审核规则与 PR 分流](0019-team-review-routing.md) | 部分被 0020 替代 |
| 0020 | [团队 Git 资源整批审核与清单保护](0020-atomic-team-review.md) | 已采用 |
| 0021 | [V2 移除 Workflow，升级时删除其数据](0021-remove-v2-workflow.md) | 已采用 |
| 0022 | [V2 移除目录 Memory，升级时删除其记录](0022-remove-v2-directory-memory.md) | 已采用 |
| 0023 | [V2 经验卡由桌面主进程从已索引会话提炼](0023-v2-experience-cards.md) | 已采用，渠道选择被 0024 替代 |
| 0024 | [AgentRecall 自己的 AI 任务直接调用用户设置的模型 API](0024-agentrecall-model.md) | 已采用 |
| 0025 | [V2 个人指令写入本机 Agent 的用户级文件](0025-v2-personal-library.md) | 已采用，范围缩小为指令 |

新增记录包含：状态、背景、决策、影响、考虑的替代方案、关联规格和实现。编号不复用；废弃决策保留并指向替代记录。只在进程边界、数据归属、持久化兼容或团队冲突策略发生重要变化时新增或修订，不为每次修复创建 ADR。维护规则见 [文档约定](../AGENTS.md)。
