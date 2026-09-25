# AgentRecall CLI 使用与配置

`agentrecall-cli` 是 V2 配套的独立源码预览包，可执行命令为 `agentrecall`。目前提供初始化、配置检查、团队开关、多仓库绑定，以及团队 Skill 的拉取、预览、项目级安装、差异查看、更新与回滚，以及工作配置批量安装、本地归属和整组卸载。需要 Node.js 22.13+、Git 2.31+；不依赖 Electron、PostgreSQL 或 OpenViking。

当前不提供 GitHub 登录、组织成员管理、Session 查询或上传。这里登记的“团队”是本机保存的资产仓库配置，不代表已经加入该组织或取得权限；主动同步使用本机 Git 的既有 HTTPS/SSH 认证。CLI 尚未发布至 npm，也不包含在桌面版本安装包中。构建与安装见 [包说明](../../apps/cli/README.md)。

这些团队功能后续只接入 V2 桌面端；当前 CLI 独立运行，不使用 V1 代码或数据。

## 配置两个团队、三个项目

团队资产仓库保存共享的 AI 工作资产；业务仓库保存项目代码。两者分别登记，同一个团队可以对应多个业务项目。

```sh
agentrecall init
agentrecall team add engineering --repo https://github.com/example/engineering-assets
agentrecall team add research --repo git@github.com:example/research-assets.git
agentrecall team use engineering

# 未指定团队的项目继承默认团队。
agentrecall project add backend --path /path/to/backend
# 显式指定团队的项目不跟随默认团队变化。
agentrecall project add experiments --path /path/to/experiments --team research
# 个人项目不使用团队。
agentrecall project add notes --path /path/to/notes --personal

agentrecall team enable
agentrecall status --project backend
agentrecall team current --project experiments
agentrecall team disable
```

路径需换成已有本地 Git 仓库。绑定和设置默认团队都不会开启团队功能，开启也不会触发网络访问。关闭保留配置和缓存，并阻止团队读取、同步和新安装；配置状态、团队/项目列表和配置编辑仍可用。已复制到客户端的本地 Skill 不会自动删除，可用 `skill uninstall` 移除，或通过 `skill backups` 和 `skill rollback` 管理本地恢复。本地工作配置的 installed/status/uninstall 也仍可使用。当前开关仅作用于 CLI，尚未接入桌面端。

## 命令

| 命令 | 行为 |
| --- | --- |
| `init` | 创建默认关闭的个人配置；重复执行保留现有配置 |
| `status [--project <id>]` | 显示配置路径、当前项目、配置的团队与生效状态 |
| `doctor [--project <id>]` | 检查配置格式及当前目录的 Git 绑定；不测试远端权限或所有历史路径 |
| `team add <id> --repo <url> [--name <名称>]` | 登记团队资产仓库 |
| `team list` | 查看已登记团队 |
| `team use <id>` / `team use --personal` | 设置或清除默认团队 |
| `team enable` / `team disable` | 开启或关闭团队功能 |
| `team current [--project <id>]` | 读取当前生效的项目和团队；未开启、未绑定或个人项目会明确报错 |
| `team sync [--project <id>] [--transport https\|ssh]` | 主动拉取资产仓库默认分支并缓存 Skill，不自动安装 |
| `skill list [--project <id>]` | 查看当前团队已缓存的 Skill |
| `skill preview <id> [--target codex\|claude] [--file <path>] [--project <id>]` | 预览正文、支持文件、完整版本号和可选安装位置 |
| `skill install <id> --target codex\|claude --revision <sha> [--project <id>]` | 安装已选择版本；不同内容或本地修改均不覆盖 |
| `skill diff <id> --target codex\|claude [--file <path>] [--project <id>]` | 查看当前安装与缓存的文件差异；可展开新旧内容 |
| `skill update <id> --target codex\|claude --from-revision <旧 sha> --revision <新 sha> [--project <id>]` | 更新未修改的受管安装，并保留旧版本备份 |
| `skill backups <id> [--project <id>]` | 查看当前客户端安装版本和本地备份；关闭团队后仍可使用 |
| `skill rollback <id> --target codex\|claude --backup <名称> --from-revision <当前 sha\|none> [--project <id>]` | 从指定备份恢复；当前安装另存备份，none 只接受空目标；关闭团队后仍可使用 |
| `skill uninstall <id> --target codex\|claude [--project <id>]` | 移走未修改的受管安装，保留备份；关闭团队后仍可使用 |
| `work-config list [--project <id>]` | 查看团队的工作配置安装清单 |
| `work-config preview <id> [--target codex\|claude] [--project <id>]` | 查看整组 Skill；选择客户端后逐项显示复用、新增或冲突 |
| `work-config install <id> --target codex\|claude --revision <sha> [--project <id>]` | 全部预检后安装并记录共享引用；同版本可重试，不自动更新已安装的配置 |
| `work-config installed [--project <id>]` | 查看本地已安装配置及客户端；可离线使用 |
| `work-config status <id> --target codex\|claude [--project <id>]` | 查看实际文件状态、共享引用及卸载影响；可离线使用 |
| `work-config uninstall <id> --target codex\|claude --revision <sha> [--project <id>]` | 移除配置归属，仅将不再被引用且由配置创建的 Skill 移入备份；可离线使用 |
| `project add <id> [--path <目录>] [--remote <名称>] [--name <名称>] [--team <id>\|--personal]` | 登记业务仓库；路径默认当前目录 |
| `project list` | 查看已登记项目 |
| `project bind <id> --team <id>\|--personal\|--inherit` | 指定团队、改为个人或恢复继承默认团队 |
| `project remove <id>` | 移除本地绑定；不删除代码仓库或团队 |

被工作配置引用的 Skill 不允许单独安装、更新、卸载或回滚；先通过 `work-config status` 查看归属，再处理相关配置。

ID 使用小写字母开头，后续可包含小写字母、数字和连字符，最多 64 个字符。显示名称可使用中文。

所有命令支持 `--json`，成功输出 `{ "ok": true, "data": ... }`，失败输出 `{ "ok": false, "error": { "code": ..., "message": ... } }`。退出码为成功 `0`、配置或运行失败 `1`、命令参数错误 `2`。批量操作未完全成功时，错误可附带 `details`，包含各 Skill 的实际结果、备份路径与待清理项。不带 `--json` 时错误写入标准错误。`--help` 和 `--version` 不访问配置。

`--cwd <目录>` 指定当前操作目录，`--path` 相对于该目录解析。没有跨命令保存的“当前项目”：通常根据当前 Git 仓库判断；在仓库之外可用 `--project` 明确选择。处于已绑定仓库 A 内时指定项目 B 会失败，避免把团队配置用于错误项目。

## 仓库识别

- 支持 GitHub HTTPS、`git@github.com:owner/repo.git` 和 `ssh://git@github.com/owner/repo.git`；统一忽略大小写和末尾 `.git`，fork 的不同 owner 保持独立。不接受 URL 中的凭据、查询参数或其他托管平台。
- 优先选择 `origin`；没有 `origin` 且只有一个 remote 时选择该 remote；多个候选要求 `--remote`。无 remote 的本地 Git 仓库可登记，但不能据此识别其他克隆；后来新增 remote 时需重新登记才会使用其身份。
- 同一仓库的 worktree 通过共享 Git 目录识别为同一项目；新的克隆可通过已选择的 remote 名称及标准化地址匹配已有项目。remote 名称不同需要显式登记，不猜测关联。
- 多个已登记项目指向同一远端时，在新克隆中要求 `--project` 消除歧义。嵌套仓库独立识别，不继承外层仓库配置。
- 已登记仓库的 remote 改变或失效时会失败。恢复原 remote，或用 `project remove` 移除旧绑定后重新 `project add`。只移动目录且远端身份保持一致的新位置仍能按远端匹配；需更新保存路径时也可移除后重建绑定。

## 配置契约

默认位置为 `~/.agentrecall-cli/config.json`；环境变量 `AGENTRECALL_HOME` 可以指定另一目录。它独立于现有桌面应用数据和业务仓库，不扫描个人 Session、Agent 配置或凭据。

```json
{
  "schemaVersion": 1,
  "teamEnabled": false,
  "defaultTeamId": "engineering",
  "teams": [
    { "id": "engineering", "name": "研发", "repository": "https://github.com/example/engineering-assets" },
    { "id": "research", "name": "研究", "repository": "https://github.com/example/research-assets" }
  ],
  "projects": [
    { "id": "backend", "name": "后端", "root": "/work/backend", "gitCommonDir": "/work/backend/.git", "repository": "https://github.com/example/backend", "remote": "origin" },
    { "id": "experiments", "name": "实验", "root": "/work/experiments", "gitCommonDir": "/work/experiments/.git", "repository": "https://github.com/example/experiments", "remote": "origin", "teamId": "research" },
    { "id": "notes", "name": "个人笔记", "root": "/work/notes", "gitCommonDir": "/work/notes/.git", "repository": null, "remote": null, "teamId": null }
  ]
}
```

示例路径是 POSIX 表示；Windows 实际保存本机绝对路径及 JSON 转义。配置含本机路径，不是可分享的资产清单。

优先级为：总开关 → 项目显式团队或个人设置 → 全局默认团队。项目 `teamId` 缺省表示继承，`null` 表示个人，字符串表示显式团队。未绑定项目不会仅因全局设置而使用团队。

`schemaVersion: 1` 是首个格式。未知字段、其他版本、损坏 JSON、重复 ID 或不存在的团队引用均报错并保留原文件，不自动迁移或重置。完整配置连同元数据不得超过 1 MiB。需要手动修复时先备份文件，再运行 `doctor` 检查。

配置服务位于 `packages/workspace-core`。多个 CLI 进程通过同一个目录锁完成读取、校验和原子替换，争用超时明确报错。锁在正常退出时清理，异常终止留下的锁由依赖库按过期时间回收；强制中断不会保证临时文件立即消失。桌面尚未接入此服务，因此本轮验证不代表桌面与 CLI 共享数据库已完成。

## 开发与验证

根目录 `npm run setup:cli` 只安装 CLI 和其共享配置模块的开发依赖，两个桌面应用继续独立安装。执行 `npm run test:cli` 检查配置、并发写入、命令行为和 Git 归属；执行 `npm run package:smoke:cli` 做类型检查、打包和隔离的安装、重装、卸载验证。测试使用临时主目录、npm 前缀和合成仓库。

当前发布工作流仍只发布 V1/V2 桌面包，不自动发布 CLI。后续范围与状态见 [团队功能开发计划](agentrecall-cli-team-plan.md)。

团队资产仓库格式、权限边界和安装恢复见 [团队 Skill 指南](team-assets.md)。资产清单和缓存支持格式版本 1/2，安装记录仍为版本 1；兼容规则和工作配置的范围以团队 Skill 指南为准。未知版本或损坏记录会拒绝读取，不会自动重置。
