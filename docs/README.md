# 文档入口

用户使用方式从 [项目 README](../README.md)、[V1 指南](v1/guide.md)和 [V2 指南](v2/guide.md)开始。开发前先读 [AGENTS.md](../AGENTS.md) 和 [贡献指南](../CONTRIBUTING.md)，再按改动范围阅读下列文档。

| 层次 | 解决的问题 | 入口 |
| --- | --- | --- |
| 功能规格 | 当前行为、接口、数据和失败边界是什么 | [spec](spec/README.md) |
| 架构决策 | 为什么选择这个边界，改变它有什么代价 | [adr](adr/README.md) |
| 开发约定 | 修改这个模块时必须遵守什么 | [根 AGENTS](../AGENTS.md)及所属目录的 AGENTS |
| 用户指南 | 如何操作、配置和排障 | [安装](../Install.md)、[团队空间](v2/team-workspace.md)、[团队资产格式](v2/team-assets.md)、[CLI](v2/cli.md) |

规格描述所在代码版本的行为，不代表相关能力已经发布。发布状态以对应产品的 Release 为准。计划、交接和设计草案不作为当前行为的依据；已有计划见 [CLI 团队计划](v2/agentrecall-cli-team-plan.md)，交接记录见 [CLI 交接](v2/agentrecall-cli-handoff.md)。

文档维护规则见 [docs/AGENTS.md](AGENTS.md)。规格与实现不一致时，检查实现和测试后修正文档或代码，不能仅凭旧文档推断运行行为。

## 按开发任务查阅

- 理解整体进程和数据：先读 [架构总览](spec/architecture.md)。
- 修改会话加载或流畅度：读 [索引](spec/session-indexing.md)和[桌面生命周期](spec/desktop-lifecycle.md)。
- 修改执行和结果追踪：读 [Runtime](spec/runtime.md)、[Workflow](spec/workflow.md)及 [Eval](spec/evaluation.md)。
- 修改客户端能力：读 [MCP](spec/mcp.md)与 [Skills](spec/skills.md)。
- 修改目录知识：读 [Memory](spec/memory.md)；团队共享另读 [团队资产](spec/team-assets.md)。

规格中的验收表不是已通过的测试报告；当前覆盖范围和跨模块修改矩阵见 [规格索引](spec/README.md)。
