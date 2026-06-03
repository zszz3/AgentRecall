<h1 align="center">Agent-Session-Search</h1>

<p align="center">A local desktop tool to search, organize, and resume your Claude Code / Codex / CodeBuddy session history in one place</p>

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

Agent-Session-Search is a local desktop console for finding, organizing, and resuming Claude Code and Codex sessions.

It indexes existing local session files, lets you add your own titles and tags, and keeps that metadata in a separate local SQLite database. It does not modify the original Claude or Codex session files.

## Features

- Search Claude Code and Codex sessions from one desktop app.
- Full-text search across custom titles, original titles, first user questions, conversation text, and project paths.
- Add custom titles and tags without changing the upstream session files.
- Filter by project, tag, source, open/closed state, pinned sessions, or hidden sessions.
- Resume a session in Terminal, iTerm, Ghostty, WezTerm, or Warp.
- Bring detected open terminals to front, copy resume commands, or export Markdown.
- Track message and token usage for Today / 7D / 30D / All time.
- Show Codex subscription quota; Claude Code quota can be shown through a statusline snapshot bridge.
- Refresh the local index and usage stats from the tray menu or in-app controls.
- Switch between light/dark themes and English/Chinese UI.
- Toggle the app with `Option+Space` on macOS by default; the shortcut can be changed or disabled in Settings.

## Supported Sources

| Source | Local files |
| --- | --- |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` |
| Codex Desktop | `~/.codex/sessions/**/*.jsonl`, detected by session metadata |
| Claude Code CLI | `~/.claude/projects/*/*.jsonl` plus optional `~/.claude/sessions/*.json` metadata |
| Claude Desktop app | `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json` plus Claude Code project logs |
| CodeBuddy CLI | Optional in settings; reads `~/.codebuddy/projects/**/*.jsonl` |

Codex title metadata is read from `~/.codex/session_index.jsonl` when that file exists. If no upstream title is available, the app uses the first meaningful user question as the default title.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Option+Space` | Show or hide the search window on macOS |
| `Cmd/Ctrl+K` | Focus and select the search box |
| `↑` / `↓` | Move through the main session list |
| `Space` | Open details for the selected session |
| `Enter` | Open details for the selected session when the search box is focused |
| `Cmd/Ctrl+Enter` | Resume the selected session in the default terminal |
| `Cmd/Ctrl+,` | Open Settings |

## Data Model

Agent-Session-Search keeps two kinds of data separate:

- Upstream session data stays in the original Claude and Codex files and is treated as read-only input.
- App metadata, including custom titles, tags, pinned state, hidden state, and the search index, is stored in a local SQLite database under Electron's `userData` directory.

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
