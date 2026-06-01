# Agent-Session-Search Install

## 安装并使用（给使用者）

推荐使用源码目录安装。只要本机有 **Node.js 22.13+** 和 nvm，在仓库目录执行下面这一行即可重新安装依赖、构建并注册全局命令：

```bash
cd ~/myProject/agent-session-search && nvm use 22 && rm -rf node_modules && npm ci && npm run build && npm install -g .
```

装好后，在任意终端运行即可启动：

```bash
agent-session-search
```

应用启动后常驻后台（菜单栏有图标），随时按 **⌥ Option + Space** 唤起搜索窗口。

### 要求

- macOS
- Node.js 22.13 或更高版本（含 npm）

> 说明：这种方式通过命令行启动，不打包成 `.app`，因此**不需要 Apple 签名或公证**，也不会被 Gatekeeper 拦截。
>
> SQLite 说明：项目使用 Electron 42 自带的 `node:sqlite`。安装时会下载 Electron binary（约 100MB+），但**不需要 Xcode、node-gyp、better-sqlite3 或 electron-rebuild**。
>
> 不推荐使用 `npm install -g git+https://...` 直接从 Git 仓库安装。npm 的 git dependency preparation 会在临时目录里触发构建，Electron/Vite 项目在这条路径上容易遇到 `electron-vite: command not found` 等安装阶段问题。

### 更新到新版本

先拉取最新代码，再重新跑安装命令：

```bash
cd ~/myProject/agent-session-search && git pull --ff-only && nvm use 22 && rm -rf node_modules && npm ci && npm run build && npm install -g .
```

### 卸载

```bash
npm uninstall -g agent-session-search
```

### 备选：从源码克隆安装

如果还没有本地仓库，先克隆：

```bash
mkdir -p ~/myProject && git clone https://github.com/zszz3/agent-session-search.git ~/myProject/agent-session-search
```

---

## 给编码 Agent 的引导

This section is for coding agents. If the Agent-Session-Search repository is not already cloned and open, clone `https://github.com/zszz3/agent-session-search.git` first, then continue from the repository root.

## Goal

Bootstrap a local development workspace for Agent-Session-Search with the least risky path available.

Default preference:

1. Install dependencies with npm.
2. Verify the app with tests and type checks.
3. Start the Electron development app only when the user asks to run it.

## Success Criteria

- The repository root is confirmed by checking `package.json`, `src/`, and `electron.vite.config.ts`.
- `node_modules/` exists after `npm install`.
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

6. Register the global launch command when installing for daily use:

   ```bash
   npm install -g .
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
npm install
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
- [ ] Install dependencies with `npm install`.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build` if build verification is requested.
- [ ] Confirm `node:sqlite` is available in Electron if startup fails.
- [ ] Report the exact development launch command: `npm run dev`.
- [ ] Confirm no SQLite database files are staged for commit.

## EXECUTE NOW

Complete the setup steps above. When finished, stop at the setup boundary and report status instead of continuing into feature work, dependency upgrades, or unrelated repository changes.
