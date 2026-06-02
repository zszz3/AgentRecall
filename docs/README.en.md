# Agent-Session-Search

[中文文档](../README.md)

Agent-Session-Search is a local desktop console for finding, organizing, and resuming Claude Code and Codex sessions.

It indexes existing local session files, lets you add your own titles and tags, and keeps that metadata in a separate local SQLite database. It does not modify the original Claude or Codex session files.

## Features

- Search Claude Code and Codex sessions from one desktop app.
- Full-text search across custom titles, original titles, first user questions, conversation text, and project paths.
- Add custom titles and tags without changing the upstream session files.
- Filter by project, tag, source, pinned sessions, or hidden sessions.
- Resume a session in Terminal, iTerm, Ghostty, WezTerm, or Warp.
- Copy resume commands or conversation exports.
- Show Codex subscription quota; Claude Code quota can be shown through a statusline snapshot bridge.
- Refresh the local index from the tray menu.
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

## Data Model

Agent-Session-Search keeps two kinds of data separate:

- Upstream session data stays in the original Claude and Codex files and is treated as read-only input.
- App metadata, including custom titles, tags, pinned state, hidden state, and the search index, is stored in a local SQLite database under Electron's `userData` directory.

The SQLite database is runtime state and is intentionally ignored by git.

## Installation

Requires macOS and Node.js 22.13+ (with npm). From the repository root, run this single line to install dependencies, build, and register the global command:

```bash
nvm use 22 && rm -rf node_modules && npm ci && npm run build && npm install -g .
```

Once installed, run `agent-session-search` from any terminal to launch it. The app stays in the background (with a menu bar icon); press **⌥ Option + Space** by default to open the search window. If it conflicts with Raycast or another launcher, change or disable the global shortcut in Settings.

See [Install.md](../Install.md) for updating, uninstalling, installing from a fresh clone, and network mirror tips.

### Claude Code Quota Bridge

Codex quota is loaded read-only through `~/.codex/auth.json`. Claude Code does not expose an equivalent local quota file or read-only usage API; quota appears in the `rate_limits` field passed to statusline commands.

To show Claude Code 5h / 7d quota in the app, add this to `~/.claude/settings.json` after globally installing this project:

```json
{
  "statusLine": {
    "type": "command",
    "command": "agent-session-search-claude-statusline"
  }
}
```

Then run Claude Code once and wait for the first API response. The bridge writes `~/.claude/statusline-snapshot.json`, which the app reads on Usage refresh. The script stores only `rate_limits`, optional plan, and update time, not the full statusline input.

## Development Setup

Requirements:

- macOS
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

## SQLite Notes

This project uses Node/Electron's built-in `node:sqlite`, so it does not need a native SQLite npm module or runtime-specific rebuild scripts.

If you use nvm, run this from the repository root:

```bash
nvm use
```

## Useful Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Electron development app |
| `npm test` | Run tests |
| `npm run typecheck` | Run TypeScript checks |
| `npm run build` | Typecheck and build the Electron app |

## Repository Notes

- `README.md` is the Chinese project overview for users and developers.
- `docs/README.en.md` is the English project overview.
- `Install.md` is for Coding Agents that need to set up the repository safely on a user's machine.
