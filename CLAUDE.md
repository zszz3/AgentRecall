# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Also read `AGENTS.md` — it holds the binding rules for release notes, merge/versioning, and safe test practices. This file covers commands and architecture.

Read the applicable directory's AGENTS.md before editing. Current contracts are indexed in [docs/spec/README.md](docs/spec/README.md); architectural decisions are indexed in [docs/adr/README.md](docs/adr/README.md). Documentation maintenance follows [docs/AGENTS.md](docs/AGENTS.md). Commands and validation policy are maintained in [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

```bash
npm run setup                # installs apps/main-2.0 deps, restores embedded-postgres symlinks, validates Electron
npm run dev                  # start desktop app from source
npm test                     # test:repo + apps/main-2.0 test
npm run typecheck            # tsc --noEmit + check:dead-code in apps/main-2.0
npm run release-note:check   # MUST pass before opening an MR
npm run package:smoke        # build + isolated tarball-install smoke
```

Per-app work is faster scoped:

```bash
npm --prefix apps/main-2.0 test        # vitest run && node --test scripts/*.test.mjs
cd apps/main-2.0 && npx vitest run src/core/postgres/schema.test.ts   # single file
cd apps/main-2.0 && npx vitest run -t "creates the complete internal domain schema"   # single test by name
cd apps/main-2.0 && npx vitest         # watch mode
```

Notes:

- **`npm install` alone is not enough.** `scripts/setup-app.mjs` runs `npm ci` with `AGENT_RECALL_SKIP_STATUSLINE_INSTALL=1` (so postinstall does not write into your real `~/.claude`), restores the embedded-PostgreSQL native symlinks that npm packing drops, and validates the Electron binary. On Windows, the first `npm run setup` needs an Administrator terminal for those symlinks.
- **There is no ESLint/Prettier/Biome/editorconfig.** `tsc --noEmit` + `scripts/check-source-entrypoints.mjs` + `scripts/*.test.mjs` are the static gates; match surrounding style by hand.
- CI (`.github/workflows/quality-check.yml`) runs on ubuntu/macos/windows: `setup` → `release-notes check-range` → full `npm test` (Linux only) or `test:scripts` (mac/Windows) → `package-smoke`.

## Repository layout

`apps/main-2.0` (`agent-recall` 2.0) is the single unified desktop Electron application (see [ADR 0027](docs/adr/0027-unified-v2-product.md)). The root npm workspaces contain `packages/workspace-core` and `apps/cli`; the Electron app keeps its own lockfile and `node_modules`.

Releases tag `vX.Y.Z` (starting at `v2.0.0`) and publish to GitHub's repository-wide `Latest` release (`releases/latest/download/agent-recall.tgz` and `update.json`). On-disk storage continues to use `<appData>/agent-recall-v2` and `~/.agent-recall-v2` so existing V2 users keep their PostgreSQL data and V1 SQLite data in `<appData>/AgentRecall` remains untouched for explicit import via `V1SessionImportService`.

## Desktop architecture (`apps/main-2.0`)

Electron 42 + React 19 + TypeScript 5.7, pure ESM, built by `electron-vite`. Node ≥ 22.13.

- **No path aliases.** Every import is relative (`../../core/...`). Don't introduce `@/`-style aliases.
- **`src/core/`** — Electron-free domain logic: session loaders, PostgreSQL store, indexing, migration, SSH/WSL sync, Supabase sync, skills, quota, provider config, platform helpers.
- **`src/main/`** — Electron wiring: `index.ts` (startup & lifecycle coordinator), `main/desktop/` (windows, tray, Dynamic Island overlay, quick search, native dialogs), `main/ipc/` (contract & domain IPC registrars), `main/services/` (injectable, unit-testable service classes).
- **`src/preload/index.ts`** — builds one flat `api` object from per-domain factories, then `contextBridge.exposeInMainWorld("sessionSearch", api)` and `export type SessionSearchApi = typeof api`.
- **`src/shared/ipc/`** — zod-validated channel contracts. `defineIpcRequest(channel, argsTuple)` + `registerIpcHandler(ipc, contract, handler)`.
- **Three renderer windows**: `index.html` (main), `quick-search.html` (global-shortcut palette), and `island.html` (Dynamic Island overlay), declared as rollup inputs in `electron.vite.config.ts`.
- **DB path discovery for out-of-process tools**: the app writes a pointer file (`~/.agent-recall-v2/database-url`). Standalone MCP servers in `bin/` re-implement the resolution logic so they run without a build step.
- **`bin/*.cjs` are dependency-free CommonJS with no build output** (launcher, self-updater, statusline, session-sync and memory hooks, MCP setup). All honor `AGENT_RECALL_TEST_HOME` so tests never touch real user config.
- **MCP bundle**: `npm run build:mcp` (esbuild → `out/mcp/`) bundles typed `src/core` code for standalone `bin/` entrypoints.
- **`src/automation/`** is a vendored upstream engine (~430 files; provenance in `upstream-manifest.json`). `src/automation/contracts.ts` is the declared stable seam.
- **Data layer**: `src/main/postgres/managed-postgres.ts` spawns `embedded-postgres` into `<userData>/postgres` (or defers to `AGENT_RECALL_DATABASE_URL`). `src/core/postgres/schema.ts` holds `POSTGRES_MIGRATIONS` — **numbered, append-only; never edit an existing migration**. Tests use `createInMemoryStore()` backed by `PGliteTestPool`.

## Test conventions

- Vitest tests are **always colocated** as `<module>.test.ts(x)` next to the source. `environment: "node"` globally; DOM tests opt in with `// @vitest-environment happy-dom`.
- `scripts/*.test.mjs` run via plain `node:test` + `node:assert/strict` (`npm run test:scripts`).
- Repo-level `scripts/*.test.mjs` enforce monorepo invariants (`npm run test:repo`).

## Before opening an MR

Every branch adds **exactly one** `.release-notes/<branch-slug>.md`: one `#` title and at least one bullet under `## 新增功能` or `## Bug 修复`. Run `npm run release-note:check`.
