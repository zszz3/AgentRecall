# Agent-Session-Search

[English](./docs/README.en.md)

Agent-Session-Search 是一个本地桌面工具，用来搜索、整理和恢复 Claude Code 与 Codex 的历史会话。

它会读取本机已有的 Claude / Codex session 文件，建立本地搜索索引，并允许你给每个 session 添加自定义标题、标签、置顶和隐藏状态。这些额外信息都存放在独立的本地 SQLite 数据库里，不会修改原始 session 文件。

## 功能

- 在一个桌面应用里统一搜索 Claude Code 和 Codex 会话。
- 支持全文搜索：自定义标题、原始标题、首个用户问题、会话正文和项目路径。
- 支持给 session 添加自定义标题和标签。
- 支持按项目、标签、来源、打开/关闭状态、置顶状态、隐藏状态过滤。
- 支持从 Terminal、iTerm、Ghostty、WezTerm 或 Warp 恢复会话。
- 支持把已经打开的终端前置、复制 resume 命令，或导出 Markdown。
- 支持按 Today / 7D / 30D / All time 统计消息数和 token 使用量。
- 支持显示 Codex 订阅额度；Claude Code 额度可通过 statusline 快照桥接显示。
- 支持从菜单栏或界面按钮刷新本地索引和用量统计。
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

当 `~/.codex/session_index.jsonl` 存在时，应用会读取 Codex 的标题元数据。没有上游标题时，会使用第一个有效用户问题作为默认标题。

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

- Claude / Codex 的原始 session 文件只作为只读输入。
- 自定义标题、标签、置顶、隐藏状态和搜索索引存放在 Electron `userData` 目录下的本地 SQLite 数据库中。

SQLite 数据库属于运行时状态，不应该提交到 git。

## 安装使用

要求 macOS 和 Node.js 22.13+（含 npm）。进入仓库目录后，执行下面命令即可安装依赖、构建并注册全局命令：

```bash
nvm install 22
nvm use 22
npm ci
npm run build
npm install -g .
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

如果你不用 nvm，而是系统里直接安装了 Node.js 22.13+，后续启动不需要任何 nvm 命令。

更新、卸载、从源码克隆、网络镜像等详情见 [Install.md](./Install.md)。

### Claude Code 额度桥接

Codex 额度会通过 `~/.codex/auth.json` 只读拉取。Claude Code 没有对应的本地额度文件或只读 usage API；额度只会出现在 Claude Code statusline 输入的 `rate_limits` 字段里。

**安装时会自动配置。** `npm install`（含 `npm install -g .`）的 `postinstall` 会运行 `bin/install-claude-statusline.cjs`，把下面这段自动写入 `~/.claude/settings.json`：

```json
{
  "statusLine": {
    "type": "command",
    "command": "agent-session-search-claude-statusline"
  }
}
```

之后运行一次 Claude Code 并等它收到首个 API 响应，桥接脚本会写入 `~/.claude/statusline-snapshot.json`，应用刷新 Usage 后即可读取。脚本只保存 `rate_limits`、可选套餐名和更新时间，不保存完整 statusline 输入。

自动配置是**非破坏性**的：

- 如果你**已经有**自定义的 `statusLine`，安装脚本不会覆盖它，只会提示你如何手动启用（把 `statusLine.command` 指向 `agent-session-search-claude-statusline`，或 `node "<安装目录>/bin/claude-statusline-snapshot.cjs"`）。
- 设 `AGENT_SESSION_SEARCH_SKIP_STATUSLINE_INSTALL=1` 或在 `CI` 环境下会跳过自动配置。
- 安装脚本永远以退出码 0 结束，不会让 `npm install` 失败。

## 开发环境

要求：

- macOS
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

## SQLite 说明

项目使用 Node/Electron 内置的 `node:sqlite`，不需要安装或 rebuild 原生 SQLite npm 模块。

如果使用 nvm，可以在仓库根目录执行：

```bash
nvm use
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Electron 开发版应用 |
| `npm test` | 运行测试 |
| `npm run typecheck` | 执行 TypeScript 类型检查 |
| `npm run build` | 类型检查并构建 Electron 应用 |

## 仓库文档

- `README.md`：中文项目说明，面向普通读者和开发者。
- `docs/README.en.md`：英文项目说明。
- `Install.md`：安装、更新、卸载说明，也包含给 Coding Agent 安全初始化项目环境的执行文档。
