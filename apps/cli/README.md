# AgentRecall CLI

V2 配套独立命令 `agentrecall`，用于管理本地项目和可选团队配置，主动拉取、预览、安装、更新和回滚团队 Skill。团队默认关闭；`init <仓库地址>` 可初始化空团队仓库，`team sync` 主动读取资产，不上传 Session，也不要求安装或启动桌面应用。

这是源码预览包，尚未发布到 npm 或桌面 Release 附件。需要 Node.js 22.13+ 和 Git 2.31+。在仓库根目录构建：

```sh
npm run setup:cli
npm run build:cli
node apps/cli/bin/agentrecall.mjs --help
```

若需要安装命令，在 `apps/cli` 目录运行 `npm pack --ignore-scripts`，然后用 `npm install -g <生成的 tgz 文件路径>` 安装。更新时重新构建、打包、安装；卸载使用 `npm uninstall -g agentrecall-cli`，已有配置会保留。

空团队仓库可运行 `agentrecall init <GitHub 仓库地址>`：会在远端提交基础模板并登记本地团队，重复运行不覆盖已有资产。只需保存地址时使用下面的 `team add` 流程。

```sh
agentrecall init
agentrecall team add engineering --repo https://github.com/example/ai-assets
agentrecall team use engineering
agentrecall project add backend --path /path/to/backend
agentrecall team enable
agentrecall status --project backend
```

上面的地址是示例，需要换成自己的资产仓库地址。所有命令支持 `--json`。配置默认保存在 `~/.agentrecall-cli/config.json`，可用 `AGENTRECALL_HOME` 指定独立目录，不读取桌面数据库或原始 Agent 会话。

完整的命令、项目识别、配置格式和限制见仓库中的 [CLI 使用与配置](../../docs/v2/cli.md)，或在线查看 [使用指南](https://github.com/zszz3/AgentRecall/blob/main/docs/v2/cli.md)。

登记项目后，使用 `team sync`、`skill list` 和 `skill preview <id>` 查看团队资产。安装时必须显式提供目标客户端和预览中的版本。更新前用 `skill diff` 查看变化，`skill update` 保存旧版本备份，`skill backups` 和 `skill rollback` 可在离线时恢复。资产仓库格式、安装与恢复流程见 [团队 Skill 指南](../../docs/v2/team-assets.md)。

团队可使用 `work-config list/preview/install` 选择一组 Skill。安装后可用 `work-config installed/status/uninstall` 查看归属和整组卸载，共用 Skill 与原有独立安装会保留。整组升级使用 `work-config diff/update` 并指定新旧版本；共享内容冲突会阻止更新。跨配置协调升级和其他资产类型尚未提供。
