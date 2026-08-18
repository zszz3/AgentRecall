<p align="center">
  <img src="./assets/logo.png" alt="agent-recall-v2 Logo" width="860">
</p>

<h1 align="center">agent-recall-v2</h1>

<p align="center">AgentRecall 的独立 V2 预览版</p>

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
  <img src="./assets/show.png" alt="agent-recall-v2 界面预览" width="860">
</p>

`agent-recall-v2` 是仓库中的独立预览版应用。它和 AgentRecall 1.0 拥有不同的包名、命令、应用数据目录、数据库、更新缓存与 MCP 标识，可以同时运行；当前不读取或导入 V1 的 SQLite 数据。

## 快速开始

准备 **Node.js 22.13+**，安装最新的 V2 Release：

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/download/v2-latest/agent-recall-v2.tgz
agent-recall-v2
```

`agent-recall-v2` 使用与 AgentRecall 1.0 分开的 Release 安装包和更新通道；执行 `agent-recall-v2 --update` 可以升级到最新版本。完整的安装、更新、卸载和数据边界说明见 [Install.md](./Install.md)。

## 核心能力

- **统一搜索会话**：索引 Claude Code、Codex 以及可选的 CodeBuddy、WorkBuddy、CodeWiz、Cursor Agent、Qoder、Trae、WSL、SSH 等来源，支持关键词、标签、收藏、隐藏、时间范围和来源筛选，收藏的会话会优先展示。
- **查看完整上下文**：在详情页查看消息、工具调用、Markdown、代码块、附件和 AI 摘要，并可导出 Markdown 或常见模型请求 JSON。
- **继续和迁移会话**：从搜索结果快速启动原 Agent，也可在支持的本地 Agent 之间迁移会话。
- **跨设备恢复**：可使用自己的 Supabase 项目同步会话快照，在另一台设备搜索、查看并恢复会话。
- **用量与额度概览**：统计各 Agent token 使用量，并查看 Claude Code / Codex 的额度状态。
- **目录级长期记忆**：在 Memory 页面为主动选择的目录启用相互隔离的 OpenViking 记忆，只增量捕获开启后的新对话，并为 Codex、Claude Code 和 OpenCode 配置自动召回；历史会话继续通过 Session 搜索按需复用。
- **多 Agent 工作室**：在同一个工作室中创建和复用多个独立 Agent 会话，共享工作目录，并通过受控的 MCP 能力协作。

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

## 远程同步

远程同步使用你自己的 Supabase 项目保存会话快照和附件。配置同一个 Supabase URL 与 anon key 后，另一台设备可以：

- 搜索和查看云端会话；
- 恢复到 Claude Code、Codex、CodeBuddy、CodeWiz 或 Cursor；
- 手动上传，或安装 Claude Code / Codex Hook 后自动记录待同步会话。

同步按个人项目设计，不提供多用户隔离。删除云端副本不会删除本地会话，恢复也会创建新的本地副本。

## MCP 工具

应用内置一个 stdio MCP 服务器（`agent-recall-v2-mcp`），让 Claude Code / Codex / CodeBuddy 在对话里直接搜索、读取历史会话，并管理标签、收藏、可见性，以及跨 Agent 迁移会话。应用会自动安装并管理本地数据运行时，不需要用户另外安装 PostgreSQL。首次打开后会写入权限受限的连接指针（`~/.agent-recall-v2/database-url`），MCP 服务器据此连接同一份数据；高级部署也可用 `AGENT_RECALL_DATABASE_URL` 环境变量覆盖。

## Skills 与数字资产

`agent-recall-v2` 也提供轻量的 Skills、Rules 和 Memories 管理能力：

- 查看、筛选和管理本机 Codex / Claude Code Skills；
- 使用 Supabase 在多台机器间同步用户 Skills；
- 同步 Rules（如 `CLAUDE.md`、Qoder rules）和 Memories（Qoder / Codex 记忆）。

这些能力复用应用内的 Supabase 配置，适合个人跨设备使用。

## Eval（实验性，默认关闭）

在设置中开启 Eval 并安装使用统计 Hook 后，Eval 页可以按 Skill 回看真实使用情况：

- Skill 列表即体检总表：触发次数、近 7 天趋势、最近触发时间，已装未用的 Skill 直接标出；
- 实况报告展示触发轮次的 token 消耗、耗时、出错占比（与全库中位数对照），并按 Skill 内容版本切分触发分布；
- 每次触发可直接打开所在会话；Codex 会话中的触发自动关联，早期没有关联信息的记录会如实标注为"未关联"；
- 所有结论标注证据强度与样本量：样本不足如实提示，Hook 未安装时显示"观测不到"而不是"没用过"；
- 回归评测闭环：为 Skill 自定义测试用例（输入 + 可选期望输出），内置 LLM 评审开箱即用；运行实时显示进度、可取消，逐用例证据（输出、分数、中文评审理由）完整可见；改动 Skill 后重跑，两次运行逐用例对比，回答"变好了还是变坏了"；
- 所有分析只读取本机已索引的数据。

## 开发者本地运行

```bash
git clone https://github.com/zszz3/AgentRecall.git
cd AgentRecall
npm run setup:v2
npm run dev:v2
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run dev:v2` | 启动 `agent-recall-v2` |
| `npm run test:v2` | 运行 V2 自动化测试 |
| `npm run typecheck` | 检查 V1 和 V2 的 TypeScript 类型 |
| `npm run build` | 构建 V1 和 V2 |
| `npm run release-note:check` | 检查当前分支的用户更新说明 |

验证正式安装包可运行：

```bash
npm run build
npm run package:smoke:v2
```

更多安装和故障排查见 [Install.md](./Install.md)。

## 仓库文档

- [Install.md](./Install.md)：安装、更新、卸载和环境说明。
- [docs/README.en.md](./docs/README.en.md)：英文 README。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。

目录记忆按需下载的 OpenViking 独立运行时及本地向量模型保留各自的上游许可，详情见 [第三方许可说明](./THIRD_PARTY_NOTICES.md)。

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
                <a href="https://github.com/LANSGANBS">
                    <img src="https://avatars.githubusercontent.com/u/144577410?v=4" width="80;" alt="LANSGANBS"/>
                    <br />
                    <sub><b>LANSGANBS</b></sub>
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
                <a href="https://github.com/CuSO41108">
                    <img src="https://avatars.githubusercontent.com/u/177388097?v=4" width="80;" alt="CuSO41108"/>
                    <br />
                    <sub><b>CuSO41108</b></sub>
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
