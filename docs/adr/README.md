# 架构决策

ADR 记录重要边界的背景、取舍和后果，当前行为由 [功能规格](../spec/README.md)描述。记录状态不证明某次测试通过或某版本已发布。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| 0001 | [V1/V2 产品数据隔离](0001-product-data-isolation.md) | 已采用，补录现有实现 |
| 0002 | [团队资产按归属更新并保留冲突](0002-owned-team-asset-updates.md) | 已采用，补录现有实现 |
| 0003 | [特权操作由主进程持有](0003-electron-operation-ownership.md) | 已采用，补录现有实现 |
| 0004 | [Runtime 调用与原生会话分开记录](0004-runtime-invocation-ledger.md) | 已采用，补录现有实现 |
| 0005 | [Workflow 恢复绑定现场证据](0005-workflow-recovery-evidence.md) | 已采用，补录现有实现 |
| 0006 | [长期记忆按目录明确启用](0006-directory-memory-opt-in.md) | 已采用，补录现有实现 |
| 0007 | [团队会话内容块与分享归属分离](0007-team-session-blocks.md) | 已采用，当前开发分支 |
| 0008 | [团队分享复用本地会话索引](0008-team-session-local-index.md) | 已采用，当前开发分支 |

新增记录包含：状态、背景、决策、影响、考虑的替代方案、关联规格和实现。编号不复用；废弃决策保留并指向替代记录。只在进程边界、数据归属、持久化兼容或团队冲突策略发生重要变化时新增或修订，不为每次修复创建 ADR。维护规则见 [文档约定](../AGENTS.md)。
