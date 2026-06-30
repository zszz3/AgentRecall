<h1 align="center">Agent-Session-Search</h1>

<p align="center">本地桌面工具 · 搜索、快速启动、分析多种 AI Coding Agent 会话</p>

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

## 功能

### 核心功能

- **统一搜索和管理多种 AI Coding Agent 会话**：
  搜索、过滤、查看、整理和快速启动 Claude Code、Codex，以及可选的 CodeBuddy、OpenClaw、Hermes、OpenCode、Cursor Agent、Trae 等会话；支持自定义标题、标签、收藏、置顶、隐藏和一键快速启动；也支持本地环境和 SSH 远程环境，远程机器无需安装本应用。
- **完整查看会话上下文**：
  详情页展示完整消息、tool call 与 Markdown / code block，并支持查看 AI 摘要和导出 Markdown。
- **AI / Agent 辅助检索历史会话**：
  可以使用 AI 摘要增强历史会话检索，也支持自然语言找会话；同时开放只读 MCP 能力，让 Claude Code / Codex / CodeBuddy 可以在对话里直接搜索和读取历史会话。
- **跨 Agent 迁移会话**：
  支持把 Claude / Codex / CodeBuddy 会话迁移到另一个 Agent，并在迁移后继续工作。
- **统一查看 Agent 用量和额度**：
  统计今日、近 7 天、近 30 天和全部时间的各 Agent token 使用量；同时查看 Claude Code / Codex 的当前额度状态。
- **统一管理 Skills 和 API Provider**：
  查看和管理 Claude Code / Codex skills，统计 skill 使用情况；支持使用自己的 Supabase 项目同步 Skills，在不同机器之间上传、更新和安装；也可以在界面里切换 Codex / Claude Code 的官方账号或第三方 API Provider。

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

## Skills 管理与同步

打开 Skills 管理窗口后，可以查看本机已安装的 Codex / Claude Code Skills，按来源筛选，查看使用次数，预览 `SKILL.md` 内容，并对非系统 Skill 执行删除、复制路径、在 Finder / 文件管理器中打开等操作。

如果希望在多台机器之间同步自己的 Skills，可以在 Settings -> Skills -> Supabase skill sync 中启用 Supabase 同步：

1. 在 [Supabase Dashboard](https://supabase.com/dashboard) 创建或选择一个自己的项目。
2. 在 Project Settings -> API 中复制 Project URL 和 anon key。
3. 回到应用的 Settings -> Skills，填入 Supabase URL 和 anon key，并启用同步。
4. 如果远程表还不存在，打开 Skills 管理窗口的 Remote 视图，点击 Copy setup SQL，把 SQL 粘贴到 Supabase SQL Editor 执行一次。
5. 回到 Local 视图，选择本地 Skill 后点击 Upload；同一个 Agent 下同名 Skill 会用稳定指纹识别，后续再次上传会更新远程记录。
6. 在另一台机器配置相同的 Supabase URL 和 anon key 后，打开 Remote 视图，选择远程 Skill 并点击 Install locally / Update local。

同步会上传整个 Skill 目录中的普通文件，包括 `SKILL.md`、`references/`、`scripts/`、示例文件等；下载时会还原到本机的用户级 Skill 目录中。Codex Skill 默认安装到 `$CODEX_HOME/skills`（未设置时为 `~/.codex/skills`），Claude Code Skill 默认安装到 `~/.claude/skills`。

当前 Supabase 同步按个人项目设计，不会自动创建表，也不会使用 service role key。应用只保存 Project URL 和 anon key 到本地设置，并通过 Supabase REST API 访问 `agent_session_search_skills` 表。初始化 SQL 会为 anon role 创建可读写策略，适合个人私有项目或仅自己掌握 URL/key 的项目；如果要多人共享或公开分发，请先按自己的 Supabase 安全模型调整 RLS policy。

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
