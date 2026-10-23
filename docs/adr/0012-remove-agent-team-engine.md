# ADR 0012：移除 Agent Team 引擎，加载时忽略历史团队数据

## 状态

已采用，适用于 V2。

## 背景

V2 的 automation 引擎来自上游导入，其中带有一套 Agent Team 执行模式（pipeline、parallel、supervisor），包括团队定义、团队运行步骤和对应的持久化字段（`teams`、`teamRuns`、`activeTeamId`、`activeTeamRunId`）。桌面主进程、preload、renderer 页面和 MCP 工具都不调用这套能力，产品中的多 Agent 编排由 Workflow v2 负责。未使用的引擎仍然参与快照、持久化、Agent 删除引用检查和任务结束回调，增加了状态与测试面。

早期版本保存的持久化载荷（PostgreSQL 辅助状态 JSON 或旧文件存储）中可能已经带有这些团队字段。

## 决策

删除 Agent Team 引擎及其类型、AgentHub 方法、快照字段和恢复逻辑。持久化载荷版本保持 5：载荷校验不再要求团队集合，带有历史团队字段的载荷照常恢复会话、任务、Workflow 和 Agent 配置，团队字段被忽略，并在下一次保存时不再写出。

增量变更协议（`AUTOMATION_CHANGE_PROTOCOL_VERSION`）从未携带团队数据，因此不升级协议版本。完整快照不再包含团队字段。

## 影响

现有用户升级后无需迁移，已有数据照常加载。历史团队定义和团队运行记录在下一次保存后从存储中移除；它们此前在界面中不可见，也无法从产品入口执行。

旧版本的载荷校验要求团队集合存在，因此由本版本保存的数据在降级到旧版本后会被判定为无法完整恢复。旧版本此时保持存储数据不变并以内存默认状态启动，不会覆盖数据；重新升级后数据恢复可见。本决策接受这一降级限制，不为旧版本继续写出空的团队集合。

## 考虑的替代方案

- 保留引擎但不暴露入口：继续承担快照、持久化和删除校验的维护成本，没有产品价值。
- 递增载荷版本并添加迁移步骤：载荷没有结构性转换需求，只是忽略多余字段；新增版本会让旧版本在降级时同样拒绝数据，却增加一条迁移路径。
- 继续写出空的 `teams`/`teamRuns`：仅为旧版本降级服务，属于没有当前消费者的兼容路径。

## 关联

[Runtime 规格](../spec/runtime.md)、[载荷校验](../../apps/main-2.0/src/automation/engine/main/hub/persisted/agent-hub-persisted-migrations.ts)、[AgentHub 持久化测试](../../apps/main-2.0/src/automation/engine/main/hub/agent-hub.test.ts)。
