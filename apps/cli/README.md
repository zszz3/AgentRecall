# AgentRecall CLI

独立命令 `agentrecall`，用于管理本地项目和可选团队配置。团队默认关闭；本版本不连接远端、不下载资产、不上传 Session，也不要求安装或启动桌面应用。

这是源码预览包，尚未发布到 npm 或桌面 Release 附件。需要 Node.js 22.13+ 和 Git 2.31+。在仓库根目录构建：

```sh
npm run setup:cli
npm run build:cli
node apps/cli/bin/agentrecall.mjs --help
```

若需要安装命令，在 `apps/cli` 目录运行 `npm pack --ignore-scripts`，然后用 `npm install -g <生成的 tgz 文件路径>` 安装。更新时重新构建、打包、安装；卸载使用 `npm uninstall -g agentrecall-cli`，已有配置会保留。

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
