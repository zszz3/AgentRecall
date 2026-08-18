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

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 统一搜索 | 跨 Claude Code、Codex 及十余种可选来源索引会话，支持关键词、标签、收藏、时间范围和来源筛选 |
| 完整上下文 | 查看消息、工具调用、Markdown、代码块、附件和 AI 摘要，可导出 Markdown 或常见模型请求 JSON |
| 继续与迁移 | 从搜索结果一键回到原 Agent 继续对话，或在支持的本地 Agent 之间迁移会话 |
| 跨设备恢复 | 通过你自己的 Supabase 项目同步会话快照，在另一台设备搜索、查看并恢复 |
| 用量与额度 | 统计各 Agent 的 token 使用量，查看 Claude Code / Codex 的额度状态 |

## 支持的数据源

默认支持 Claude Code 和 Codex。更多来源可在 Settings -> Optional sources 中开启。

| 类型 | 来源 |
| --- | --- |
| 默认来源 | Claude Code CLI、Claude Desktop app、Codex CLI、Codex Desktop |
| 可选本地来源 | CodeBuddy、WorkBuddy、DeepSeek Harness、CodeWiz、TClaude、TCodex、OpenClaw、Hermes、OpenCode、ZCode、Cursor Agent、Trae、Qoder |
| 扩展环境 | Windows WSL、SSH 远程环境 |

不同来源的可用能力略有差异；应用会在界面中按来源展示可用的查看、恢复、迁移和统计操作。

WorkBuddy 首版是只读本地来源，可搜索、查看和导出会话中的消息、工具轨迹、标题及用量信息；暂不支持实时跟踪、Resume、迁移、同步或从 AgentRecall 打开 WorkBuddy。

DeepSeek Harness 默认关闭，以只读方式索引 `${DSH_HOME:-~/.dsh}/sessions` 下的本机会话，支持搜索、详情、导出、标题、工具轨迹、Token 用量、父子会话和附件；暂不支持实时跟踪、Resume、迁移、同步、从 AgentRecall 打开 DeepSeek Harness，或删除原始会话文件。

## 快速开始

准备 **Node.js 22.13+**，安装最新 Release：

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz
agent-recall
```

也可以把下面这段话直接贴给你的 AI Agent（Claude Code、Codex 等），让它帮你安装：

> 请帮我安装 AgentRecall：先确认 Node.js 22.13 或更高版本可用，然后执行 `npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz`。如果 npm 或 Electron 下载缓慢，追加 `--registry=https://registry.npmmirror.com` 并设置环境变量 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重试。安装完成后运行 `agent-recall` 确认能正常启动；遇到问题请阅读 https://github.com/zszz3/AgentRecall/blob/main/Install.md 排查。

| 系统 | 启动命令 | 默认快捷键 |
| --- | --- | --- |
| macOS | `agent-recall` | `⌥ Option + Space` |
| Windows | `agent-recall` | `Ctrl + Alt + Space` |

启动后应用会常驻菜单栏或系统托盘，设置、主题、语言和快捷键都可以在应用内调整。macOS 上执行 `agent-recall install-app` 可以生成本地 `AgentRecall.app`，之后直接从 Launchpad / Spotlight / Dock 打开。更新执行 `agent-recall --update` 即可；完整安装、更新、回滚、卸载和国内镜像说明见 [Install.md](./Install.md)。

## 隐私与安全

- 会话索引与元数据只保存在本机 SQLite 数据库中，不经过任何第三方服务器。
- 各 Agent 的原始会话文件仅作为只读输入；恢复与迁移都会创建新副本，不改写原始会话。
- 跨设备同步完全可选，使用你自己的 Supabase 项目；应用只在本地保存 Project URL 与 anon key。
- 不收集任何遥测或使用数据。
- 代码完全开源，行为可审计。

## 进阶能力

- **远程同步**：配置同一个 Supabase URL 与 anon key 后，另一台设备可以搜索、查看云端会话，并恢复到 Claude Code、Codex、CodeBuddy、CodeWiz 或 Cursor；支持手动上传，也可以安装 Claude Code / Codex Hook 自动记录待同步会话。同步按个人项目设计，删除云端副本不会影响本地会话。
- **MCP 工具**：内置 `agent-recall-mcp`，让 Claude Code、Codex、CodeBuddy 等在对话中搜索和读取历史会话，并管理标签、收藏、可见性或执行跨 Agent 迁移。
- **Skills 与数字资产**：查看、筛选和管理本机 Codex / Claude Code Skills，并通过 Supabase 在多台机器间同步 Skills、Rules（如 `CLAUDE.md`、`AGENTS.md`、Qoder rules）和 Memories（Qoder / Codex 记忆）。

这些能力复用应用内的同一份 Supabase 配置，适合个人跨设备使用。

## 参与贡献

欢迎提交 Issue 和 PR。本地开发：

```bash
git clone https://github.com/zszz3/AgentRecall.git
cd AgentRecall
npm ci
npm run dev
```

提交前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，并确保 `npm test`、`npm run typecheck` 与 `npm run release-note:check` 通过。

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

## Star History

<a href="https://www.star-history.com/?repos=zszz3%2FAgentRecall&type=date&legend=top-left">
  <img src="./assets/star-history.svg" alt="AgentRecall Star History Chart" width="900" />
</a>

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。

> [!NOTE]
> AgentRecall 是独立的开源项目，与 Anthropic、OpenAI、Cursor 等公司均无关联。Claude、Codex 等名称与商标归其各自所有者所有。

有任何问题，请提交 Issue。如果觉得项目对你有帮助，欢迎 Star。
