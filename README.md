<p align="center">
  <img src="./assets/logo.png" alt="AgentRecall Logo" width="860">
</p>

<h1 align="center">AgentRecall</h1>

<p align="center">本地桌面工具 · 搜索、查看、恢复 AI Coding Agent 会话</p>

<p align="center">
  简体中文 ｜ <a href="./docs/README.en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-555555" alt="platform">
  <img src="https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React">
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.13-339933?logo=nodedotjs&logoColor=white" alt="Node">
  <a href="https://github.com/zszz3/AgentRecall/stargazers"><img src="https://img.shields.io/github/stars/zszz3/AgentRecall?style=flat&logo=github" alt="GitHub Stars"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

<p align="center">
  <img src="./assets/show.png" alt="AgentRecall 界面预览" width="860">
</p>

AgentRecall 帮你把分散在不同 AI Coding Agent 里的本地会话找回来：统一索引、搜索、查看上下文，并在需要时继续或迁移会话。它优先面向个人本地使用，支持 macOS 与 Windows。

## 快速开始

准备 **Node.js 22.13+**，安装最新 Release：

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz
agent-recall
```

国内网络可使用 npm 与 Electron 镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz \
  --registry=https://registry.npmmirror.com
```

| 系统 | 启动命令 | 默认快捷键 |
| --- | --- | --- |
| macOS | `agent-recall` | `⌥ Option + Space` |
| Windows | `agent-recall` | `Ctrl + Alt + Space` |

启动后应用会常驻菜单栏或系统托盘。设置、主题、语言和快捷键都可以在应用内调整。完整安装、更新、回滚和卸载说明见 [Install.md](./Install.md)。

常用更新命令：

```bash
agent-recall --check-update
agent-recall --update
```

## 核心能力

- **统一搜索会话**：索引 Claude Code、Codex 以及可选的 CodeBuddy、CodeWiz、Cursor Agent、Qoder、Trae、WSL、SSH 等来源，支持关键词、标签、收藏、置顶、隐藏、时间范围和来源筛选。
- **查看完整上下文**：在详情页查看消息、工具调用、Markdown、代码块、附件和 AI 摘要，并可导出 Markdown 或常见模型请求 JSON。
- **继续和迁移会话**：从搜索结果快速启动原 Agent，也可在支持的本地 Agent 之间迁移会话。
- **跨设备恢复**：可使用自己的 Supabase 项目同步会话快照，在另一台设备搜索、查看并恢复会话。
- **用量与额度概览**：统计各 Agent token 使用量，并查看 Claude Code / Codex 的额度状态。

## 支持的数据源

默认支持 Claude Code 和 Codex。更多来源可在 Settings -> Optional sources 中开启。

| 类型 | 来源 |
| --- | --- |
| 默认来源 | Claude Code CLI、Claude Desktop app、Codex CLI、Codex Desktop |
| 可选本地来源 | CodeBuddy、CodeWiz、TClaude、TCodex、OpenClaw、Hermes、OpenCode、ZCode、Cursor Agent、Trae、Qoder |
| 扩展环境 | Windows WSL、SSH 远程环境 |

不同来源的可用能力略有差异；应用会在界面中按来源展示可用的查看、恢复、迁移和统计操作。

## 远程同步

远程同步使用你自己的 Supabase 项目保存会话快照和附件。配置同一个 Supabase URL 与 anon key 后，另一台设备可以：

- 搜索和查看云端会话；
- 恢复到 Claude Code、Codex、CodeBuddy、CodeWiz 或 Cursor；
- 手动上传，或安装 Claude Code / Codex Hook 后自动记录待同步会话。

同步按个人项目设计，不提供多用户隔离。删除云端副本不会删除本地会话，恢复也会创建新的本地副本。

## MCP 工具

应用内置 `agent-recall-mcp`，可让 Claude Code、Codex、CodeBuddy 等在对话中搜索和读取历史会话，并管理标签、收藏、可见性或执行跨 Agent 迁移。首次打开应用后会写入数据库指针；也可用 `AGENT_RECALL_DB` 指定数据库路径。

## Skills 与数字资产

AgentRecall 也提供轻量的 Skills、Rules 和 Memories 管理能力：

- 查看、筛选和管理本机 Codex / Claude Code Skills；
- 使用 Supabase 在多台机器间同步用户 Skills；
- 同步 Rules（如 `CLAUDE.md`、Qoder rules）和 Memories（Qoder / Codex 记忆）。

这些能力复用应用内的 Supabase 配置，适合个人跨设备使用。

## 开发者本地运行

```bash
git clone https://github.com/zszz3/AgentRecall.git
cd AgentRecall
npm ci
npm run dev
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Electron 开发版 |
| `npm test` | 运行自动化测试 |
| `npm run typecheck` | 检查 TypeScript 类型 |
| `npm run build` | 生成生产构建 |
| `npm run release-note:check` | 检查当前分支的用户更新说明 |

验证正式安装包可运行：

```bash
npm run build
npm run package:smoke
```

更多安装和故障排查见 [Install.md](./Install.md)。

## 仓库文档

- [Install.md](./Install.md)：安装、更新、卸载和环境说明。
- [docs/README.en.md](./docs/README.en.md)：英文 README。
- [start.sh](./start.sh)：macOS 一键启动脚本。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。

## 贡献者

### Collaborators

<!-- readme: collaborators -start -->
<table>
	<tbody>
		<tr>
            <td align="center">
                <a href="https://github.com/Blue-Berrys">
                    <img src="https://avatars.githubusercontent.com/u/75206464?v=4" width="80;" alt="Blue-Berrys"/>
                    <br />
                    <sub><b>Blue-Berrys</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/G-Pegasus">
                    <img src="https://avatars.githubusercontent.com/u/87853009?v=4" width="80;" alt="G-Pegasus"/>
                    <br />
                    <sub><b>G-Pegasus</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/zszz3">
                    <img src="https://avatars.githubusercontent.com/u/91608029?v=4" width="80;" alt="zszz3"/>
                    <br />
                    <sub><b>zszz3</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/mesakurax">
                    <img src="https://avatars.githubusercontent.com/u/140772694?v=4" width="80;" alt="mesakurax"/>
                    <br />
                    <sub><b>mesakurax</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/LANSGANBS">
                    <img src="https://avatars.githubusercontent.com/u/144577410?v=4" width="80;" alt="LANSGANBS"/>
                    <br />
                    <sub><b>LANSGANBS</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/forbbiden1">
                    <img src="https://avatars.githubusercontent.com/u/153357541?v=4" width="80;" alt="forbbiden1"/>
                    <br />
                    <sub><b>forbbiden1</b></sub>
                </a>
            </td>
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/MeloMei">
                    <img src="https://avatars.githubusercontent.com/u/225048942?v=4" width="80;" alt="MeloMei"/>
                    <br />
                    <sub><b>MeloMei</b></sub>
                </a>
            </td>
		</tr>
	<tbody>
</table>
<!-- readme: collaborators -end -->

### Contributors

<!-- readme: contributors -start -->
<table>
	<tbody>
		<tr>
            <td align="center">
                <a href="https://github.com/Blue-Berrys">
                    <img src="https://avatars.githubusercontent.com/u/75206464?v=4" width="80;" alt="Blue-Berrys"/>
                    <br />
                    <sub><b>Blue-Berrys</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/zszz3">
                    <img src="https://avatars.githubusercontent.com/u/91608029?v=4" width="80;" alt="zszz3"/>
                    <br />
                    <sub><b>zszz3</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/mesakurax">
                    <img src="https://avatars.githubusercontent.com/u/140772694?v=4" width="80;" alt="mesakurax"/>
                    <br />
                    <sub><b>mesakurax</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/MeloMei">
                    <img src="https://avatars.githubusercontent.com/u/225048942?v=4" width="80;" alt="MeloMei"/>
                    <br />
                    <sub><b>MeloMei</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/LANSGANBS">
                    <img src="https://avatars.githubusercontent.com/u/144577410?v=4" width="80;" alt="LANSGANBS"/>
                    <br />
                    <sub><b>LANSGANBS</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/G-Pegasus">
                    <img src="https://avatars.githubusercontent.com/u/87853009?v=4" width="80;" alt="G-Pegasus"/>
                    <br />
                    <sub><b>G-Pegasus</b></sub>
                </a>
            </td>
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/MSHLD">
                    <img src="https://avatars.githubusercontent.com/u/102949095?v=4" width="80;" alt="MSHLD"/>
                    <br />
                    <sub><b>MSHLD</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/275145">
                    <img src="https://avatars.githubusercontent.com/u/79244504?v=4" width="80;" alt="275145"/>
                    <br />
                    <sub><b>275145</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/wlh26">
                    <img src="https://avatars.githubusercontent.com/u/145627315?v=4" width="80;" alt="wlh26"/>
                    <br />
                    <sub><b>wlh26</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/vinkiYu">
                    <img src="https://avatars.githubusercontent.com/u/239156258?v=4" width="80;" alt="vinkiYu"/>
                    <br />
                    <sub><b>vinkiYu</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/wanglongze123">
                    <img src="https://avatars.githubusercontent.com/u/278380769?v=4" width="80;" alt="wanglongze123"/>
                    <br />
                    <sub><b>wanglongze123</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/CuSO41108">
                    <img src="https://avatars.githubusercontent.com/u/177388097?v=4" width="80;" alt="CuSO41108"/>
                    <br />
                    <sub><b>CuSO41108</b></sub>
                </a>
            </td>
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/forbbiden1">
                    <img src="https://avatars.githubusercontent.com/u/153357541?v=4" width="80;" alt="forbbiden1"/>
                    <br />
                    <sub><b>forbbiden1</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/puppyben1">
                    <img src="https://avatars.githubusercontent.com/u/136492871?v=4" width="80;" alt="puppyben1"/>
                    <br />
                    <sub><b>puppyben1</b></sub>
                </a>
            </td>
		</tr>
	<tbody>
</table>
<!-- readme: contributors -end -->

## Star History

<a href="https://www.star-history.com/?repos=zszz3%2FAgentRecall&type=date&legend=top-left">
  <img src="./assets/star-history.svg" alt="AgentRecall Star History Chart" width="900" />
</a>

有任何问题，请提交issue。如果觉得我们的项目还不错，欢迎star✨。
