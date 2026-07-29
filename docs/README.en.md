<p align="center">
  <img src="../assets/logo.png" alt="AgentRecall Logo" width="860">
</p>

<h1 align="center">AgentRecall</h1>

<p align="center">A local desktop tool to search, view, and resume AI coding-agent sessions</p>

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

AgentRecall brings back the local sessions scattered across your AI coding agents: it indexes, searches, and shows full context in one place, and lets you resume or migrate a session when you need to. It is designed for personal local use on macOS and Windows.

## Core Features

| Feature | Description |
| --- | --- |
| Unified search | Index sessions across Claude Code, Codex, and a dozen optional sources, with keyword, tag, favorite, time-range, and source filters |
| Full context | View messages, tool calls, Markdown, code blocks, attachments, and AI summaries; export Markdown or common model-request JSON |
| Resume and migrate | Jump back into the original agent from a search result, or migrate sessions between supported local agents |
| Cross-device restore | Sync session snapshots through your own Supabase project, then search, view, and restore them on another device |
| Usage and quota | Track token usage per agent and check Claude Code / Codex quota status |

## Supported Sources

Claude Code and Codex are supported by default. Enable more sources under Settings -> Optional sources.

| Type | Sources |
| --- | --- |
| Default sources | Claude Code CLI, Claude Desktop app, Codex CLI, Codex Desktop |
| Optional local sources | CodeBuddy, CodeWiz, TClaude, TCodex, OpenClaw, Hermes, OpenCode, ZCode, Cursor Agent, Trae, Qoder |
| Extended environments | Windows WSL, SSH remote environments |

Capabilities vary slightly by source; the app shows the available view, resume, migrate, and stats actions per source in the UI. See the [User Guide](./v1/guide.en.md) for the exact file paths each source reads.

## Quick Start

Install **Node.js 22.13+**, then install the latest Release:

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz
agent-recall
```

You can also paste the following paragraph to your AI agent (Claude Code, Codex, etc.) and let it install for you:

> Please install AgentRecall for me: first confirm Node.js 22.13 or newer is available, then run `npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz`. If npm or the Electron download is slow, retry with `--registry=https://registry.npmmirror.com` and the environment variable `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`. After installation, run `agent-recall` to confirm it starts; if anything fails, read https://github.com/zszz3/AgentRecall/blob/main/Install.md to troubleshoot.

| System | Launch command | Default shortcut |
| --- | --- | --- |
| macOS | `agent-recall` | `⌥ Option + Space` |
| Windows | `agent-recall` | `Ctrl + Alt + Space` |

After launch, the app stays in the menu bar or system tray; settings, theme, language, and shortcuts are all adjustable in the app. On macOS, run `agent-recall install-app` to generate a local `AgentRecall.app` you can open from Launchpad / Spotlight / Dock. Update with `agent-recall --update`; full install, update, rollback, uninstall, and mirror notes are in [Install.md](../Install.md) and the [User Guide](./v1/guide.en.md).

## Privacy and Security

- Session indexes and metadata stay in a local SQLite database on your machine and never pass through any third-party server.
- Each agent's original session files are read-only inputs; restore and migration always create new copies and never rewrite the originals.
- Cross-device sync is fully optional and uses your own Supabase project; the app stores only the Project URL and anon key locally.
- No telemetry or usage data is collected.
- The code is fully open source and auditable.

## Advanced Capabilities

- **Remote sync**: After configuring the same Supabase URL and anon key, another device can search and view cloud sessions and restore them into Claude Code, Codex, CodeBuddy, CodeWiz, or Cursor; upload manually, or install the Claude Code / Codex hooks to record pending sessions automatically. Sync is designed for personal projects, and deleting a cloud copy never affects the local session.
- **MCP tools**: The built-in `agent-recall-mcp` lets Claude Code, Codex, CodeBuddy, and others search and read session history in chat, manage tags, favorites, and visibility, or run cross-agent migration.
- **Skills and digital assets**: View, filter, and manage local Codex / Claude Code Skills, and sync Skills, Rules (such as `CLAUDE.md`, `AGENTS.md`, and Qoder rules), and Memories (Qoder / Codex memories) across machines through Supabase.

These capabilities share the same Supabase configuration inside the app and are designed for personal cross-device use. Setup steps and details are in the [User Guide](./v1/guide.en.md).

## Contributing

Issues and PRs are welcome. Local development:

```bash
git clone https://github.com/zszz3/AgentRecall.git
cd AgentRecall
npm ci
npm run dev
```

Before submitting, please read [CONTRIBUTING.md](../CONTRIBUTING.md) and make sure `npm test`, `npm run typecheck`, and `npm run release-note:check` pass. Meet everyone who has contributed on the [contributors page](https://github.com/zszz3/AgentRecall/graphs/contributors).

## Star History

<a href="https://www.star-history.com/?repos=zszz3%2FAgentRecall&type=date&legend=top-left">
  <img src="../assets/star-history.svg" alt="AgentRecall Star History Chart" width="900" />
</a>

## License

This project is licensed under the [MIT License](../LICENSE).

> [!NOTE]
> AgentRecall is an independent open-source project and is not affiliated with Anthropic, OpenAI, Cursor, or any other company. Claude, Codex, and other names and trademarks belong to their respective owners.

If you run into any problems, please open an Issue. If the project helps you, a Star is appreciated.
