# AgentRecall CLI 与团队功能：开发交接

核对日期：2026-09-25。面向接手开发的 agent；这是交接时的状态快照，后续状态以分支、PR 和 CI 的实时结果为准。

## 1. 当前结论

独立 CLI 已打通“配置团队与项目 → 手动同步 Skill → 预览 → 项目级安装 → 查看差异 → 更新 → 备份与回滚”。代码已提交并推送到 [草稿 PR #584](https://github.com/zszz3/AgentRecall/pull/584)，目标分支为 `main`，**尚未合并或发布**。

最新产品代码提交为 [`c4525acc701490264eff473bd297d143b7d3cc75`](https://github.com/zszz3/AgentRecall/commit/c4525acc701490264eff473bd297d143b7d3cc75)。该提交的 CLI、V1、V2 在 Linux/macOS/Windows 上的检查，以及仓库检查和 Quality gate，均已通过：[完整 CI 记录](https://github.com/zszz3/AgentRecall/actions/runs/36114851838)。交接文档提交本身不改变产品代码，不能将这条 CI 记录当作任意后续提交的验证。

完整团队产品尚未完成。下一项建议是 **R07/R08 的工作配置组合**；多人 Chat 删除另有未提交工作，必须单独收尾。

## 2. 到哪里接着做

同一台开发机上的目录如下；`~` 表示当前用户主目录。

| 工作区 | 分支 / 状态 | 接手方式 |
| --- | --- | --- |
| `~/.codex/worktrees/cli-foundation/agentrecall` | `codex/cli-foundation`；产品代码已推送 | CLI 和团队资产开发从这里继续。交接写入前工作区干净 |
| `~/.codex/worktrees/remove-multi-agent-chat/agentrecall` | `codex/remove-multi-agent-chat`；基点 `96577cd3`，有大量未提交改动 | R00 删除 Chat 的独立工作区，核对时未找到该分支的 PR |
| `~/learnspace/agentrecall` | `codex/incremental-session-indexing`，`bc1dc8d4` | 原工作区，不能误当成 CLI 最新代码；有未跟踪的 `.agentrecall/`、`output/` 和旧版计划文档 |

CLI 同机接手：

```sh
cd "$HOME/.codex/worktrees/cli-foundation/agentrecall"
git status --short
git branch --show-current
gh pr view 584 --json state,isDraft,headRefOid,statusCheckRollup
```

其他机器可在全新、干净的 AgentRecall 克隆中执行 `gh pr checkout 584` 获取已推送的 CLI 改动。**Chat 删除的未提交改动不会随 PR 或普通 clone 带过来**；接手 R00 需要原工作区，或另行移交并核验那份改动。

不要对这些目录执行丢弃改动、清理未跟踪文件或强制重置。其他工作树属于独立任务，不要混入 CLI 提交。

## 3. 已确认的产品方向

以 [总开发计划](agentrecall-cli-team-plan.md) 的产品边界和 R00—R20 TODO 表为准：

- 参考 TeamAI 的 Git 团队资产协作方式。团队功能默认关闭，个人使用不依赖团队服务。
- 一个客户端可配置多个业务仓库及其团队资产仓库；两类仓库身份不能混用。
- 用户最终可以主动分享完整 Session；开启团队、安装 Skill 或 Hook 均不等于同意上传。
- 后续 Context 保存可维护的项目背景、约定和经验；Improvement 生成有证据、可审核的改进提案。
- 移除多人 Chat，保留已有 Agent、Workflow、Eval 和历史 Session。
- 暂不自研 OpenViking 替代品，也不要求团队资产功能依赖 OpenViking。

## 4. 进度清单

这里的“已实现”仅指上述源码分支；总计划中的阶段任务仍需完成剩余范围与合入验收。

| 范围 | 当前已有 | 未完成 |
| --- | --- | --- |
| R01/R02 配置与共享模块 | 版本 1 配置、无界面 workspace-core、原子保存与锁、错误和大小校验 | 桌面使用同一配置；按实际消费需求提取更多共享能力 |
| R03 独立 CLI | 独立包、配置/项目/团队命令、人读与 JSON 输出、隔离打包验证 | Session 列表/搜索、正式独立分发 |
| R04/R05 团队开关和多仓库 | 默认关闭、显式启停、默认团队和项目覆盖、worktree/克隆/fork/歧义识别 | 桌面开关及入口 |
| R06 GitHub 资产读取 | 显式 HTTPS/SSH 同步，复用本机 Git 身份 | 创建/加入空间、成员权限管理、真实私有仓库验收 |
| R07 资产格式 | Skill 清单、来源、提交版本、文件校验、离线缓存与预览 | Rules、Docs、MCP、Agent 模板 |
| R08/R09 安装与版本管理 | Codex/Claude 项目级安装、差异、指定版本更新、冲突保护、备份、回滚 | 工作配置组合、逐行差异交互、PR 贡献与审核、分支订阅 |
| R10 桌面团队入口 | 未开始 | 接入共享服务及用户可见界面 |
| R11—R14 完整 Session 分享 | 未开始 | 包格式、对象存储、团队授权、主动上传、浏览和撤回 |
| R15—R19 Context / Improvement | 未开始 | 知识维护、检索、改进提案、验证发布、可选自动召回 |
| R20 验证与交付 | CLI 本地与三平台检查通过，文档和分支发布说明已有 | 真实团队验收、合入、独立分发及后续阶段验收 |
| R00 多人 Chat 删除 | 另一工作区已有删除与保留边界的改动 | 本轮未复跑其测试；历史 Session 最终核验、独立提交、PR 与合入均未完成 |

### 当前可用命令

配置入口是 `init`、`status`、`doctor`、`team add/list/use/enable/disable/current`、`project add/list/bind/remove`。资产入口包括：

| 命令 | 行为 |
| --- | --- |
| `team sync` | 手动读取资产仓库默认分支，替换校验完成的缓存 |
| `skill list / preview` | 查看当前团队缓存；可预览指定支持文件 |
| `skill install` | 显式选择目标客户端与完整 Git 版本，安装到当前项目 |
| `skill diff` | 比较当前安装与缓存；`--file` 展开两份完整内容 |
| `skill update` | 要求 `--from-revision` 和 `--revision`，先备份再替换 |
| `skill backups` | 查看 Codex/Claude 当前版本及本地备份 |
| `skill rollback` | 恢复指定备份；`--from-revision none` 只接受空目标 |
| `skill uninstall` | 移走未修改的受管安装并保留备份 |

参数和示例只在 [CLI 使用与配置](cli.md) 与 [团队 Skill 指南](team-assets.md) 中维护。关闭团队后，远端同步、团队缓存读取、安装和更新均被阻止；本地备份查看、回滚和卸载仍可使用。

## 5. 实现位置

先读仓库 [AGENTS.md](../../AGENTS.md)，再按下面的入口定位，不要从桌面启动代码重建一套 CLI。

| 入口 | 职责 |
| --- | --- |
| [apps/cli/src/cli.ts](../../apps/cli/src/cli.ts) | 参数检查、命令路由、终端和 JSON 输出 |
| [config.ts](../../packages/workspace-core/src/config.ts) | 本地配置 schema、大小限制、锁、原子写入 |
| [git.ts](../../packages/workspace-core/src/git.ts) / [workspace.ts](../../packages/workspace-core/src/workspace.ts) | 仓库身份、项目解析、团队选择及开关执行 |
| [asset-format.ts](../../packages/workspace-core/src/asset-format.ts) | 清单与缓存格式、Skill frontmatter、路径和内容校验 |
| [git-assets.ts](../../packages/workspace-core/src/git-assets.ts) | Git 对象读取；bare clone，不检出或执行仓库内容 |
| [asset-storage.ts](../../packages/workspace-core/src/asset-storage.ts) | 有界 JSON 读取及资产锁 |
| [team-assets.ts](../../packages/workspace-core/src/team-assets.ts) | 同步、缓存、项目操作协调，以及提交前再次核对团队状态 |
| [project-skills.ts](../../packages/workspace-core/src/project-skills.ts) | 安装归属、文件校验、差异、备份、更新与恢复 |
| [CLI 测试目录](../../apps/cli/test) | `workspace.test.ts`、`cli.test.ts`、`team-assets.test.ts` |
| [CLI 验证脚本](../../apps/cli/scripts) | 测试环境隔离、独立打包、临时目录安装/更新/卸载 |
| [quality-check.yml](../../.github/workflows/quality-check.yml) | 三平台 CLI 与桌面检查 |
| [现有发布说明](../../.release-notes/codex-cli-foundation.md) | 本分支只维护这一份发布说明，目标为 V2 |

桌面现有 `managed-skill-library.ts`、`skill-sync.ts`、`skill-service.ts` 仍是后续复用评估入口。当前 CLI 安装是项目级复制，桌面 Skill 库主要负责用户级管理；没有把桌面数据库、扫描器或 Electron 引入 CLI。

## 6. 接着开发时必须保留的约定

- CLI 包名为 `agentrecall-cli`，命令为 `agentrecall`。根 npm workspaces 仅包含 CLI 和 workspace-core，V1/V2 仍独立安装。
- 配置默认在 `~/.agentrecall-cli`，可用 `AGENTRECALL_HOME` 覆盖。当前配置、缓存和安装归属记录均为版本 1，未知字段/版本或损坏记录拒绝处理；新增格式必须明确旧记录兼容与拒绝策略。
- Codex 项目目录为 `.agents/skills/<id>`，Claude 为 `.claude/skills/<id>`。操作应落在实际当前 worktree，不写入另一个检出或用户全局配置。
- 每次安装/更新显式指定 Git 版本。当前安装或备份有修改、来源不符、链接或非受管内容时停止，不提供强制覆盖。
- 同步、安装、配置写入有各自的锁；团队状态在提交前复核。新工作配置的批量操作不能绕过这些归属和锁。
- 目录替换有两次移动，存在短暂缺失窗口。普通失败尝试恢复原安装；恢复失败保留备份并给出位置。强制终止恢复步骤见 Skill 指南，不能宣称跨多个目录已有完整事务。
- Git 下载没有受资产包大小限制；包内文件、缓存和完整输出另有限制，具体数值与支持范围以 Skill 指南为准。
- 缓存支持离线使用，远端撤权不会擦掉已下载内容。当前没有团队成员服务，不要把 Git 读取成功当成团队授权系统已经完成。
- 不改写或上传原始 Session。任何涉及安装、Skill、Hook、配置或发现 Session 的测试，都必须使用临时 HOME、临时 npm 前缀和合成数据。

## 7. 下一步建议：工作配置组合

这是下一段开发建议，尚未实现，不代表格式或命令已经确定。

1. 先做 R07/R08 的小范围闭环：在团队资产中声明一个可选工作配置，引用多个已存在的 Skill。支持列表、预览、选择目标客户端、安装和失败恢复。
2. 先定义版本化清单、缓存和本地安装归属；现有严格版本 1 解析会拒绝新增字段，不能直接添加字段后宣称旧客户端兼容。用旧/新记录测试明确升级或拒绝行为。
3. 预览必须包含全部目标和冲突；多个配置引用同一个 Skill 时，明确共享归属与卸载规则，避免卸载一个配置误删另一个配置正在使用的资产。
4. 定义多个目录安装的失败语义：优先在写入前检查全部冲突；中途失败必须回退，或明确返回可恢复的部分状态，不能提前报整组成功。
5. 复用现有单 Skill 版本校验、锁和备份能力；不要靠重复运行 CLI 子进程拼出无法一致回退的批量安装。
6. 先验收“两组配置有重叠 Skill、两个项目、两个客户端”的隔离、幂等、更新、停用和失败恢复，再逐步扩展 Rules/Docs/MCP/Agent 模板。MCP 模板只能引用本地密钥，不在团队仓库中保存密钥。
7. 更新总计划、用户指南和本分支现有发布说明。未完成的成员管理、桌面入口、PR 贡献和 Session 分享继续保持明确的未完成状态。

R00 可作为另一项独立收尾任务：在 Chat 工作区核对历史 Session 保留、Workflow MCP、Agent/Workflow/Eval 可用性，再运行受影响测试和 V2 检查，单独提交和开 PR。该工作区还有未跟踪的发布说明、工作台测试和 `apps/main-2.0/node_modules`；不要把依赖目录误提交。

## 8. 验证证据与接手命令

针对产品代码 `c4525acc` 已完成：

- 本地 `npm run test:cli`：20 项通过。
- 本地 `npm run package:smoke:cli`：类型检查、构建、临时 HOME/npm 前缀中的安装、重装、Skill 操作与卸载通过。
- 发布说明检查与 diff 格式检查通过。
- 上述完整 CI 已覆盖 Linux/macOS/Windows 的 CLI、V1、V2 和 Quality gate。
- 尚未做真实私有团队仓库、两名真实成员协作、桌面团队入口或 Session 分享验收。

接手后先检查实际代码和 CI，不必为了阅读交接文档重新跑全仓测试。开发发生变化时，在 CLI 工作区按风险执行：

```sh
npm run setup:cli
npm run test:cli
npm run package:smoke:cli
npm run release-note:check
git diff --check
```

只需 CLI 时，不要误运行安装全部桌面依赖的根 `npm run setup`。不要用真实用户的 Agent 目录做安装测试，不要对当前全局 npm 前缀做安装/卸载冒烟。

继续现有 CLI 工作应保留 PR #584 的上下文；若拆独立分支，必须明确其对未合并 CLI 分支的依赖。完成测试、推送、合入与发布是不同状态，交接与汇报中分别记录。
