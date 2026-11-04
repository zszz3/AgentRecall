# ADR 0021：V2 移除 Workflow，升级时删除其数据

## 状态

已采用，适用于 V2。替代 [ADR 0005](0005-workflow-recovery-evidence.md) 与 [ADR 0016](0016-team-workflow-templates.md)，并修订 [ADR 0018](0018-team-outcomes.md) 中由 Workflow 运行生成成果草稿的部分。

## 背景

V2 的 Workflow 包括图编辑器与规划对话、DAG 执行器、脚本授权、工作区事务与恢复、运行记录与产物、计划任务、内置 workflow MCP 及其 `agent-recall-v2-workflow-mcp` 命令、团队 Workflow 模板和由运行生成的成果草稿。它是 automation 中状态与测试面最大的部分，同时牵动 PostgreSQL 表、辅助状态 JSON、增量变更协议、MCP 工具和团队清单格式。产品方向收敛到会话、Agent、Eval、Skill 库与团队资产，Workflow 不再作为产品能力维护。

Eval 与 Skill 探索复用了 Runtime 中原本为 Workflow 节点建立的一次性执行路径；调用记录与原生会话也以 `workflow` 场景标记了历史调用。

## 决策

- 删除 Workflow 编辑器、执行器、事务与恢复层、计划任务、Tasks 与 Artifacts、内置 workflow MCP 与 `agent-recall-v2-workflow-mcp` 命令，以及非 Gateway 的 V2 MCP 工具服务。对外工具只经 [MCP Gateway](../spec/mcp.md) 提供。
- PostgreSQL 迁移 62 删除 `workflow_artifacts`、`workflow_node_runs`、`workflow_runs` 与 `workflows` 表，并从辅助状态 JSON 中删除 `workflowStore`、`scheduledWorkflowStore` 与 `workflowNodeConversations`。数据不导出。迁移只向前执行，不支持降级到仍有 Workflow 的版本。
- Runtime 的一次性执行场景从 `workflow` 改名为 `oneshot`，继续供 Eval、Skill 探索和配置测试使用。调用记录与会话筛选保留历史 `workflow` 场景值，旧调用照常可读、可按该分类筛选。
- 持久化载荷中残留的 Workflow 字段在加载时被忽略，保存时不再写出。
- workspace-core 不再把 Workflow 模板作为团队资源：版本 6 清单与快照中的 `workflowTemplates` 在读取时丢弃，下次写出清单时删除，仓库中的 `workflows/*.json` 文件保持原样；`OWNERS.json` 中引用 `workflowTemplates` 的资源在读取时丢弃，只剩该资源的规则一并丢弃。清单版本不变。
- 成果来源保留 `workflow-run` 作为可读可编辑的历史值，避免早期记录使整份团队快照无法读取；界面只新建 `manual` 来源，不再从运行生成草稿。

## 影响

- 升级后已有 Workflow 定义、运行记录、产物和计划任务被删除，且无法恢复；由 Workflow 发起的会话与调用记录保留。
- 降级到移除前的版本时，相关表与辅助状态已不存在，旧版本中的 Workflow 页面为空或无法恢复运行；V2 是预览版，不提供该方向的兼容。
- 团队仓库中已有的模板文件与清单条目不会被自动清理成单独提交；任何成员下一次写出清单时条目被删除，文件需在仓库中手动删除。旧客户端读取新写出的清单时看不到模板，不影响其他资源。
- 依赖 Workflow 的多 Agent 编排不再提供；Runtime、Agent、Eval 与 Gateway MCP 的契约不变。

## 考虑的替代方案

- 用功能开关隐藏入口：执行器、事务层、迁移与协议仍需随每次改动维护和测试，入口隐藏也不能阻止数据与 MCP 工具继续存在，未采用。
- 保留数据表只删除功能：表中数据既无入口查看也无法运行，长期占用迁移与测试面，并让“降级可恢复”成为隐含承诺，未采用。
- 保留团队模板格式与校验：模板依赖的节点模型已不存在，校验无法再证明模板可用；只在读取时忽略可以保证旧仓库继续可读，未采用完整保留。

## 关联

[Runtime 规格](../spec/runtime.md)、[MCP 规格](../spec/mcp.md)、[团队资产规格](../spec/team-assets.md)、[PostgreSQL 迁移](../../apps/main-2.0/src/core/postgres/schema.ts)、[清单格式解析器](../../packages/workspace-core/src/asset-format.ts)、[审核规则](../../packages/workspace-core/src/review-rules.ts)、[成果格式](../../packages/workspace-core/src/outcomes.ts)。
