<h1 align="center">Agent-Session-Search</h1>

<p align="center">本地桌面工具 · 一处搜索、整理、分析与恢复多种 AI Coding Agent 会话</p>

<p align="center">
  简体中文 ｜ <a href="./docs/README.en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-555555" alt="platform">
  <img src="https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React">
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.13-339933?logo=nodedotjs&logoColor=white" alt="Node">
</p>

<p align="center">
  <img src="./assets/show.png" alt="Agent-Session-Search 界面预览" width="860">
</p>

Agent-Session-Search 是一个本地桌面工具，用来搜索、整理、分析和恢复 AI Coding Agent 的历史会话。

它默认读取本机已有的 Claude / Codex session，也可以通过 SSH 读取远程机器上的 Claude / Codex session；CodeBuddy CLI、OpenClaw、Hermes、OpenCode、Cursor Agent、Trae 等本地来源可在 Settings 的 Optional sources 中开启。应用会建立本地搜索索引，并允许你给每个 session 添加自定义标题、标签、置顶和隐藏状态。这些额外信息都存放在独立的本地 SQLite 数据库里；索引和整理默认不会修改原始 session 数据。只有用户确认删除独立 session 文件时才会删除对应源文件；Hermes / OpenCode 这类共享 SQLite 数据库不会被整库删除。

## 功能

- 在一个桌面应用里统一搜索 Claude Code、Codex，以及设置中启用的 CodeBuddy CLI、OpenClaw、Hermes、OpenCode、Cursor Agent、Trae 会话。
- 支持全文搜索：自定义标题、原始标题、首个用户问题、会话正文和项目路径。
- 支持首屏分页加载，长列表只先展示一部分 session，继续点击再加载更多。
- 支持给 session 添加自定义标题、标签、收藏、置顶、隐藏状态，也支持删除 tag 和本地 session 源文件。
- 支持按项目、环境、标签、来源、打开/关闭状态、置顶状态、隐藏状态过滤。
- 支持按最近活动、创建时间、更新时间排序。
- 支持本地环境和 SSH 远程环境；远程环境可手动刷新，也可通过远端文件监听自动同步。
- 支持从 Terminal、iTerm、Ghostty、WezTerm 或 Warp 恢复会话。
- 支持把已经打开的终端前置、复制 resume 命令，或导出 Markdown。
- 支持详情页 Markdown / code block 渲染、tool call 轨迹折叠、按 user / assistant / tool 过滤消息。
- 支持按 Today / 7D / 30D / All time 统计消息数和 token 使用量。
- 支持显示 Codex 订阅额度；Claude Code 额度可通过 statusline 快照桥接显示，设置中可隐藏。
- 支持从菜单栏或界面按钮刷新本地索引和用量统计。
- 支持 Skills 管理：查看 Codex / Claude Code 已安装的 skills、搜索、预览、按来源过滤、复制路径、打开所在目录、删除用户 skill。
- 支持 Skill 使用统计：Claude Code 通过 PostToolUse hook 记录，Codex 从本地 session 中推断读取过的 `SKILL.md`；统计索引写入本地 SQLite，点击刷新按钮增量更新。
- 支持 Codex / Claude Code API Provider 切换，内置 CodexZH、DeepSeek、GLM、LongCat、Kimi、MiMo 等常用预设，也支持自定义 base URL、model 和 API key。
- 支持 AI 会话摘要：用自定义 API Provider（兼容 OpenAI Chat / Anthropic，含 GLM 等 coding plan）为会话生成可搜索的「问题 + 方案」摘要并入全文索引；支持单条、批量与自动补全。
- 支持 MCP server：以只读方式把历史会话开放给 Claude Code / Codex / CodeBuddy，让它们在对话里直接检索你的历史会话，设置里一键启用。
- 支持长时运行的会话结束时弹出桌面通知（可设置最短时长，默认关闭）。
- 支持明暗主题和中英文界面切换。
- macOS 下默认使用 `Option+Space` 唤起窗口，可在 Settings 里修改或关闭。

## 支持的数据源

| 来源 | 本地文件 |
| --- | --- |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` |
| Codex Desktop | `~/.codex/sessions/**/*.jsonl`，通过 session metadata 识别 |
| Claude Code CLI | `~/.claude/projects/*/*.jsonl`，以及可选的 `~/.claude/sessions/*.json` 元数据 |
| Claude Desktop app | `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json`，以及 Claude Code 项目日志 |
| CodeBuddy CLI | 可在设置中开启，读取 `~/.codebuddy/projects/**/*.jsonl` |
| OpenClaw | 可在设置中开启，读取 `~/.openclaw/agents/*/sessions/*.jsonl`，兼容 `~/.clawdbot/agents/*/sessions/*.jsonl`，排除 `*.trajectory.jsonl` |
| Hermes | 可在设置中开启，读取 `~/.hermes/state.db` |
| OpenCode | 可在设置中开启，读取 `~/.local/share/opencode/opencode.db` |
| Cursor Agent | 可在设置中开启，读取 `~/.cursor/projects/**/agent-transcripts/**/*.jsonl` |
| Trae | 可在设置中开启，读取 `~/.trae-cn/memory/projects/**/session_memory_*.jsonl`；打开状态会读取 Trae workspace 的本地状态库 |
| SSH 远程环境 | 通过 SSH 读取远端用户目录下同样的 Codex / Claude Code session 路径 |

当 `~/.codex/session_index.jsonl` 存在时，应用会读取 Codex 的标题元数据。没有上游标题时，会使用第一个有效用户问题作为默认标题。

CodeBuddy CLI、OpenClaw、Hermes、OpenCode、Cursor Agent 和 Trae 默认关闭，可在 Settings -> Optional sources 里选择监测。开启后支持本地只读索引、搜索、详情查看和来源过滤；Resume、远程 SSH 同步和专属用量统计会后续按来源单独补齐。Trae 额外支持打开状态检测。

## 让 Agent 检索历史会话（MCP）

可以把历史会话以**只读** MCP 服务的形式开放给 Claude Code / Codex / CodeBuddy，让它们在对话里直接“回忆”你以前是怎么解决某个问题的。

启用只需两步（默认关闭）：

1. 打开 **Settings → AI → 启用会话检索 MCP**（或命令行 `node bin/setup-mcp.cjs`，移除用 `node bin/setup-mcp.cjs uninstall`）。这会把服务写入 `~/.claude.json`、`~/.codex/config.toml`、`~/.codebuddy/mcp.json`，并自动选用一个 Node ≥ 22 的可执行文件（MCP 服务依赖 `node:sqlite`）。
2. **重启** Claude Code / Codex / CodeBuddy，让它们加载新的 MCP 服务。

之后**无需手动调用工具**——agent 会在需要时自动检索，你也可以直接说“搜一下我以前关于 X 的会话”。可用工具：`search_sessions`（结合 AI 摘要的全文检索）、`get_session`（按 `offset` 翻页读取长会话）、`list_projects`、`list_tags`。

> 服务只读数据库，桌面 App 不开也能用；但内容只在 App 运行索引后才更新。数据库位置由 App 启动时写入的指针文件提供，也可用环境变量 `AGENT_SESSION_SEARCH_DB` 覆盖。

## SSH 远程会话

SSH 远程环境不需要在远端安装 Agent-Session-Search，也不会在远端写入数据库。应用会在本机通过系统 `ssh` 连接远端，在远端执行一个临时 Python collector，读取远端 `~/.codex` 和 `~/.claude` 下的 session 摘要，再把摘要写入本机 SQLite。

远程同步方式：

- 添加或启用 SSH 环境后，会先完整同步一次最近 session 摘要。
- 如果远端有 `inotifywait`，会通过 SSH 长连接监听 `~/.codex/sessions`、`~/.codex/session_index.jsonl`、`~/.claude/projects`、`~/.claude/sessions`。
- 如果没有 `inotifywait` 但有 `fswatch`，会使用 `fswatch` 监听 `~/.codex` 和 `~/.claude`。
- 如果两者都没有，会退化为每 60 秒轮询同步。
- 远程详情按需加载：列表默认只保存摘要，点开某个远程 session 时才通过 SSH 拉取对应原始文件内容。

远程机器需要：

- 能从本机通过 `ssh` 非交互连接。
- 安装 `python3`。
- 想要实时监听时安装 `inotifywait` 或 `fswatch`；没有也能使用轮询。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Option+Space` | macOS 下唤起或隐藏搜索窗口 |
| `Cmd/Ctrl+K` | 聚焦并选中搜索框 |
| `↑` / `↓` | 在主界面会话列表中移动选中项 |
| `Space` | 打开当前选中会话详情 |
| `Enter` | 搜索框聚焦时打开当前选中会话详情 |
| `Cmd/Ctrl+Enter` | 在默认终端中恢复当前选中会话 |
| `Cmd/Ctrl+,` | 打开 Settings |

## 数据边界

Agent-Session-Search 会把两类数据分开处理：

- Claude / Codex / OpenClaw / Cursor Agent / Trae 等独立 session 文件在索引、搜索、标注时只作为只读输入；显式确认删除 session 时会删除对应源文件。Hermes / OpenCode 使用共享 SQLite 数据库，应用不会为了删除单个 session 而删除整库。
- SSH 远程 session 文件也只作为只读输入，通过 SSH 拉取摘要和按需详情。
- 自定义标题、标签、收藏、置顶、隐藏状态、搜索索引、远程环境配置、Skill 使用索引和 API Provider key 存放在 Electron `userData` 目录下的本地 SQLite 数据库中。
- 应用 Codex / Claude Code Provider 时，会按对应 CLI 的配置格式修改本机 `~/.codex/config.toml` 或 `~/.claude/settings.json`，并先写入备份。

## 安装使用

### macOS

要求 Node.js 22.13+（含 npm）。进入仓库目录后，执行下面命令即可安装依赖、构建并注册全局命令：

```bash
nvm install 22 && nvm use 22 && npm ci && npm run build && npm install -g .
```

如果你不用 nvm，只要本机 `node --version` 是 22.13 或更高版本，可以直接从 `npm ci` 开始执行。

装好后，在任意终端运行 `agent-session-search` 即可启动。应用常驻后台（菜单栏有图标），默认按 **⌥ Option + Space** 唤起搜索窗口；如果和 Raycast 等工具冲突，可以在 Settings 里修改或关闭全局快捷键。

Settings 也可以通过 `Cmd+,` 打开；在 Appearance 里可以切换明暗主题和 English / 中文界面。

后续日常启动不需要重新执行安装命令，也不需要重新 build，直接运行：

```bash
agent-session-search
```

如果新终端提示 `agent-session-search: command not found`，通常是因为全局命令安装在 nvm 的 Node 22 目录下，但当前 shell 没有选中 Node 22。可以先运行：

```bash
nvm use 22
agent-session-search
```

也可以一次性设置默认 Node 版本，之后新终端就不需要手动 `nvm use 22`：

```bash
nvm alias default 22
```

### Windows

确认 Node.js 22.13+ 后，在仓库目录里用 PowerShell 执行：

```powershell
npm ci && npm run build && npm install -g .
```

装好后，在任意终端运行 `agent-session-search` 即可启动。应用常驻后台（任务栏/托盘有图标），默认按 **Ctrl + Alt + Space** 唤起搜索窗口。

更新、卸载、从源码克隆、网络镜像等详情见 [Install.md](./Install.md)。

## 开发环境

要求：

- macOS 或 Windows
- Node.js 22.13 或更高版本
- npm

安装依赖：

```bash
npm install
```

运行测试：

```bash
npm test
```

启动开发版桌面应用：

```bash
npm run dev
```

构建应用：

```bash
npm run build
```

## 仓库文档

- `README.md`：中文项目说明，面向普通读者和开发者。
- `docs/README.en.md`：英文项目说明。
- `Install.md`：安装、更新、卸载说明，也包含给 Coding Agent 安全初始化项目环境的执行文档。

有任何问题，请提交issue。如果觉得我们的项目还不错，欢迎star✨。
