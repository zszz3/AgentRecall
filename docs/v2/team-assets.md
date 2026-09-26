# 团队 Skill：拉取、预览和项目安装

团队资产第一版支持 Skill。用户登记 GitHub 资产仓库并绑定业务项目后，主动拉取清单，查看指定版本，再选择安装到该项目的 Codex 或 Claude Code。独立 CLI 无需运行桌面、数据库或 Memory 服务；V2 的[团队工作区](team-workspace.md)也可操作相同资产。

## 准备资产仓库

空 GitHub 仓库可先执行 `agentrecall init <仓库地址>` 自动生成并推送基础目录与版本 2 空清单；已有合法资产仓库重复初始化不会改动远端。完整行为见 [初始化说明](cli.md#初始化团队资产仓库)。接着添加所需 Skill，示例如下：

在资产仓库的默认分支保存以下目录：

```text
agentrecall.json
skills/
  review/
    SKILL.md
    references/guide.md
```

根目录 `agentrecall.json`：

```json
{
  "schemaVersion": 1,
  "skills": [
    { "id": "review", "path": "skills/review" }
  ]
}
```

`skills/review/SKILL.md`：

```markdown
---
name: review
description: Review a chosen code change and report actionable issues.
---

Read the selected diff and relevant tests before reporting findings.
```

清单只声明稳定 ID 和相对目录，名称与描述以 SKILL.md 的 YAML frontmatter 为准。`name` 必须等于清单 ID，`description` 必须为非空字符串。ID 使用小写字母开头、字母数字与单个连字符，最长 64 字符；Windows 保留名称和 Claude 的 `synced` 名称不接受。仓库中的其他文件不自动安装。

清单最多 64 个 Skill。每个 Skill 最多 200 个文件、每个文件最多 1 MiB；本次选中文件总计最多 8 MiB，缓存中的完整 JSON（含 Base64 内容和元数据）最多 16 MiB。路径必须兼容 macOS/Windows；拒绝目录穿越、大小写或 Unicode 规范化冲突、符号链接、子模块和 Git LFS 指针。超限明确失败，不截断文件。

## 拉取与选择安装

先按 [CLI 配置指南](cli.md) 登记团队与业务项目，并开启团队功能。在业务仓库内运行：

```sh
agentrecall team sync
agentrecall skill list
agentrecall skill preview review --target codex
agentrecall skill preview review --file references/guide.md
```

预览返回完整 Git 提交版本、正文、支持文件列表，以及所选客户端的安装位置。非 UTF-8 支持文件以明确标记的 Base64 返回。选择该版本后运行：

```sh
agentrecall skill install review --target codex --revision <预览返回的完整提交版本>
```

Claude Code 使用 `--target claude`。在仓库之外操作时加 `--project <id>`；在 worktree 内操作只会安装到当前 worktree，不会写入主检出目录。需要查看支持脚本时，用 `--file` 从文件清单中选择；拉取、预览和安装本身均不执行这些脚本。

Codex 的项目目录是 `.agents/skills/<id>`，Claude Code 是 `.claude/skills/<id>`，不修改用户主目录中的 Skill、MCP、Hook 或设置。路径依据：[Codex 本地 Skill 位置](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)、[Claude Code Skill 位置](https://code.claude.com/docs/en/skills#where-skills-live)。

安装采用复制，保存来源与内容校验记录。相同内容重复安装直接返回现有安装。目标已有个人 Skill、受管内容与所选版本不同、内容被本地修改，或目标父目录为链接时，操作停止并保留原内容。安装指定的版本必须仍与当前缓存一致；缓存已经更新时，重新预览后再安装。

这些安装文件属于项目工作区；是否纳入业务仓库版本管理由用户决定，CLI 不自动修改 `.gitignore` 或提交代码。

## 工作配置：批量选择 Skill

工作配置把一组 Skill 组成可选的安装清单。例如后端开发配置同时包含 `review` 与 `lint`。资产仓库根目录使用格式版本 2：

```json
{
  "schemaVersion": 2,
  "skills": [
    { "id": "review", "path": "skills/review" },
    { "id": "lint", "path": "skills/lint" }
  ],
  "workConfigs": [
    {
      "id": "backend",
      "name": "后端开发",
      "description": "代码审查与检查",
      "skills": ["review", "lint"]
    }
  ]
}
```

两个 Skill 目录都需要满足前面的文件和 frontmatter 规则。最多 64 个工作配置；每个配置引用 1—64 个已声明的 Skill，不能重复引用，配置 ID 不能重复。名称最长 200 字符、描述最长 4096 字符；完整缓存仍遵守 16 MiB 限制。版本 1 的清单和缓存继续可读，工作配置列表为空；使用新字段必须显式改为版本 2。旧版 CLI 会拒绝版本 2，不会静默忽略配置。这里的格式版本与桌面应用的 V1/V2 是两回事；这些团队功能面向 V2 配套 CLI。

```sh
agentrecall team sync
agentrecall work-config list
agentrecall work-config preview backend --target codex
agentrecall work-config install backend --target codex --revision <预览返回的完整提交版本>
```

选择 `claude` 可安装到 Claude Code。命令支持 `--project`、`--cwd` 和 `--json`。指定客户端预览时，会逐项显示待安装、可复用或冲突及原因，预览不写入客户端目录；未指定客户端时只显示清单，不检查本地冲突。要查看某个 Skill 的正文和支持文件，继续使用 `skill preview`。

安装在任何目标生效前检查全部 Skill；目标版本必须与缓存一致。相同来源、相同内容且未被修改的已有 Skill 会复用，返回其实际安装版本；其他已有内容会阻止安装，不自动更新。正常失败时，仅将本次新安装的目录移入备份，已有 Skill 不动。若回退失败或内容在操作期间被修改，则保留现场、明确报错，JSON 的 `error.details` 返回逐项结果、备份路径和需要清理的 Skill。可以用 `skill backups` 检查并按前面的恢复流程处理。

安装成功后，项目根目录的 `.agentrecall-work-configs.json` 保存配置来源、版本、目标客户端和共享引用。查看本地状态和卸载不需要联网，关闭团队后仍可使用：

```sh
agentrecall work-config installed
agentrecall work-config status backend --target codex
agentrecall work-config uninstall backend --target codex --revision <状态中显示的完整配置版本>
```

`status` 同时显示内容是否完整，以及卸载时每个 Skill 的去向：其他配置仍在引用时保留；配置安装之前已经存在的独立 Skill 保留；仅由配置创建、且不再被其他配置引用的 Skill 移入备份。Codex 和 Claude 的归属分别记录，worktree 也有自己的记录。原文件已有修改或损坏且需要被移走时，整组卸载会在修改前停止；准备保留的共享或独立内容不受影响。

引用关系在主服务中执行。只要还有配置引用该 Skill，单独的 `skill install/update/uninstall/rollback` 就会拒绝改动；查看内容、差异和备份仍可使用。需要改动时，先查看引用它的配置及影响，再卸载相关配置后处理。团队清单删除一个引用不会自动改变本地安装关系。

重复安装相同配置版本可补齐缺失项或复用相同内容。升级同一来源的工作配置时，先同步和查看整组差异，再明确指定旧版本与新版本：

```sh
agentrecall team sync
agentrecall work-config diff backend --target codex
agentrecall work-config update backend --target codex --from-revision <当前配置版本> --revision <预览的新版本>
```

`diff` 列出新增、保留和移除的引用，以及安装、复用、更新、移入备份、保留或冲突的具体动作。可用 `skill diff` / `skill preview` 进一步查看文件。整组更新只修改该配置独占且由配置创建的 Skill；共用 Skill 需要改变内容时、原有独立安装需要被覆盖时、或本地内容被修改时，会在写入前阻止整组更新。移除共用或独立 Skill 的引用只会解绑，不会移走其文件。

更新会检查新旧版本、先准备全部新增和替换内容，再逐项应用并保存归属。过程中出现写入错误时，尝试同时恢复替换、移除和新增的文件；恢复失败则保留原归属和仍可恢复的副本，JSON 错误中返回各项实际状态与备份位置。其他配置的版本和引用不会被静默改写。当前没有跨多个配置的协调升级和整组历史版本回滚命令；单个 Skill 的备份仍保留，涉及共享变更时需要先明确处理受影响配置。

`install` 不兼任更新；`preview` 会提示同名旧版本的更新入口。切换到不同资产来源仍需先卸载原配置，不能跨来源直接更新。

安装和卸载均在文件操作完成后保存归属记录，记录写入失败会尝试回退文件操作；失败恢复不完整时返回实际状态与备份位置。记录成功后的清理失败会保留已完成的安装，先查看状态再重试。多目录发布不是一次原子替换，强制终止可能留下部分文件或暂存目录：先运行 `work-config status`；缺失项可重新安装原版本补齐，或重试卸载完成剩余项。卸载完成后，仍可通过 `skill backups/rollback` 恢复保留下来的内容。

本地归属记录使用独立的格式版本 1，最多 64 个配置、256 个 Skill 归属，完整文件最多 1 MiB。新装或旧版 CLI 没有该文件时，从空归属开始；重新安装清单前已有的 Skill 均按独立安装保留，不追溯认领。旧配置与 Skill 安装记录不需要迁移。未知格式、超限、损坏、悬空引用或链接都会停止处理，不自动重置；请保留文件并恢复正确记录。旧版 CLI 不认识共享引用，因此不要混用旧版命令修改新版已管理的 Skill。

这份记录属于项目的本地管理状态；CLI 不自动提交记录或修改 `.gitignore`。跨配置协调更新、整组历史版本回滚、Rules/Docs/MCP/Agent 模板仍需后续实现。

## 更新、卸载与恢复

`team sync` 只更新缓存，不会改变已安装的 Skill。要切换版本，先查看文件增删、内容或执行权限变化，并按需查看一个文件的新旧正文：

```sh
agentrecall team sync
agentrecall skill diff review --target codex
agentrecall skill diff review --target codex --file SKILL.md
agentrecall skill update review --target codex --from-revision <当前完整版本> --revision <新完整版本>
```

`diff` 返回当前安装和缓存的完整版本，以及新增、删除、修改的文件列表。`--file` 展示选中文件的两份完整内容；二进制内容使用 Base64，执行权限变化单独返回。完整 JSON 输出（包含转义与元数据）最多 16 MiB，超限报错，不截断。

`update` 要求明确给出新旧版本，校验当前安装未被本地修改、来源相同且新版本仍与缓存一致。执行前再校验一次：若其他命令已更新了安装，则本次失败，需要重新查看差异。更新先保存原目录，再放入新版本；相同版本重复更新不会产生额外备份。首次安装仍使用 `install`，不会自动覆盖不同内容。

查看本地备份、当前两个客户端的安装版本，或显式回滚：

```sh
agentrecall skill backups review
agentrecall skill rollback review --target codex --backup <备份名称> --from-revision <当前完整版本>
agentrecall skill uninstall review --target codex
```

更新、卸载和回滚替换前的目录保存在项目的 `.agentrecall-skill-backups/<id>-<唯一标识>`，命令返回备份路径。`backups` 同时显示当前安装版本、每份备份的版本及是否可恢复；最多列出该 Skill 的 200 份备份，超限需要先在本地整理。备份按项目与 Skill 保存，不按客户端区分，恢复时必须选择目标客户端。

回滚将选中备份移回安装位置，原安装成为另一份备份。目标为空时，显式使用 `--from-revision none`；这也适用于恢复先前卸载的 Skill。目标存在时必须给出准确版本，并与备份来源一致。当前安装或备份有本地修改、格式损坏、来源冲突或链接时，会停止自动替换并保留内容。既有版本 1 的安装和卸载备份可直接使用，无需迁移。

目录替换需要先移走原目录，再移入新目录，存在短暂的目标缺失窗口。如果第二步失败，会尝试恢复原安装；恢复也失败时，命令明确返回原版本备份的位置。进程被强制终止时，原版本仍在安装位置或备份目录，可先用 `backups` 查看实际状态，再选择版本或 `none` 恢复。不要在 Agent 正在读取 Skill 时更新；强制终止遗留的暂存目录可在恢复完成、确认没有命令运行后手动清理。

关闭团队会阻止后续同步、团队资产读取、安装和更新，但保留缓存和已有本地副本；`skill backups`、`skill rollback` 和 `skill uninstall` 属于本地恢复操作，仍可使用。客户端已加载到会话中的内容不会因文件回滚或删除而改变，需要按客户端方式重新加载。

## 访问权限、失败与当前范围

`team sync` 默认使用 HTTPS，也可选 `--transport ssh`。复用本机 Git 已配置的凭据助手或 SSH，不保存密码/Token，不自动登录，不将凭据写入共享配置。私有仓库需要现有 Git 身份有读取权限；失败时检查网络、Git 和所选传输方式的授权。一次 Git 子进程有 60 秒超时，命令可用 Ctrl+C 取消。

同步读取 Git 对象，不检出资产工作区，不执行仓库里的 Hook、安装脚本、过滤器或子模块。完成校验后才替换缓存；下载失败、清单错误、取消或下载期间关闭/切换团队时，保留原缓存。下载 Git pack 的网络流量不受上面的资产包大小限制，资产仓库应保持精简。

缓存用于离线预览和安装，不会在每次使用时重新检查 GitHub 权限；远端撤权不会远程删除已下载副本。这一版尚不提供团队成员管理、仓库创建/邀请、远端授权目录、受管凭据或 Session 存储服务。

资产按 Git 提交版本固定，支持用户主动查看差异、更新和回滚，但暂不提供分支订阅、PR 贡献、差异合并或后台自动更新。Rules、Docs、MCP/Agent 配置组合仍在计划中；桌面在现有功能页区分本地与团队范围。现有桌面 Skill 库负责用户级管理；本次新增项目级复制和归属检查，未把桌面扫描器或数据库引入 CLI。

配置、缓存、安装记录均拒绝未知版本与损坏数据。缓存损坏可重新同步，安装记录损坏则停止自动处理并保留目录；卸载备份保留原格式。独立 CLI 的分发仍为源码构建，尚未发布到 npm。

## 文档清单

文档使用 `schemaVersion: 3`，保留版本 2 的 `skills` 和 `workConfigs`，增加 `documents`。版本 1/2 继续读取，文档列表为空；旧客户端遇到版本 3 会明确拒绝，需要升级，不会静默重写清单。

```json
{
  "schemaVersion": 3,
  "skills": [],
  "workConfigs": [],
  "documents": [
    { "id": "agent-rules", "name": "团队开发约定", "path": "rules/AGENTS.md", "target": "AGENTS.md" },
    { "id": "architecture", "name": "项目架构", "path": "docs/architecture.md", "target": "docs/architecture.md" }
  ]
}
```

`path` 是资产仓库中的 Markdown 文件，`target` 是业务项目中的位置，只允许根目录 `AGENTS.md`、`CLAUDE.md` 或 `docs/` 下的 `.md` 文件。ID 与目标路径必须唯一，拒绝路径穿越、大小写/规范化冲突、文件/目录冲突、符号链接和 Git LFS。文档是严格 UTF-8，保留 BOM，单文件最多 1 MiB，最多 128 份；与 Skills 合并计入 8 MiB 原始文件及 16 MiB 完整缓存限制。

在 V2「团队空间 → 团队 → 项目 → 文档」中同步、预览并应用。应用固定预览版本，创建缺失文件；相同内容直接保留，不同内容拒绝覆盖。当前文档操作由桌面提供，CLI `team sync` 也能读取版本 3；暂未提供独立文档应用命令。仓库初始化仍生成版本 2 空清单，发布文档时按上述示例显式升级版本。
