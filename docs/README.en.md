<h1 align="center">AgentRecall</h1>

<p align="center">A local desktop tool to search, quick launch, and analyze AI coding-agent sessions</p>

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

## Features

### Core Features

- **Unified search and management for AI coding-agent sessions**:
  Search, filter, inspect, organize, and quick launch Claude Code, Codex, and optional sessions from tclaude, tcodex, CodeBuddy, OpenClaw, Hermes, OpenCode, Cursor Agent, Trae, and Qoder; add custom titles, tags, favorites, pinned state, and hidden state; local and SSH remote environments are supported without installing this app on the remote machine. Sidebar projects are grouped by environment, each group can be collapsed, and projects within a group are ordered by recent activity. Sessions can be filtered across all time or the last 7, 30, or 90 days; search results are sorted by smart ranking (relevance mixed with time decay) by default, with options to sort by newest or oldest activity.
- **Full session context view**:
  The detail view shows complete messages, tool calls, Markdown / code blocks, and supports AI summaries plus Markdown export.
- **AI / Agent-assisted session retrieval**:
  Use AI summaries to improve history search, ask for sessions in natural language, and expose MCP capabilities so Claude Code / Codex / CodeBuddy can search, read, tag, favorite, and set the visibility of session history directly in chat.
- **Cross-agent session migration**:
  Migrate local sessions between Claude Code, Codex, CodeBuddy, and enabled optional CLIs; remote restore remains available for Claude Code, Codex, and CodeBuddy.
- **Remote session storage and cross-device restore**:
  Upload session snapshots manually to your own Supabase project, search and inspect them on another device, and restore them into Claude Code / Codex / CodeBuddy.
- **Unified agent usage and quota view**:
  Track token usage by agent for today, 7 days, 30 days, and all time; also view current Claude Code / Codex quota status.
- **Unified Skills and API Provider management**:
  View and manage Claude Code / Codex / Qoder skills, track skill usage, sync personal skills across machines through your own Supabase project, and switch Codex / Claude Code between official accounts and third-party API providers.
- **Digital assets cross-device sync**:
  A unified Digital Assets panel manages Rules (CLAUDE.md / .qoder/rules) and Memories (Qoder long-term memories / Codex memories) sync across devices — view sync status, upload all or per-item, reusing the same Supabase configuration as Skills sync.

## Supported Sources

| Source | Local files |
| --- | --- |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` |
| Codex Desktop | `~/.codex/sessions/**/*.jsonl`, detected by session metadata |
| Claude Code CLI | `~/.claude/projects/*/*.jsonl` plus optional `~/.claude/sessions/*.json` metadata |
| Claude Desktop app | `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json` plus Claude Code project logs |
| TClaude CLI | Optional in settings; reads `~/.tclaude/projects/*/*.jsonl` (a Claude Code fork sharing the same format); supports Resume |
| TCodex CLI | Optional in settings; reads `~/.tcodex/sessions/**/*.jsonl` (a Codex fork sharing the same format); supports Resume |
| Claude Code Internal | Optional in settings; reads `~/.claude-internal/projects/*/*.jsonl` |
| Codex Internal | Optional in settings; reads `~/.codex-internal/sessions/**/*.jsonl` |
| CodeBuddy CLI | Optional in settings; reads `~/.codebuddy/projects/**/*.jsonl` |
| OpenClaw | Optional in settings; reads `~/.openclaw/agents/*/sessions/*.jsonl`, legacy `~/.clawdbot/agents/*/sessions/*.jsonl`, excluding `*.trajectory.jsonl` |
| Hermes | Optional in settings; reads `~/.hermes/state.db` |
| OpenCode | Optional in settings; reads `~/.local/share/opencode/opencode.db` |
| Cursor Agent | Optional in settings; reads `~/.cursor/projects/**/agent-transcripts/**/*.jsonl` |
| Trae | Optional in settings; reads `~/.trae-cn/memory/projects/**/session_memory_*.jsonl`; open-state detection reads Trae's local workspace state database |
| Qoder | Optional in settings; reads `~/.qoder/cache/projects/*/conversation-history/*/*.jsonl`; supports live detection and remote sync |
| SSH remote environment | Reads the same Codex / Claude Code session paths under the remote user's home directory over SSH |

Codex title metadata is read from `~/.codex/session_index.jsonl` when that file exists. If no upstream title is available, the app uses the first meaningful user question as the default title.

CodeBuddy CLI, TClaude, TCodex, Claude Code Internal, Codex Internal, OpenClaw, Hermes, OpenCode, Cursor Agent, Trae, and Qoder are off by default and can be selected from Settings -> Optional sources. Once enabled, they support local read-only indexing, search, details, and source filtering. Because TClaude / TCodex share the Claude Code / Codex formats, they additionally support Resume and one-click launch (invoking the `tclaude` / `tcodex` commands respectively). For the other sources, Resume, SSH remote sync, and provider-specific usage stats are intentionally separate follow-up work. Trae and Qoder also support open-state detection.

## Remote Session Sync

Remote session sync saves a selected local session into your own Supabase project. After configuring the same Supabase URL and anon key on another device, you can open the remote session list, search, filter by source, inspect details, and restore the remote session into any supported local agent. For example, device A can upload a Codex session, and device B can view that session from Remote Sessions and restore it into Claude Code, Codex, or CodeBuddy.

This version is designed for **single-user, manual snapshot sync**:

- There is no user isolation or app login. It assumes you control the Supabase project and anon key.
- There is no automatic background sync. If you continue a local session after uploading it, the remote copy stays at the last uploaded snapshot until you upload it again.
- Re-uploading the same local session updates the latest remote snapshot. If the content has not changed, the upload is skipped. Remote sessions do not keep version history.
- Remote details include the session metadata, messages, tool calls / trace events, tags, AI summary, and the other information currently supported by the detail view.
- Restore uses the stored portable session and asks you to choose a local project directory on the current device as the target project path.

### Configure Supabase

1. Create or select a project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Copy the Project URL and anon key from Project Settings -> API.
3. In the app, open Settings -> Remote sync and paste the Supabase URL and anon key.
4. Under First-time setup, click Copy latest SQL and then Open SQL Editor. The app opens the SQL Editor for the configured project.
5. Paste and run the SQL, return to the app, and enable remote sync. If Session sync or Skills later reports that the schema or permissions need an update, run the latest SQL offered there and click Refresh.

The first-time script initializes both session and Skill sync. For session sync it creates:

- Table: `public.agent_session_remote_sessions`
- Storage bucket: `agent-session-remote`
- Storage object paths:
  - `sessions/{id}/detail.json`: used by the remote detail view
  - `sessions/{id}/portable.json`: used for cross-device and cross-agent restore

The script is idempotent and can be run more than once. It creates anon-role read/write policies suitable for a personal project. Those policies are convenient for single-user sync, but they are not a multi-user isolation model. If you plan to share the project with other users or expose it more broadly, adjust the RLS policies for your own Supabase security model first.

### Upload A Session

1. Open a local session from the search results.
2. Click the Upload button with the cloud-upload icon at the top of the detail view.
3. After upload succeeds, the session appears in the Remote Sessions list.

If the same session has already been uploaded:

- Unchanged content: the app reports that the remote session is already up to date.
- Changed content: the app updates the remote table row and the `detail.json` / `portable.json` objects in Storage.

### Search, Inspect, And Restore Remote Sessions

Click the cloud icon in the top toolbar to open Remote Sessions:

- Search remote sessions by title, project path, summary, tags, and full text.
- Use Source to filter uploaded sessions by Claude, Codex, or CodeBuddy.
- Click View to open a read-only remote detail view.
- Choose the target agent under Restore to, then click Restore on a session row.
- On first restore, choose a local project directory on the current device. The app writes the session into the target agent's local session directory and attempts to launch that agent so you can continue working.

## Skills Management and Sync

The Skills window lists installed Codex / Claude Code skills, lets you filter by source, inspect usage counts, preview `SKILL.md`, copy paths, reveal skill folders, and delete non-system skills.

To sync your personal skills between machines, enable Settings -> Skills -> Supabase skill sync:

1. Create or select a project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Copy the Project URL and anon key from Project Settings -> API.
3. Paste them into Settings -> Skills. First-time setup offers the same combined script used by session sync and opens the configured project's SQL Editor directly.
4. Run the SQL and enable sync. If the table, Storage bucket, columns, or permissions later need an update, the Local view offers the latest Skill SQL, an Open SQL Editor action, and an in-place Refresh action.
5. In the Local view, select a local skill and click Upload. A stable fingerprint identifies skills by agent and name. Each upload that actually changes the content adds a new version (v1, v2, …); uploads with unchanged content are skipped, and if the latest remote version came from a different same-named skill you are asked to confirm before appending a version.
6. On another machine, configure the same Supabase URL and anon key, open the Remote view, pick a version from the dropdown to preview any point in history (the newest is tagged latest), then click Install locally / Update local to install that version.

Sync uploads the full skill directory's regular files, including `SKILL.md`, `references/`, `scripts/`, examples, and other supporting files. Downloads restore them into the local user skill root. Codex skills install into `$CODEX_HOME/skills` or `~/.codex/skills`; Claude Code skills install into `~/.claude/skills`.

If you created the `agent_recall_skills` table with an earlier version, re-run the Copy setup SQL script once after upgrading to enable version history. The script is idempotent: it adds the `content_hash` column and changes the unique constraint from `local_fingerprint` to `(local_fingerprint, version)`.

Supabase sync is designed for personal projects. It does not create tables automatically and does not require a service role key. The app stores only the Project URL and anon key locally, then uses the Supabase REST API to access the `agent_recall_skills` table. The copied setup SQL grants anon read/write access through RLS for personal sync convenience; adjust the RLS policy first if you plan to share the project with other users or expose it more broadly.

## Digital Assets Panel

Click the database icon in the toolbar to open the Digital Assets panel, which manages Rules and Memories sync across devices:

- **Rules sync**: Scans local Claude `CLAUDE.md` (global) and Qoder `.qoder/rules/*.md` (project-level), uploads/downloads via Supabase.
- **Memories sync**: Scans local Qoder long-term memories (`~/.qoder/memories/`) and Codex memories (`~/.codex/memories_1.sqlite`), uploads/downloads via Supabase.

Each tab shows local assets (with sync status: synced / modified / not synced) and remote assets, supporting upload all, per-item upload, and remote deletion. Reuses the Supabase URL and anon key from Skills sync settings. Enable the "Rules sync" and "Memories sync" toggles in Settings to get started.

## Installation

### Regular users

Install Node.js 22.13 or newer, then install the latest GitHub Release from a terminal. The same command works in macOS terminals and Windows PowerShell:

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz
agent-recall
```

The first installation downloads the Electron runtime for the current operating system. See the Development Setup section and [Install.md](../Install.md) for source-based installation.

Once installed, run `agent-recall` from any terminal to launch it. The app stays in the background with a menu bar icon on macOS or a system tray icon on Windows. Press **⌥ Option + Space** on macOS or **Ctrl + Alt + Space** on Windows to open the search window. If the shortcut conflicts with another launcher, change or disable the global shortcut in Settings. The app uses a single-instance lock, so launching it again focuses the existing window instead of opening another instance.

On macOS, Settings can also be opened with `Cmd+,`. Use Appearance to switch the color theme and English / Chinese UI.

For daily use, you do not need to reinstall dependencies or rebuild. Just run:

```bash
agent-recall
```

If a new terminal says `agent-recall: command not found`, the global command was probably installed under nvm's Node 22 directory while the current shell is using another Node version. Run:

```bash
nvm use 22
agent-recall
```

Or set Node 22 as your nvm default once:

```bash
nvm alias default 22
```

If you do not use nvm and have Node.js 22.13+ installed system-wide, daily startup does not need any nvm command.

The terminal checks the latest GitHub Release automatically. When an update is available, it shows the release's new features and bug fixes and asks whether to install it. The same version, release notes, and **Update now** action are available under **Settings → About**. Use `agent-recall --check-update` to check without launching the App or `agent-recall --update` to install immediately. If an automatic update fails, the external updater attempts to reopen the installed version and uses an operating-system dialog to offer actions for copying the manual installation command or opening the latest Release page.

See [Install.md](../Install.md) for updating, uninstalling, installing from a fresh clone, and network mirror tips.

## Development Setup

Requirements:

- macOS or Windows
- Git
- Node.js 22.13 or newer
- npm

Clone the repository, install exactly the locked dependencies, and start the development app:

```bash
git clone https://github.com/zszz3/AgentRecall.git
cd AgentRecall
npm ci
npm run dev
```

The development app uses files from the current checkout and is independent of a globally installed Release. Useful verification commands are:

```bash
npm test
npm run typecheck
npm run build
npm run release-note:check
```

## Repository Notes

- `README.md` is the Chinese project overview for users and developers.
- `docs/README.en.md` is the English project overview.
- `Install.md` covers install, update, and uninstall steps, plus a safe setup guide for Coding Agents.
- `start.sh` is the macOS one-command launcher that checks the environment, installs missing dependencies, and starts the app.

## License

This project is licensed under the [MIT License](../LICENSE). You may use, modify, and distribute it, provided that the original copyright and license notices are retained.

## Star History

<a href="https://www.star-history.com/?repos=zszz3%2FAgentRecall&type=date&legend=top-left">
  <img src="../assets/star-history.svg" alt="AgentRecall Star History Chart" width="900" />
</a>
