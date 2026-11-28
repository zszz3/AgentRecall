# 架构决策

ADR 记录重要边界的背景、取舍和后果，当前行为由 [功能规格](../spec/README.md)描述。记录状态不证明某次测试通过或某版本已发布。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| 0001 | [V1/V2 产品数据隔离](0001-product-data-isolation.md) | 已被 0027 替代 |
| 0002 | [团队资产按归属更新并保留冲突](0002-owned-team-asset-updates.md) | 已采用，补录现有实现 |
| 0003 | [特权操作由主进程持有](0003-electron-operation-ownership.md) | 已采用，补录现有实现 |
| 0004 | [Runtime 调用与原生会话分开记录](0004-runtime-invocation-ledger.md) | 已采用，补录现有实现 |
| 0005 | [Workflow 恢复绑定现场证据](0005-workflow-recovery-evidence.md) | 已被 0021 替代 |
| 0006 | [长期记忆按目录明确启用](0006-directory-memory-opt-in.md) | 已被 0022 替代 |
| 0007 | [团队会话内容块与分享归属分离](0007-team-session-blocks.md) | 已采用 |
| 0008 | [团队分享复用本地会话索引](0008-team-session-local-index.md) | 已采用 |
| 0009 | [服务商配置使用独立身份](0009-named-provider-configurations.md) | 已采用 |
| 0010 | [资源文件夹独立于安装路径](0010-resource-folder-metadata.md) | 桌面端 UI 已由 0028 下线，底层静默兼容 |
| 0011 | [分开会话搜索与资源搜索](0011-separate-agent-search.md) | 已采用 |
| 0012 | [V2 本机会话检索使用独立常驻后台](0012-on-demand-session-backend.md) | 已采用（CLI 已由 0029 改为进程内直连） |
| 0013 | [移除 Agent Team 引擎，加载时忽略历史团队数据](0013-remove-agent-team-engine.md) | 已采用 |
| 0014 | [团队 Agent 角色只共享定义，不共享渠道](0014-team-agent-roles.md) | 桌面端 UI 已由 0028 下线，底层静默兼容 |
| 0015 | [团队资源信任只在本机按内容记录](0015-local-team-trust.md) | 已采用 |
| 0016 | [团队 Workflow 模板引用角色，个人副本记录来源并确认脚本](0016-team-workflow-templates.md) | 已被 0021 替代 |
| 0017 | [按角色筛选工作目录的 Skill](0017-install-skills-by-role.md) | 桌面端 UI 已由 0028 下线，底层静默兼容 |
| 0018 | [运行成果以 Markdown 记录入库，会话全文按 ID 引用](0018-team-outcomes.md) | 桌面端 UI 已由 0028 下线，底层静默兼容 |
| 0019 | [团队资源审核规则与 PR 分流](0019-team-review-routing.md) | 部分被 0020 替代；桌面端 UI 已由 0028 下线 |
| 0020 | [团队 Git 资源整批审核与清单保护](0020-atomic-team-review.md) | 推送路由保留；审核规则编辑 UI 已由 0028 下线 |
| 0021 | [V2 移除 Workflow，升级时删除其数据](0021-remove-v2-workflow.md) | 已采用 |
| 0022 | [V2 移除目录 Memory，升级时删除其记录](0022-remove-v2-directory-memory.md) | 已采用 |
| 0023 | [V2 经验卡由桌面主进程从已索引会话提炼](0023-v2-experience-cards.md) | 已采用，渠道选择被 0024 替代 |
| 0024 | [AgentRecall 自己的 AI 任务直接调用用户设置的模型 API](0024-agentrecall-model.md) | 已采用 |
| 0025 | [V2 个人指令写入本机 Agent 的用户级文件](0025-v2-personal-library.md) | 已废弃，被 0026 取代 |
| 0026 | [V2 资源页只查找和展示，不替用户编辑或同步](0026-v2-resource-catalogs.md) | 已采用（Skills 页已由 0028 升级为控制中心） |
| 0027 | [退役 V1 并合并为统一的 AgentRecall 2.0](0027-unified-v2-product.md) | 已采用 |
| 0028 | [精简团队空间并重构 Skills 控制中心](0028-streamlined-team-space-and-skills.md) | 已采用 |
| 0029 | [将独立 CLI 合并入统一的 `agent-recall` 发布包](0029-unified-cli-in-main-package.md) | 已采用 |
| 0030 | [桌面端模块化分层架构与自动化边界守卫](0030-modular-desktop-architecture-and-guardrails.md) | 已采用（Phase 1 已落地，Phase 2–5 规划中） |
| 0031 | [统一产品后的五层文档体系与 ADR 治理规则](0031-documentation-system-and-adr-governance.md) | 已采用 |
| 0032 | [标准 Streamable HTTP MCP Hub、双暴露模式与多客户端接入](0032-streamable-http-mcp-hub-and-exposure-modes.md) | 已采用 |
| 0033 | [统一使用单引擎本地 SQLite 存储并移除内置 PostgreSQL](0033-single-engine-sqlite-storage.md) | 已采用 |

新增记录包含：状态、背景、决策、影响、考虑的替代方案、关联规格和实现。编号不复用；废弃决策保留并指向替代记录。只在进程边界、数据归属、持久化兼容或团队冲突策略发生重要变化时新增或修订，不为每次修复创建 ADR。维护规则见 [文档约定](../AGENTS.md)。
