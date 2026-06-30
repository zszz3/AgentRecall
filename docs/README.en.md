<h1 align="center">Agent-Session-Search</h1>

<p align="center">A local desktop tool to search, quick launch, and analyze AI coding-agent sessions</p>

<p align="center">
  <a href="../README.md">简体中文</a> ｜ English
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-555555" alt="platform">
  <img src="https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React">
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.13-339933?logo=nodedotjs&logoColor=white" alt="Node">
</p>

<p align="center">
  <img src="../assets/show.png" alt="Agent-Session-Search preview" width="860">
</p>

## Features

### Core Features

- **Unified search and management for AI coding-agent sessions**:
  Search, filter, inspect, organize, and quick launch Claude Code, Codex, and optional sessions from CodeBuddy, OpenClaw, Hermes, OpenCode, Cursor Agent, and Trae; add custom titles, tags, favorites, pinned state, and hidden state; local and SSH remote environments are supported without installing this app on the remote machine.
- **Full session context view**:
  The detail view shows complete messages, tool calls, Markdown / code blocks, and supports AI summaries plus Markdown export.
- **AI / Agent-assisted session retrieval**:
  Use AI summaries to improve history search, ask for sessions in natural language, and expose read-only MCP capabilities so Claude Code / Codex / CodeBuddy can search and read session history directly in chat.
- **Cross-agent session migration**:
  Migrate Claude / Codex / CodeBuddy sessions into another agent and continue from the migrated session.
- **Unified agent usage and quota view**:
  Track token usage by agent for today, 7 days, 30 days, and all time; also view current Claude Code / Codex quota status.
- **Unified Skills and API Provider management**:
  View and manage Claude Code / Codex skills, track skill usage, sync personal skills across machines through your own Supabase project, and switch Codex / Claude Code between official accounts and third-party API providers.

## Supported Sources

| Source | Local files |
| --- | --- |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` |
| Codex Desktop | `~/.codex/sessions/**/*.jsonl`, detected by session metadata |
| Claude Code CLI | `~/.claude/projects/*/*.jsonl` plus optional `~/.claude/sessions/*.json` metadata |
| Claude Desktop app | `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json` plus Claude Code project logs |
| CodeBuddy CLI | Optional in settings; reads `~/.codebuddy/projects/**/*.jsonl` |
| OpenClaw | Optional in settings; reads `~/.openclaw/agents/*/sessions/*.jsonl`, legacy `~/.clawdbot/agents/*/sessions/*.jsonl`, excluding `*.trajectory.jsonl` |
| Hermes | Optional in settings; reads `~/.hermes/state.db` |
| OpenCode | Optional in settings; reads `~/.local/share/opencode/opencode.db` |
| Cursor Agent | Optional in settings; reads `~/.cursor/projects/**/agent-transcripts/**/*.jsonl` |
| Trae | Optional in settings; reads `~/.trae-cn/memory/projects/**/session_memory_*.jsonl`; open-state detection reads Trae's local workspace state database |
| SSH remote environment | Reads the same Codex / Claude Code session paths under the remote user's home directory over SSH |

Codex title metadata is read from `~/.codex/session_index.jsonl` when that file exists. If no upstream title is available, the app uses the first meaningful user question as the default title.

CodeBuddy CLI, OpenClaw, Hermes, OpenCode, Cursor Agent, and Trae are off by default and can be selected from Settings -> Optional sources. Once enabled, they support local read-only indexing, search, details, and source filtering. Resume, SSH remote sync, and provider-specific usage stats for these sources are intentionally separate follow-up work. Trae also supports open-state detection.

## Skills Management and Sync

The Skills window lists installed Codex / Claude Code skills, lets you filter by source, inspect usage counts, preview `SKILL.md`, copy paths, reveal skill folders, and delete non-system skills.

To sync your personal skills between machines, enable Settings -> Skills -> Supabase skill sync:

1. Create or select a project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Copy the Project URL and anon key from Project Settings -> API.
3. Paste them into Settings -> Skills and enable Supabase sync.
4. If the remote table does not exist yet, open the Remote view in the Skills window, click Copy setup SQL, and run it once in the Supabase SQL Editor.
5. In the Local view, select a local skill and click Upload. A stable fingerprint identifies skills by agent and name, so repeat uploads update the existing remote record.
6. On another machine, configure the same Supabase URL and anon key, open the Remote view, then click Install locally / Update local.

Sync uploads the full skill directory's regular files, including `SKILL.md`, `references/`, `scripts/`, examples, and other supporting files. Downloads restore them into the local user skill root. Codex skills install into `$CODEX_HOME/skills` or `~/.codex/skills`; Claude Code skills install into `~/.claude/skills`.

Supabase sync is designed for personal projects. It does not create tables automatically and does not require a service role key. The app stores only the Project URL and anon key locally, then uses the Supabase REST API to access the `agent_session_search_skills` table. The copied setup SQL grants anon read/write access through RLS for personal sync convenience; adjust the RLS policy first if you plan to share the project with other users or expose it more broadly.

## Installation

### macOS

Requires Node.js 22.13+ (with npm). From the repository root, run these commands to install dependencies, build, and register the global command:

```bash
nvm install 22
nvm use 22
npm ci
npm run build
npm install -g .
```

If you do not use nvm, make sure `node --version` is 22.13 or newer, then start from `npm ci`.

Once installed, run `agent-session-search` from any terminal to launch it. The app stays in the background (with a menu bar icon); press **⌥ Option + Space** by default to open the search window. If it conflicts with Raycast or another launcher, change or disable the global shortcut in Settings.

Settings can also be opened with `Cmd+,`. Use Appearance to switch the color theme and English / Chinese UI.

For daily use, you do not need to reinstall dependencies or rebuild. Just run:

```bash
agent-session-search
```

If a new terminal says `agent-session-search: command not found`, the global command was probably installed under nvm's Node 22 directory while the current shell is using another Node version. Run:

```bash
nvm use 22
agent-session-search
```

Or set Node 22 as your nvm default once:

```bash
nvm alias default 22
```

If you do not use nvm and have Node.js 22.13+ installed system-wide, daily startup does not need any nvm command.

### Windows

With Node.js 22.13+ installed, run this from the repository root in PowerShell:

```powershell
npm ci && npm run build && npm install -g .
```

Once installed, run `agent-session-search` from any terminal to launch it. The app stays in the background (with a taskbar/tray icon); press **Ctrl + Alt + Space** by default to open the search window.

See [Install.md](../Install.md) for updating, uninstalling, installing from a fresh clone, and network mirror tips.

## Development Setup

Requirements:

- macOS or Windows
- Node.js 22.13 or newer
- npm

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Start the desktop app in development mode:

```bash
npm run dev
```

Build the app bundle output:

```bash
npm run build
```

## Repository Notes

- `README.md` is the Chinese project overview for users and developers.
- `docs/README.en.md` is the English project overview.
- `Install.md` covers install, update, and uninstall steps, plus a safe setup guide for Coding Agents.
