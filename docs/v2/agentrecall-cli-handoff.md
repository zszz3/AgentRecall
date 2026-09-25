# AgentRecall CLI 与团队功能：开发交接

核对日期：2026-09-25。面向接手开发的 agent；这是交接时的状态快照，后续状态以分支、PR 和 CI 的实时结果为准。

## 1. 当前结论

独立 CLI 已打通“配置团队与项目 → 手动同步 Skill → 预览 → 项目级安装 → 查看差异 → 更新 → 备份与回滚”。代码已提交并推送到 [草稿 PR #584](https://github.com/zszz3/AgentRecall/pull/584)，目标分支为 `main`，**尚未合并或发布**。

此前单 Skill 流程的验证基线为 [`c4525acc701490264eff473bd297d143b7d3cc75`](https://github.com/zszz3/AgentRecall/commit/c4525acc701490264eff473bd297d143b7d3cc75)。该提交的 CLI、V1、V2 在 Linux/macOS/Windows 上的检查，以及仓库检查和 Quality gate，均已通过：[完整 CI 记录](https://github.com/zszz3/AgentRecall/actions/runs/36114851838)。交接文档提交本身不改变产品代码，不能将这条 CI 记录当作任意后续提交的验证。

当前源码进一步支持工作配置的列表、预览、批量安装、本地归属、共享保护、整组差异/更新和卸载，版本 1/2 清单兼容，并对失败恢复和部分结果作出明确处理。完整团队产品尚未完成：跨配置协调更新、整组历史回滚及其他资产类型仍需开发；多人 Chat 删除已独立提交为草稿 PR #585，仍需合入验收。当前代码与 CI 以 PR 最新提交为准。

## 2. 到哪里接着做

同一台开发机上的目录如下；`~` 表示当前用户主目录。

| 工作区 | 分支 / 状态 | 接手方式 |
| --- | --- | --- |
| `~/.codex/worktrees/cli-foundation/agentrecall` | `codex/cli-foundation`；产品代码已推送 | CLI 和团队资产开发从这里继续。交接写入前工作区干净 |
| `~/.codex/worktrees/remove-multi-agent-chat/agentrecall` | `codex/remove-multi-agent-chat`；`5de21c0a`，已推送 | R00 删除 Chat 的独立工作区，见 [PR #585](https://github.com/zszz3/AgentRecall/pull/585) |
| `~/learnspace/agentrecall` | `codex/incremental-session-indexing`，`bc1dc8d4` | 原工作区，不能误当成 CLI 最新代码；有未跟踪的 `.agentrecall/`、`output/` 和旧版计划文档 |

CLI 同机接手：

```sh
cd "$HOME/.codex/worktrees/cli-foundation/agentrecall"
git status --short
git branch --show-current
gh pr view 584 --json state,isDraft,headRefOid,statusCheckRollup
```

其他机器可在全新、干净的 AgentRecall 克隆中执行 `gh pr checkout 584` 获取已推送的 CLI 改动。接手 Chat 删除可在另一干净克隆中执行 `gh pr checkout 585`；两项工作保持独立，不要混入同一分支。

不要对这些目录执行丢弃改动、清理未跟踪文件或强制重置。其他工作树属于独立任务，不要混入 CLI 提交。

## 3. 已确认的产品方向

以 [总开发计划](agentrecall-cli-team-plan.md) 的产品边界和 R00—R20 TODO 表为准：

- 新团队功能只面向 V2 及配套 CLI，不在 V1 产品代码上实现；桌面入口后续接入 `apps/main-2.0`。
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
| R07 资产格式 | 版本 1/2 清单、来源、文件校验、离线缓存及工作配置预览 | Rules、Docs、MCP、Agent 模板 |
| R08/R09 安装与版本管理 | Codex/Claude 安装、单 Skill 版本管理、工作配置批量安装、持久化归属、共享保护、整组差异/更新及卸载 | 跨配置协调更新、整组历史回滚、其他资产、逐行差异、PR 贡献与审核、分支订阅 |
| R10 桌面团队入口 | 未开始 | 接入共享服务及用户可见界面 |
| R11—R14 完整 Session 分享 | 未开始 | 包格式、对象存储、团队授权、主动上传、浏览和撤回 |
| R15—R19 Context / Improvement | 未开始 | 知识维护、检索、改进提案、验证发布、可选自动召回 |
| R20 验证与交付 | CLI 本地与三平台检查通过，文档和分支发布说明已有 | 真实团队验收、合入、独立分发及后续阶段验收 |
| R00 多人 Chat 删除 | 独立 PR #585 已提交，99 项受影响测试与 V2 构建通过，历史 Session 保留有回归覆盖 | 完整 CI、真实界面验收、审核与合入 |

### 当前可用命令

配置入口是 `init`、`status`、`doctor`、`team add/list/use/enable/disable/current`、`project add/list/bind/remove`。资产入口包括：

| 命令 | 行为 |
| --- | --- |
| `work-config list / preview / install` | 团队清单、冲突预览及安装，保存本地共享引用 |
| `work-config diff / update` | 预览整组引用与文件变化，按新旧版本更新；共享或独立内容冲突阻止改动 |
| `work-config installed / status / uninstall` | 离线查看本地配置、实际状态及整组卸载；保留共享和原有独立 Skill |
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
| [project-work-configs.ts](../../packages/workspace-core/src/project-work-configs.ts) | 项目本地归属格式、记录原子写入、引用保护、状态与整组卸载恢复 |
| [project-skills.ts](../../packages/workspace-core/src/project-skills.ts) | 安装归属、文件校验、差异、备份、更新与恢复 |
| [CLI 测试目录](../../apps/cli/test) | `workspace.test.ts`、`cli.test.ts`、`team-assets.test.ts` |
| [CLI 验证脚本](../../apps/cli/scripts) | 测试环境隔离、独立打包、临时目录安装/更新/卸载 |
| [quality-check.yml](../../.github/workflows/quality-check.yml) | 三平台 CLI 与桌面检查 |
| [现有发布说明](../../.release-notes/codex-cli-foundation.md) | 本分支只维护这一份发布说明，目标为 V2 |

桌面现有 `managed-skill-library.ts`、`skill-sync.ts`、`skill-service.ts` 仍是后续复用评估入口。当前 CLI 安装是项目级复制，桌面 Skill 库主要负责用户级管理；没有把桌面数据库、扫描器或 Electron 引入 CLI。

## 6. 接着开发时必须保留的约定

- CLI 包名为 `agentrecall-cli`，命令为 `agentrecall`。根 npm workspaces 仅包含 CLI 和 workspace-core，V1/V2 仍独立安装。
- 配置默认在 `~/.agentrecall-cli`，可用 `AGENTRECALL_HOME` 覆盖。本地配置与安装归属记录仍为版本 1，资产清单/缓存兼容版本 1/2；这些格式版本不同于产品的 V1/V2。未知字段/版本或损坏记录拒绝处理；新增格式必须明确旧记录兼容与拒绝策略。
- Codex 项目目录为 `.agents/skills/<id>`，Claude 为 `.claude/skills/<id>`。操作应落在实际当前 worktree，不写入另一个检出或用户全局配置。
- 每次安装/更新显式指定 Git 版本。当前安装或备份有修改、来源不符、链接或非受管内容时停止，不提供强制覆盖。
- 同步、安装、配置写入有各自的锁；团队状态在提交前复核。新工作配置的批量操作不能绕过这些归属和锁。
- 目录替换有两次移动，存在短暂缺失窗口。普通失败尝试恢复原安装；恢复失败保留备份并给出位置。强制终止恢复步骤见 Skill 指南，不能宣称跨多个目录已有完整事务。
- Git 下载没有受资产包大小限制；包内文件、缓存和完整输出另有限制，具体数值与支持范围以 Skill 指南为准。
- 缓存支持离线使用，远端撤权不会擦掉已下载内容。当前没有团队成员服务，不要把 Git 读取成功当成团队授权系统已经完成。
- 不改写或上传原始 Session。任何涉及安装、Skill、Hook、配置或发现 Session 的测试，都必须使用临时 HOME、临时 npm 前缀和合成数据。

## 7. 下一步建议：工作配置持续管理

当前已记录工作配置的本地归属，支持共享引用保护、离线状态和整组卸载。原有独立安装不被认领为可随配置删除的文件；被引用的 Skill 无法通过单独命令绕过保护。已支持同来源的整组差异与版本更新，仍未提供跨配置协调升级或整组历史版本回滚。

下一段开发重点：

1. 优先完成 V2 桌面入口和其他资产类型；如扩展跨配置协调升级，必须先设计多个配置共同确认共享版本的行为，不能绕过目前的共享保护。
2. 保留现有整组更新、共享卸载和失败恢复测试；整组历史回滚需要额外的配置版本与可恢复内容记录。
3. 复用现有单 Skill 校验、锁、备份及批量失败报告；多个目录不是一次原子提交，异常终止的恢复规则必须明确。
4. 扩展 Rules/Docs/MCP/Agent 模板前核实客户端当前格式，MCP 只引用本地密钥。V2 桌面接入使用同一服务，不能新增 V1 依赖。
5. 更新总计划和用户指南，保持真实成员/私有仓库验收、PR 贡献与 Session 分享的未完成状态。

R00 已在独立 [PR #585](https://github.com/zszz3/AgentRecall/pull/585) 完成源码删除、历史 Session 回归与本地构建验证。当前是草稿，需跟进 CI、界面验收和审核；不要把它当成已经发布。工作区的 `apps/main-2.0/node_modules` 仍是未跟踪的本地依赖链接，不要误提交。

## 8. 验证证据与接手命令

此前产品代码 `c4525acc` 的验证基线如下；当前工作配置增量另以 PR 最新提交的检查为准：

- 本地 `npm run test:cli`：20 项通过。
- 本地 `npm run package:smoke:cli`：类型检查、构建、临时 HOME/npm 前缀中的安装、重装、Skill 操作与卸载通过。
- 发布说明检查与 diff 格式检查通过。
- 上述完整 CI 已覆盖 Linux/macOS/Windows 的 CLI、V1、V2 和 Quality gate。
- 尚未做真实私有团队仓库、两名真实成员协作、桌面团队入口或 Session 分享验收。

工作配置增量本地 CLI 测试已扩展到 40 项，包含格式兼容、重叠引用、多项目/客户端与 worktree、预检冲突、引用保护、并发安装、整组卸载、记录写入失败、提交后的清理失败及内容被修改时的部分状态。

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
