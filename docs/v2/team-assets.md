# 团队 Skill：拉取、预览和项目安装

团队资产第一版支持 Skill。用户登记 GitHub 资产仓库并绑定业务项目后，主动拉取清单，查看指定版本，再选择安装到该项目的 Codex 或 Claude Code。无需运行桌面、数据库或 Memory 服务。

## 准备资产仓库

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

## 更新、卸载与恢复

`team sync` 只更新缓存，不会改变已安装的 Skill。要切换版本，先查看新版本，再显式卸载未修改的旧安装并安装新版本：

```sh
agentrecall skill uninstall review --target codex
```

卸载把完整目录移到项目的 `.agentrecall-skill-backups/<id>-<唯一标识>`，并返回备份路径，不直接销毁内容。如果安装有本地修改，会拒绝自动卸载，需要先检查和保存修改。若需要恢复，可将返回的备份目录移回原安装位置；只有目标不存在时才恢复，已有目标应先妥善处理。

关闭团队会阻止后续同步、资产读取和安装，但保留缓存和已有本地副本，`skill uninstall` 仍可用于清理。客户端已加载到会话中的内容无法通过删除文件从会话中撤回。

## 访问权限、失败与当前范围

`team sync` 默认使用 HTTPS，也可选 `--transport ssh`。复用本机 Git 已配置的凭据助手或 SSH，不保存密码/Token，不自动登录，不将凭据写入共享配置。私有仓库需要现有 Git 身份有读取权限；失败时检查网络、Git 和所选传输方式的授权。一次 Git 子进程有 60 秒超时，命令可用 Ctrl+C 取消。

同步读取 Git 对象，不检出资产工作区，不执行仓库里的 Hook、安装脚本、过滤器或子模块。完成校验后才替换缓存；下载失败、清单错误、取消或下载期间关闭/切换团队时，保留原缓存。下载 Git pack 的网络流量不受上面的资产包大小限制，资产仓库应保持精简。

缓存用于离线预览和安装，不会在每次使用时重新检查 GitHub 权限；远端撤权不会远程删除已下载副本。这一版尚不提供团队成员管理、仓库创建/邀请、远端授权目录、受管凭据或 Session 存储服务。

资产按 Git 提交版本固定，但暂不提供分支订阅、PR 贡献、差异合并、自动覆盖更新或自动回滚命令。Rules、Docs、MCP/Agent 配置组合和桌面入口仍在计划中。现有桌面 Skill 库负责用户级管理；本次新增项目级复制和归属检查，未把桌面扫描器或数据库引入 CLI。

配置、缓存、安装记录均拒绝未知版本与损坏数据。缓存损坏可重新同步，安装记录损坏则停止自动处理并保留目录；卸载备份保留原格式。独立 CLI 的分发仍为源码构建，尚未发布到 npm。
