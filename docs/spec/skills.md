# Skill 库、安装与控制中心

范围：统一桌面端管理的 Skill 库、本机多 Agent 分发、团队浏览与可选个人云端同步（架构决策见 [ADR 0028](../adr/0028-streamlined-team-space-and-skills.md)）。团队目录内的 Git Pull/Push 另见 [团队资产](team-assets.md)。

## 四个不同的副本

| 位置 | 含义 | 发生变化的动作 |
| --- | --- | --- |
| 本机发现的 Skill | 用户、项目、插件或系统已有内容 | 来源工具或用户维护 |
| Skill 库 | AgentRecall 管理的源副本及来源信息 | 导入、新建、编辑、删除 |
| 编码客户端安装目标 | 客户端可发现的安装入口（支持 Codex、`codex-shared`、Claude Code、Antigravity / `agy`、Cursor、CodeBuddy、Qoder、Trae、Pi，定义见 [agent-skill-registry.ts](../../apps/main-2.0/src/core/agent-skill-registry.ts)） | 明确切换目标开关或授权覆盖 |
| 个人云端版本 | Supabase 中的版本化副本（默认收起，仅在已配置或从更多操作开启时显示） | 明确上传、恢复或加入库 |

「加入 Skill 库」不自动安装到其他编码客户端，「安装到 Agent」不等同于分享给团队；Runtime 中配置 Agent 的名称也不是磁盘安装目标。

## Skills 控制中心

Skills 页提供三个顶层视图：**我的 Skills**（默认）、**团队 Skills**（接入团队时可用）与 **发现市场**（公共 `skills.sh` 榜单、搜索与 AI 探索）。顶部支持新建 Skill、从本地目录导入与重新查找。

- **跨来源去重**：「我的 Skills」将托管库、各 Agent 用户目录、软链目标及多项目目录下的同名 Skill（不区分大小写）合并为单条列表项，优先以 Skill 库副本作为主入口，并在元信息中保留全部生效 Agent 与项目路径列表。支持按 `全部 / 已启用 / 未启用 / 项目级` 筛选，Eval 有未处理发现的 Skill 显示「N 个发现」。
- **无感纳管（Auto-Adopt）**：对尚未入库的本机用户级 Skill 直接点击任意 Agent 开关时，先安全导入托管库并校验内容哈希一致，再将原路径平滑替换为托管软链并同步目标 Agent，避免「先入库即报冲突」。
- **按本机检测折叠 Agent**：详情页内联开关条优先展示本机已检测到的常用客户端（Codex / 共享目录 / Claude / Antigravity / Cursor），其余未安装目标收入 `+ 更多` 菜单。
- **多文件包预览与编辑**：支持在详情区切换查看 `SKILL.md` 及附属脚本/参考文件（文件数较多时默认折叠为带搜索筛选的抽屉），支持内联编辑 `SKILL.md`、在外部编辑器打开与一键「分享到团队」。

「重新查找」刷新 Skill 库、强制重新扫描本机 Agent 目录并重读团队目录；打开页面默认读取缓存的本机扫描结果，不会每次重扫。团队 Skill 的新增和发布流程另见 [团队资产](team-assets.md)。

## 数据模型

[ManagedSkill](../../apps/main-2.0/src/core/managed-skill-library.ts)包含 managedId、origin、categoryId 和 installations。origin 区分 local、skills-sh、remote、builtin；每个安装目标有 path 和 installed/not-installed/conflict 状态。

管理元数据目前使用 schemaVersion 1。Skill 内容不只有 SKILL.md，还可能有脚本与附件；导入、更新和同步必须保留必要文件内容，不能只复制首页后报告完成。

## 导入与发现

本地候选由 [skill-manager](../../apps/main-2.0/src/core/skill-manager.ts)按受支持来源发现。系统/项目/插件来源的管理权限不同，不能仅因可以读取就允许删除或云端恢复覆盖。

经验卡可以在 Memory 页提升为 Skill：主进程用用户确认的标识、说明和内容写出 SKILL.md（`name` 为标识，`description` 为单行说明），以 `local` 来源、标签「经验卡」导入管理库；同标识的不同 Skill 不会被替换，返回冲突由界面提示换标识。

公共仓库 Skill 先导入管理库，保留来源信息。导入结果区分 imported、existing、updated，重复操作不应产生难以区分的副本。公共发现服务可失败，网络失败不意味着本地库不可用。

AI 探索先由 [AgentRecall 模型](providers.md#agentrecall-模型)把自然语言需求转成 skills.sh 搜索词，搜索后再由模型阅读候选的 SKILL.md，最多推荐 5 个并说明理由。候选内容只作为参考数据，模型只能推荐候选中的 id。未设置模型时显示错误并提示设置，不改用 Runtime。实现见 [skill-ai-search.ts](../../apps/main-2.0/src/core/skill-ai-search.ts)。

## 安装和冲突

用户选择 Codex、Claude Code 等实际客户端目标后，管理库计算目标状态。多个客户端别名可能对应同一个物理位置，写入和删除不能重复执行。

普通安装遇到同名不属于当前安装的内容时报告冲突；只有对该目标明确授权强制安装才能替换。强制集合必须属于所选且已知的目标，不能把一个目标的确认扩展成所有目标的覆盖权限。

安装操作先准备和校验，失败时保留或恢复原内容。发生需要人工清理的备份时，结果返回 retainedBackupPaths，不把清理失败伪装成全程无异常。

## 删除与恢复

删除管理库源会影响它的受管安装入口，所以需要核对目标归属并分阶段处理。不能删除插件/系统文件来“清理同名 Skill”，也不能因为一个目标无法检查就继续破坏其他目标。

若后续阶段失败，按已执行阶段尝试恢复；无法完整恢复时报告保留源、安装入口或备份的具体情况。删除成功与备份清理成功是两件事。

## 个人云端与 Eval

可移植来源才支持相应云端安装；来源路径不能直接作为另一台机器的目标路径。远端相对路径需规范化，拒绝逃出受管目录的输入。

绑定 Skill 的 Eval 记录本次使用的 Skill 内容 hash。安装到本机客户端、纳入评估和分享到团队是独立动作，不能相互隐式触发。云端版本操作见 [V2 指南](../v2/guide.md)，评分见 [Eval](evaluation.md)。

## 验收场景

| 场景 | 期望结果 |
| --- | --- |
| 从本地加入 App | 库中可见，未选择的客户端不被安装 |
| 普通安装遇到冲突 | 拒绝覆盖，其他目标不因失败被部分误改 |
| 多个别名指向同一路径 | 只管理一份物理入口 |
| 只授权一个冲突目标强制安装 | 其他冲突目标仍需明确授权 |
| 安装链接创建失败 | 原冲突内容被恢复或给出恢复信息 |
| 删除时后续目标失败 | 已处理的目标按阶段恢复 |
| 删除系统 Skill | 拒绝操作 |
| 云端路径包含越界段 | 不在受管根目录外写入 |

## 验证入口

[Skills 页测试](../../apps/main-2.0/src/renderer/src/features/skills/skills-page.test.tsx)覆盖同名合并、分组、加入 Skill 库、删除确认和重新查找；[管理库测试](../../apps/main-2.0/src/core/managed-skill-library.test.ts)覆盖安装别名、逐目标强制授权及删除恢复；[发现与基础操作测试](../../apps/main-2.0/src/core/skill-manager.test.ts)覆盖候选和系统 Skill 保护。

上述测试应使用临时目录。不能用开发者真实 Skill 库验证卸载、覆盖或清理，也不能把成功导入视作 Skill 本身质量或脚本安全性的保证。
