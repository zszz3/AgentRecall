# AgentRecall Install

## 安装并使用（给使用者）

先确认 Node.js 22.13+ 和 npm 可用，然后直接安装 GitHub 最新 Release：

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz
agent-recall
```

该方式不会克隆仓库，也不需要在本机执行构建。npm 会把编译后的应用安装到当前 Node.js 的全局目录，并下载当前操作系统对应的 Electron 运行时。

装好后，在任意终端运行即可启动：

```bash
agent-recall
```

应用启动后常驻后台（菜单栏有图标），默认按 **⌥ Option + Space** 唤起搜索窗口；如果和 Raycast 等工具冲突，可以在 Settings 里修改或关闭全局快捷键。Settings 也可以用 `Cmd+,` 打开，Appearance 里可以切换明暗主题和 English / 中文界面。

如果要使用 SSH 远程会话，请确保本机可以用系统 `ssh` 非交互连接远端机器，远端安装了 `python3`。实时监听需要远端有 `inotifywait` 或 `fswatch`；没有时应用会退化为轮询同步。

### 后续启动还要 `nvm use 22` 吗？

不需要重新执行 `npm ci`、`npm run build` 或 `npm install -g .`。日常启动只需要：

```bash
agent-recall
```

如果新终端里提示 `agent-recall: command not found`，通常是因为全局命令安装在 nvm 的 Node 22 目录下，但当前 shell 没有选中 Node 22。可以二选一：

```bash
nvm use 22
agent-recall
```

或者一次性把 Node 22 设成 nvm 默认版本，之后新终端就不需要手动 `nvm use 22`：

```bash
nvm alias default 22
```

如果你不用 nvm，而是系统里直接安装了 Node.js 22.13+，后续启动也不需要任何 nvm 命令。

正式版安装在 npm 全局目录中，不依赖本地仓库。切换 nvm Node 版本后如果命令消失，请切回安装时的 Node 版本，或在新的 Node 版本下重新执行安装命令。

### Windows

先安装 Node.js 22.13+（从 <https://nodejs.org> 下载 LTS 安装包，或使用 nvm-windows）。确认 `node --version` ≥ 22.13 后，在 PowerShell 执行：

```powershell
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz
agent-recall
```

装好后在任意终端运行 `agent-recall` 即可启动。应用常驻后台（系统托盘有图标），默认按 **Ctrl + Alt + Space** 唤起搜索窗口（Windows 下 `Alt+Space` 被系统窗口菜单占用，故默认用 `Ctrl+Alt+Space`）；可在 Settings 里修改或关闭。

Resume 会在所选终端里打开恢复命令；设置中可选 **Windows Terminal / PowerShell / Command Prompt**，默认优先 Windows Terminal，未安装时自动回退到 PowerShell 或 cmd。

下载 Electron 慢时，可在安装前设置镜像（PowerShell）：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
```

正式版同样安装到 npm 全局目录，不依赖仓库路径。

### 要求

- macOS 或 Windows
- Node.js 22.13 或更高版本（含 npm）
- SSH 远程会话可选依赖：本机 `ssh`，远端 `python3`，远端 `inotifywait` 或 `fswatch` 用于实时监听

温馨提示：Electron binary 默认从 GitHub release 下载。如果下载很慢或失败，可在安装前设置镜像后再执行安装命令：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

### 更新到新版本

日常从终端启动时会自动检查 GitHub Release：

```bash
agent-recall
```

发现新版本后，终端会展示新增功能和 Bug 修复，并询问是否立即更新。也可以主动检查或直接更新：

```bash
agent-recall --check-update
agent-recall --update
```

App 内可在 **Settings → About（设置 → 关于）** 检查并安装更新。更新包会先校验 SHA-256；安装失败时，外部更新进程会尝试重新打开已经安装的版本，并通过不依赖 Electron 的系统提示框提供“复制安装命令”和“打开 Release 页面”两个兜底入口。终端更新失败时也会直接打印手动安装命令。

手动覆盖安装始终使用同一个稳定链接：

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz
```

注意：更新器随应用版本一起发布。已经安装的旧版本无法提前获得新版本中的兜底逻辑；如果某个旧版本自身的自动更新失败，请直接执行上面的命令覆盖安装。

安装指定旧版本或回滚时使用对应 Release tag 的固定链接，例如：

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/download/v0.2.0/agent-recall.tgz
```

安装会覆盖当前全局版本，不会删除会话数据库、Supabase 配置或用户偏好。回滚后可用 `agent-recall --version` 核对版本。

如果正在使用源码开发目录且希望手动同步 `main`，仍可执行：

```bash
git pull --ff-only
nvm install 22
nvm use 22
npm ci
npm run build
npm run package:smoke
```

源码开发版请使用 `npm run dev` 启动；`package:smoke` 会在临时 HOME 和临时 npm prefix 中验证安装包，不会覆盖正在使用的正式版。

### 卸载

```bash
agent-recall uninstall
npm uninstall -g agent-recall
```

第一条命令只清理本应用写入的 Claude statusLine、Skill usage hook、Claude / Codex / CodeBuddy MCP 引用和集成缓存；它会保留本地会话数据库、Supabase 配置、自动更新偏好及其他用户偏好。第二条命令再删除全局安装的程序包。

### 备选：从源码克隆安装

如果还没有本地仓库，先克隆：

```bash
git clone https://github.com/zszz3/AgentRecall.git
```

---

## 给编码 Agent 的引导

This section is for coding agents. If the AgentRecall repository is not already cloned and open, clone `https://github.com/zszz3/AgentRecall.git` first, then continue from the repository root.

## Goal

Bootstrap a local development workspace for AgentRecall with the least risky path available.

Default preference:

1. Install dependencies from the lockfile with npm.
2. Verify the app with tests and type checks.
3. Start the Electron development app only when the user asks to run it.

## Success Criteria

- The repository root is confirmed by checking `package.json`, `src/`, and `electron.vite.config.ts`.
- `node_modules/` exists after `npm ci`.
- `npm test` passes.
- `npm run typecheck` passes.
- `npm run build` passes when the user wants a build verification.
- The user receives the exact command to launch the development app.
- No Claude or Codex source session files are modified.
- No runtime SQLite database is committed to git.

## Operating Rules

- Be idempotent. Re-running this document should not damage an existing setup.
- Prefer package scripts over ad hoc shell commands.
- Do not use `sudo` or install system packages without explicit user approval.
- Do not run `npm audit fix`, dependency upgrades, formatters, or broad refactors unless the user asks.
- Do not delete `node_modules/`, build output, Electron user data, or existing SQLite databases unless the user asks.
- Do not read or print secret-bearing files such as `.env`, shell profiles, or private Claude/Codex configuration files.
- Treat Claude and Codex session files as read-only input.
- If a command fails, stop, report the smallest blocker, and provide the next command that would unblock setup.
- If a development server or Electron process is started for verification, do not leave it running after the task is complete unless the user asked for a persistent app session.

## Prerequisites

Expected tools:

- Node.js 22.13 or newer
- npm
- Git
- macOS for the current desktop workflow

Important dependency note:

- The app depends on Electron 42+ because the runtime must expose built-in `node:sqlite`.
- Do not add `better-sqlite3` or other native SQLite packages as an install workaround.
- A first-time install may download an Electron binary around 100MB+. This is expected and does not require Xcode.

Check versions:

```bash
node --version
npm --version
git --version
```

If nvm is available, use the repository version before installing dependencies:

```bash
nvm use
```

The project uses Electron's built-in `node:sqlite`, so it does not need native SQLite npm rebuilds.

## Install Steps

1. Confirm the repository root:

   ```bash
   test -f package.json && test -d src && test -f electron.vite.config.ts
   ```

2. Install dependencies from the lockfile:

   ```bash
   npm ci
   ```

3. Run the test suite:

   ```bash
   npm test
   ```

4. Run TypeScript checks:

   ```bash
   npm run typecheck
   ```

5. Build the app when build verification is requested:

   ```bash
   npm run build
   ```

6. Smoke-test the generated package in an isolated temporary HOME and npm prefix:

   ```bash
   npm run package:smoke
   ```

7. Start the app only when the user asks to run it:

   ```bash
   npm run dev
   ```

## Troubleshooting

### `No such built-in module: node:sqlite`

This means the app is running under an Electron version that is too old for the current SQLite implementation.

Fix:

```bash
npm ci
npm run typecheck
npm run build
```

Confirm Electron exposes SQLite:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -p "process.versions.node + ' sqlite=' + Boolean(process.getBuiltinModule?.('node:sqlite'))"
```

Expected output should include:

```text
sqlite=true
```

Do not fix this by installing `better-sqlite3`; that reintroduces native build tooling requirements.

## Runtime Data Boundary

The app creates a local SQLite database at Electron's `userData` path:

```text
<Electron userData>/session-search.sqlite
```

This database contains the search index and app-only metadata such as custom titles, tags, pinned state, and hidden state. It is runtime state, not source code.

SSH remote sessions are read-only inputs. The app stores remote summaries and on-demand details in the local SQLite index, but it does not install a remote daemon or create a remote database.

Never commit:

```text
*.sqlite
*.sqlite-shm
*.sqlite-wal
*.db
```

The app should read upstream sessions from these locations when they exist:

```text
~/.codex/sessions/**/*.jsonl
~/.codex/session_index.jsonl
~/.claude/projects/*/*.jsonl
~/.claude/sessions/*.json
~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json
```

Do not edit, rewrite, or delete those source files during installation.

## TODO

- [ ] Confirm the repository root.
- [ ] Install dependencies with `npm ci`.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build` if build verification is requested.
- [ ] Confirm `node:sqlite` is available in Electron if startup fails.
- [ ] Report the exact development launch command: `npm run dev`.
- [ ] Confirm no SQLite database files are staged for commit.

## EXECUTE NOW

Complete the setup steps above. When finished, stop at the setup boundary and report status instead of continuing into feature work, dependency upgrades, or unrelated repository changes.
