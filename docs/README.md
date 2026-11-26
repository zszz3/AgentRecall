# AgentRecall 文档

先按要完成的事情找入口。AgentRecall 2.0 是当前统一的桌面应用与 CLI 产品（详见 [ADR 0027](adr/0027-unified-v2-product.md) 与 [ADR 0029](adr/0029-unified-cli-in-main-package.md)），是否已发布请查看 [Releases](https://github.com/zszz3/AgentRecall/releases)。

## 使用与排障

| 我想…… | 阅读 |
| --- | --- |
| 安装、更新、回滚或卸载 | [安装指南](../Install.md) |
| 上手桌面端，搜索、恢复和迁移会话 | [使用指南](v2/guide.md) · [会话生命周期](v2/session-lifecycle.md) |
| 用命令行启动桌面、诊断环境、同步团队和查询会话 | [CLI 使用与配置](v2/cli.md) |
| 连接团队、Pull/Push、分享会话或管理资源 | [团队协作流程](v2/team-collaboration.md) · [团队空间操作](v2/team-workspace.md) |
| 编写团队资产清单，了解安装和恢复规则 | [团队资产参考](v2/team-assets.md) |
| 让 Agent 查找处理经验、规范和 Skill | [Agent 检索指南](v2/agent-search.md) |
| 处理 Electron 安装失败 | [安装排障](troubleshooting-electron-installation.md) |
| 查阅已退役 V1 历史文档 | [V1 历史指南](v1/guide.md) · [English](v1/guide.en.md)（只读保留） |

## 开发与维护

首次参与开发先读[贡献指南](../CONTRIBUTING.md)与[仓库约定](../AGENTS.md)，再看所属模块的规格和源码。规格记录当前代码契约，ADR 记录重要选择的原因，两者均不代替本次验证结果。

| 要修改的范围 | 入口 |
| --- | --- |
| 进程、数据归属与模块边界 | [架构总览](spec/architecture.md) · [模块化架构 ADR](adr/0030-modular-desktop-architecture-and-guardrails.md) |
| 会话解析、增量索引与查询 | [会话索引](spec/session-indexing.md) |
| 启动、刷新或长会话卡顿 | [性能检查](v2/performance.md) · [桌面生命周期](spec/desktop-lifecycle.md) |
| 团队资产、本地视图与同步冲突 | [团队资产规格](spec/team-assets.md) |
| Agent 执行与评估 | [Runtime](spec/runtime.md) · [Eval](spec/evaluation.md) |
| MCP、Skills、Memory 或服务商配置 | [全部功能规格](spec/README.md) |
| 理解决策背景、演进与替代关系 | [ADR 索引](adr/README.md) |
| macOS 打包和验证 | [打包说明](macos-packaging.md) |

## 文档分工（五层体系）

治理规则见 [ADR 0031](adr/0031-documentation-system-and-adr-governance.md) 与 [文档约定](AGENTS.md)：

| 位置 | 保存什么 |
| --- | --- |
| `v2/`（`v1/` 历史冻结） | 面向用户的使用指南、CLI 文档与专题参考 |
| `spec/` | 当前代码的行为、接口、数据、失败与兼容边界 |
| `adr/` | 架构决策、边界守卫与替代关系；编号不复用，被替代决策保留原文并互链 |
| `designs/` | 有明确状态标记与适用范围的专项设计蓝图及分阶段演进路线 |
| `project/archive/` | 不再维护的历史计划、交接和排查记录 |

[专项设计](designs/README.md)和[历史记录](project/README.md)单独查阅，不作为新用户的上手流程。旧文档地址保留跳转说明；历史任务状态不能用来判断当前功能是否可用。
