<p align="center">
  <img src="../assets/logo.png" alt="AgentRecall Logo" width="860">
</p>

<h1 align="center">AgentRecall</h1>

<p align="center">A local desktop app for searching, viewing, and resuming AI coding-agent sessions</p>

<p align="center">
  <a href="../README.md">简体中文</a> ｜ English
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-555555" alt="platform">
  <img src="https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React">
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.13-339933?logo=nodedotjs&logoColor=white" alt="Node">
  <a href="https://github.com/zszz3/AgentRecall/stargazers"><img src="https://img.shields.io/github/stars/zszz3/AgentRecall?style=flat&logo=github" alt="GitHub Stars"></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

<p align="center">
  <img src="../assets/show.png" alt="AgentRecall preview" width="860">
</p>

AgentRecall brings together sessions scattered across different AI coding agents. You can search past conversations, view their full context, organize important records, and resume, migrate, or restore sessions across devices.

This repository maintains both v1 and v2. They use separate commands, app data, and databases, so they can run side by side but do not automatically share or import data.

## Choose a Version

| Version | Best for | Launch command |
| --- | --- | --- |
| AgentRecall v1 | Managing local and remote agent sessions immediately after installation | `agent-recall` |
| AgentRecall v2 (preview) | Using Workbench, Chat, Workflow, Eval, Runtime, and directory memory on top of session management | `agent-recall-v2` |

## AgentRecall v1

### Features

- **Search and organize sessions**: Index Claude Code, Codex, and enabled optional sources in one place. Filter by keyword, environment, project, source, tag, favorite, hidden state, or time range, and save frequently used searches.
- **View full context**: Read messages, Markdown, code blocks, tool events, and attachments on the detail page. Search within a session and narrow matches to user or assistant messages.
- **Resume, migrate, and export**: Resume the original session from a search result, migrate between supported local agents, or export as Markdown, plain text, or JSON in common model-request formats.
- **Add more session sources**: Claude Code and Codex are enabled by default. Enable CodeBuddy, WorkBuddy, DeepSeek Harness, CodeWiz, TClaude, TCodex, OpenClaw, Hermes, OpenCode, ZCode, Cursor Agent, Trae, and Qoder under **Settings → Optional Sources**. The initial WorkBuddy integration is a local read-only source: it supports searching, viewing, and exporting messages, tool traces, titles, and usage information, but not live tracking, Resume, migration, sync, or opening WorkBuddy from AgentRecall. DeepSeek Harness is disabled by default and indexes local sessions under `${DSH_HOME:-~/.dsh}/sessions` as a read-only source. It supports search, details, export, durable titles, tool traces, token usage, parent/subagent relationships, and attachments, but not live tracking, Resume, migration, sync, opening DeepSeek Harness from AgentRecall, or deleting original session files. Windows WSL and SSH environments can be added separately.
- **AI-assisted retrieval**: Generate session summaries or describe what you want to find in natural language. Summaries and AI session search use the Codex, Claude Code, or custom endpoint selected under Provider.
- **Sync across devices**: Use your own Supabase project to upload sessions manually, or install sync Hooks for Claude Code and Codex. Search, view, and restore cloud sessions on another device.
- **Skills and digital assets**: View and manage local Skills, then sync Skills, Rules, and Memories across devices. Cloud versions can be previewed, installed, or restored.
- **MCP, usage, and quota**: Let Claude Code, Codex, CodeBuddy, and other agents search and organize session history through MCP. Workbench also tracks token usage and displays Claude Code and Codex quota status.

### Install and Launch

Install Node.js 22.13 or later, then install the latest Release:

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz
agent-recall
```

You can also paste the following paragraph into an AI agent such as Claude Code or Codex and let it install AgentRecall for you:

> Please install AgentRecall for me. First confirm that Node.js 22.13 or later is available, then run `npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz`. If npm or Electron downloads are slow, retry with `--registry=https://registry.npmmirror.com` and set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`. After installation, run `agent-recall` to confirm that it starts correctly. If anything fails, see https://github.com/zszz3/AgentRecall/blob/main/Install.md for troubleshooting.

| System | Launch command | Default shortcut |
| --- | --- | --- |
| macOS | `agent-recall` | `⌥ Option + Space` |
| Windows | `agent-recall` | `Ctrl + Alt + Space` |

After launch, the app stays in the menu bar or system tray. Settings, theme, language, and shortcuts can all be changed in the app. On macOS, run `agent-recall install-app` to create a local `AgentRecall.app`, which you can then open from Launchpad, Spotlight, or the Dock. Run `agent-recall --update` to update. See [Install.md](../Install.md) for complete installation, update, rollback, uninstall, and mirror instructions.

> For more detailed usage instructions, see the [AgentRecall v1 Guide](./v1/guide.en.md).

## AgentRecall v2 (Preview)

In addition to session management, remote sync, and usage statistics, v2 adds reusable Agents, multi-agent Chat, Workflow, Eval, MCP, directory memory, and a Skill library.

### Features

- **Workbench and Sessions**: View usage, model quotas, and recent activity. Search, filter, and organize sessions from different sources. The detail page supports in-session search, Resume, migration, export, AI summaries, and remote restore.
- **Runtime and Agents**: Prepare execution configurations for Codex, Claude Code, API, Hermes, OpenCode, or OpenClaw, then save Agents with fixed models and purpose descriptions for reuse in Chat, Workflow, Eval, and MCP.
- **Multi-agent Chat**: Create a studio with a shared project directory while each employee keeps an independent context. Use `@name` or the recipient list to request responses from one or more Agents.
- **Workflow**: Describe a task and answer the planning Agent's follow-up questions. Generate, review, and confirm a workflow diagram before running Agent or script nodes. During execution, you can handle follow-up questions, approvals, artifacts, and error recovery.
- **Eval**: Run an Agent repeatedly against a fixed dataset and evaluators, then review average scores, pass rates, failed cases, evaluation reasons, and historical results.
- **MCP**: Register and test STDIO or HTTP MCP Servers, inspect their tool lists, and bind the services you need to new sessions for selected Agents.
- **Directory Memory**: Create isolated long-term memory for each project directory you select. Import past sessions, maintain manual memories, and enable automatic recall for Codex, Claude Code, or OpenCode.
- **Skills and Provider**: View local Skills or discover Skills from public repositories, add them to the Skill library, and install them for coding agents such as Codex and Claude Code. The Provider page separately manages the services used by local Codex, Claude Code, and session AI features.

### Install and Launch

Install Node.js 22.13 or later, then install the latest v2 Release:

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/download/v2-latest/agent-recall-v2.tgz
agent-recall-v2
```

| System | Launch command | Default shortcut |
| --- | --- | --- |
| macOS | `agent-recall-v2` | `⌥ Option + Space` |
| Windows | `agent-recall-v2` | `Ctrl + Alt + Space` |

After launch, the app stays in the menu bar or system tray and prepares its local data service automatically, so you do not need to install PostgreSQL separately. On macOS, run `agent-recall-v2 install-app` to create a local `agent-recall-v2.app` that opens from Launchpad, Spotlight, or the Dock. Run `agent-recall-v2 --update` to update, or check for updates from **Settings → About** inside the app.

v2 uses separate commands, app data, a database, MCP identifiers, and an update cache from v1. It does not currently read or import v1 data, and both versions can be installed and run at the same time. See [Install.md](../Install.md) for complete installation, update, rollback, and uninstall instructions.

> For more detailed usage instructions, see the [AgentRecall v2 Guide](./v2/guide.md).

## Privacy and Security

- Session indexes and metadata are stored locally and do not pass through any third-party service provided by AgentRecall.
- Each agent's original session files are used only as read sources. Restore and migration create new copies.
- Cross-device sync is fully optional and uses your own Supabase project.
- AI summaries, AI search, and automatic memory send relevant content to the Provider you select. You decide whether to enable these features.
- AgentRecall does not collect telemetry or usage data, and the project source code is public in this repository.

## Contributing

Issues and PRs are welcome. For local development:

```bash
git clone https://github.com/zszz3/AgentRecall.git
cd AgentRecall
npm run setup:v1
npm run dev:v1
```

When developing `agent-recall-v2`, use `npm run setup:v2` and `npm run dev:v2` instead. On Windows, run the terminal as an administrator the first time you execute `npm run setup:v2` so it can create the symlinks required by the bundled PostgreSQL runtime. The two apps live under `apps/main-1.0` and `apps/main-2.0`, while root-level commands run shared tests, type checks, and builds.

Before submitting, read [CONTRIBUTING.md](../CONTRIBUTING.md) and make sure `npm test`, `npm run typecheck`, and `npm run release-note:check` pass.

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
  <img src="../assets/star-history.svg" alt="AgentRecall Star History Chart" width="900" />
</a>

## License

This project is open source under the [MIT License](../LICENSE).

> [!NOTE]
> AgentRecall is an independent open-source project and is not affiliated with Anthropic, OpenAI, Cursor, or any other company. Claude, Codex, and other names and trademarks belong to their respective owners.

If you have any questions, please open an Issue. If the project helps you, a Star is appreciated.
