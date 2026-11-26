# ADR 0028: 精简团队空间并重构 Skills 控制中心

- **状态**：已采用
- **日期**：2026-11-25

## 背景

统一 2.0 桌面端演进过程中，团队空间逐步累积出 11 个平铺标签页（共享会话、Agent 角色、运行成果、Skills、文档、共享指令、MCP、Env、工作目录、成员与动态、审核规则）与 8 层虚拟资源文件夹。其中：

- 随着桌面 Runtime 收缩到 Eval 与 Workflow 下线（[ADR 0021](0021-remove-v2-workflow.md)），`Agent 角色` 与 `运行成果` 不再驱动任何本机执行；
- `Env` 仅存非密占位符、`成员与动态` 靠浅克隆 100 条提交构造伪时间线、`审核规则` 在桌面重造 GitHub `CODEOWNERS`；
- 工作目录管理与团队连接分散在「设置 → 团队」与「团队空间 → 工作目录」，而团队 Skills/文档/指令详情仅用原始 `<pre>` 显示。

同时，Skills 页把本机目录、托管库、团队与个人 Supabase 云端同步拆成 3 个竞争心智的标签页：用户点击「加入 Skill 库」后不会平滑接管原路径导致立即出现红色「冲突」胶囊，详情页平铺未安装 Agent，且缺少 Antigravity (agy) / Cursor、多文件包预览、新建与内联编辑，以及与团队空间的直接分享闭环。

## 决策

1. **团队空间界面聚焦 5 个核心标签页 + 顶栏「工作目录」弹窗**：
   - 保留并升级：`共享会话`、`Skills`、`共享指令`、`MCP`、`文档`；
   - 工作目录接入、启停与断开移入顶栏「工作目录」弹窗，不切换当前浏览上下文；
   - 从桌面端 UI 下线 `Agent 角色`、`运行成果`、`Env`、`成员与动态`、`审核规则` 与虚拟文件夹整理界面；
   - **持久兼容**：`workspace-core` 与主进程服务继续保留清单版本 1–6、`OWNERS.json` 推送审核分流、以及旧目录角色筛选的静默读兼容，不破坏已有团队仓库或 CLI 行为。
2. **Skills 页重构为统一控制中心（我的 Skills / 团队 Skills / 发现市场）**：
   - 取消主导航中的「云端」标签，个人 Supabase 同步仅在已配置或从「更多操作」显式开启时展示；
   - 扩展 `AGENT_SKILL_REGISTRY` 支持 `Antigravity (agy)` 与 `Cursor`，并按本机是否存在 Agent 目录动态折叠未安装 Agent 至 `+ 更多`；
   - 新增 **无感纳管（Auto-Adopt）**：对本机用户级未托管 Skill 点击任意 Agent 开关时，先安全导入并校验内容哈希一致后把原路径平滑替换为托管软链，再同步目标 Agent，消除「先入库即冲突」；
   - **跨来源 Skill 去重**：在列表聚合时将托管库、各 Agent 用户目录、软链目标及多项目目录下的同名 Skill 归并为单条记录（托管库优先作为主入口，保留完整来源/项目列表元数据），消除重复条目；
   - 补齐多文件包浏览（文件数较多时默认折叠为带搜索筛选的抽屉，避免挤占正文阅读区）、新建 Skill、导入本地目录、内联编辑与默认编辑器打开，并打通 Skill 详情一键「分享到团队」。

## 影响

- 团队空间与 Skills 视觉、布局与 Markdown/结构化详情全面对齐 Studio 规范；
- 历史团队仓库无需迁移即可继续 Pull / Push；
- [团队资产规格](../spec/team-assets.md)、[Skills 规格](../spec/skills.md) 与 `apps/main-2.0` 的 renderer 测试同步更新以反映新界面契约；
- 本决策取代以下 ADR 中对应桌面端 UI 入口（底层 `workspace-core` 继续保留静默读兼容）：[ADR 0010](0010-resource-folder-metadata.md)、[ADR 0014](0014-team-agent-roles.md)、[ADR 0017](0017-install-skills-by-role.md)、[ADR 0018](0018-team-outcomes.md)、[ADR 0019](0019-team-review-routing.md) 与 [ADR 0026](0026-v2-resource-catalogs.md) 中的 Skills 页只读目录定位。

## 考虑的替代方案

- **彻底下线团队空间**：放弃团队资产通过 Git 共享与共享会话的独特价值，不可取；
- **删除底层 `workspace-core` 中所有角色/成果/审核代码**：会破坏已有团队仓库与审核分支保护，因此仅精简桌面端 UI 并保留底层静默兼容。

## 关联规格与实现

- [团队空间与 Skills 控制中心重塑设计](../designs/2026-11-25-team-space-and-skills-redesign.md)
- [团队资产规格](../spec/team-assets.md)、[Skills 规格](../spec/skills.md)
- `apps/main-2.0/src/renderer/src/features/team-workspace/`
- `apps/main-2.0/src/renderer/src/features/skills/`
- `apps/main-2.0/src/core/agent-skill-registry.ts`、`apps/main-2.0/src/core/managed-skill-library.ts`
