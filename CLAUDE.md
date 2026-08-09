# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Also read `AGENTS.md` — it holds the binding rules for release notes, dual-app changes, merge/versioning, and safe test practices. This file covers commands and architecture.

## Commands

```bash
npm run setup                # setup:v1 + setup:v2 (do this instead of npm install — see below)
npm run dev:v1               # or dev:v2
npm test                     # test:repo + test:v1 + test:v2
npm run typecheck            # tsc --noEmit in both apps
npm run release-note:check   # MUST pass before opening an MR
npm run package:smoke:all    # build + tarball-install smoke for both apps, in parallel
```

Per-app work is faster scoped:

```bash
npm --prefix apps/main-2.0 test        # vitest run && node --test scripts/*.test.mjs
cd apps/main-2.0 && npx vitest run src/core/postgres/schema.test.ts   # single file
cd apps/main-2.0 && npx vitest run -t "reconciles the OpenViking"     # single test by name
cd apps/main-1.0 && npx vitest         # watch mode
npm run test:workflow-transaction    # V2 workflow-v2 / workspace-transaction gate
npm run test:workflow-performance    # V2 incremental-IPC regression gate
```

Notes:

- **`npm install` alone is not enough.** `scripts/setup-app.mjs` runs `npm ci` with `AGENT_RECALL_SKIP_STATUSLINE_INSTALL=1` (so postinstall does not write into your real `~/.claude`), restores the embedded-PostgreSQL native symlinks that npm packing drops (V2 only), and validates the Electron binary. On Windows, the first `npm run setup:v2` needs an Administrator terminal for those symlinks.
- **There is no ESLint/Prettier/Biome/editorconfig.** `tsc --noEmit` is the only static gate; match surrounding style by hand.
- CI (`.github/workflows/quality-check.yml`) runs on ubuntu/macos/windows: `setup` → `release-notes check-range` → full `npm test` (Linux only) or `test:scripts` (mac/Windows) → `package:smoke:all`. The full suite is **not green on Windows** (POSIX paths, symlinks, fake-CLI spawning) — that is why mac/Windows only run the script tests.

## Two applications, one repo

`apps/main-1.0` (`agent-recall`, stable) and `apps/main-2.0` (`agent-recall-v2`, preview) are independently installed, versioned, and released. The root has **no npm workspaces**; each app has its own lockfile and `node_modules`.

They share concepts but not code. The critical difference: **V1 stores sessions in SQLite with a fully synchronous store API; V2 uses embedded PostgreSQL with a fully async store API.** Per `AGENTS.md`, any session-related change must be inspected in both apps and implemented in both when it applies — but never by copy-paste, because the data layer diverges.

Release channels also diverge: V1 tags `vX.Y.Z` and owns the repo "Latest" marker (V1's updater hardcodes `releases/latest/download/update.json`); V2 tags `v2-X.Y.Z` plus a force-moved `v2-latest` tag that mirrors only the tarball, giving V2 a stable install URL without stealing the Latest marker.

## Shared architecture (both apps)

Electron 42 + React 19 + TypeScript 5.7, pure ESM, built by `electron-vite`. Node ≥ 22.13.

- **No path aliases in either app.** Every import is relative (`../../core/...`). Don't introduce `@/`-style aliases.
- **`src/core/`** — Electron-free domain logic: session loaders, the store, indexing, migration, SSH/WSL sync, Supabase sync, skills, quota, provider config. This is where most real logic lives.
- **`src/main/`** — Electron wiring: `index.ts` (a very large god-file: windows, tray, global shortcut, IPC registration, startup sequencing), `main/ipc/` (contract registrars), `main/services/` (injectable, unit-testable service classes).
- **`src/preload/index.ts`** — builds one flat `api` object from per-domain factories, then `contextBridge.exposeInMainWorld("sessionSearch", api)` and `export type SessionSearchApi = typeof api`. That exported type is how the renderer gets end-to-end typing; there is no separate API type declaration to keep in sync.
- **`src/shared/ipc/`** — zod-validated channel contracts. `defineIpcRequest(channel, argsTuple)` + `registerIpcHandler(ipc, contract, handler)` (which returns a disposer). Newer domains use this; older channels are raw `ipcMain.handle("domain:verb", …)` in `main/index.ts` with hand-written preload wrappers. Prefer the contract path for new work.
- **Two renderer windows**: `index.html` (main) and `quick-search.html` (global-shortcut palette), both declared as rollup inputs in `electron.vite.config.ts`.
- **DB path discovery for out-of-process tools**: because Electron's `userData` differs between dev and packaged builds, the app writes a pointer file (`~/.agent-recall/db-path` for V1, `~/.agent-recall-v2/database-url` for V2). The standalone MCP servers in `bin/` deliberately re-implement the resolution logic rather than importing from `src/` — they must run without a build step.
- **`bin/*.cjs` are dependency-free CommonJS with no build output** (launcher, self-updater, statusline, session-sync and memory hooks, MCP setup). They must work straight out of a global npm install, are idempotent and reversible, merge non-destructively into `~/.claude/settings.json` / `~/.codex/config.toml`, and all honor `AGENT_RECALL_TEST_HOME` so tests never touch real user config.
- **MCP bundle**: `npm run build:mcp` (esbuild → `out/mcp/`) exists so `bin/agent-recall-mcp.mjs` can call into typed `src/core` code without `--experimental-strip-types`. It runs as part of `build` (and of `dev` in V2).
- **i18n and theming are hand-rolled**, no libraries. `language.ts` exports `localize(language, en, zh)` called inline at each string site (default `zh`); `theme.ts` sets `document.documentElement.dataset.theme` (default `light`), with an inline pre-paint script in the HTML to avoid FOUC. Styling is hand-written CSS driven by `[data-theme]` variables — no Tailwind, no CSS modules.

## V1 specifics (`apps/main-1.0`)

**Session sources** are the central abstraction, and adding one touches several files. A source is a descriptor row in `SESSION_SOURCE_REGISTRY` (`src/core/session-sources.ts`) — `format`, `family`, capability flags (`live`/`resume`/`migrate`/`sessionSync`/`openApp`), optional-setting key, migration/resume targets. `session-sources.test.ts` enforces the invariants between those fields, so the registry is self-checking.

Parsing splits in two: `src/core/format-adapters.ts` provides a per-line `FormatAdapter` (most sources use `genericAdapter`), while all directory walking and session-level metadata is per-source imperative code in `src/core/session-loader.ts` (~3500 lines). Both `loadDefaultSessionsIterator` and `loadDefaultSessionsAsyncIterator` must be updated together. Claude + Codex are always loaded; every other source is gated on an `includeX` flag in `AppSettings` (defaults `false`), and disabling one triggers a `prune-sources` worker job.

**Data layer**: Node 22's built-in `node:sqlite` `DatabaseSync` — no native deps. WAL mode so the MCP server can read while the app writes. `src/core/store/schema.ts` runs one idempotent `migrateSessionStore(db)`: `CREATE TABLE IF NOT EXISTS` blocks, then `addColumnIfMissing` calls, then named one-shot data migrations recorded in a `data_migrations` table — **there are no numbered migration files**. Full-text search is an FTS5 virtual table refreshed per session. `SessionStore` is a synchronous facade over sub-stores in `src/core/store/`; `createInMemoryStore()` is the test constructor.

**Indexing** runs in a `worker_threads` worker (`src/main/session-index-worker.ts`, a second rollup input), serialized through a queue, with migrations owned by the main process only. `src/core/indexer.ts` skips unchanged files by exact size+mtime before parsing, and tail-scans Codex files from a stored byte offset.

**Renderer**: `App.tsx` is a single ~2900-line component with ~97 `useState` and no context or router. "Navigation" is dialog + filter state. Extractable pure logic lives in small sibling modules (`session-ui.ts`, `live-filter.ts`, `date-range.ts`, …) which are the unit-test seams.

**Naming trap**: `core/remote-session-sync.ts` is *Supabase cloud* sync; `core/remote-sync.ts` is *SSH/WSL machine* sync.

## V2 specifics (`apps/main-2.0`)

**`src/automation/` is a vendored upstream engine** (~430 files; provenance in `upstream-manifest.json`) containing the agent hub, Workflow v2, Eval, Chat, its own renderer pages, and an MCP server. `src/automation/contracts.ts` is the declared stable seam — main/preload/renderer should import protocol types from there so engine-internal paths stay free to follow upstream layout.

- `engine/main/hub/agent-hub.ts` is the central state machine and entry point for nearly everything.
- Workflow v2 executes a DAG in `engine/main/workflows/v2/workflow-v2-executor.ts`, driven almost entirely by injected callbacks (`runLlmNode`, `executeScript`, `reviewNodeOutput`, checkpoint hooks…). Node roles are orchestrator/executor/reviewer; script nodes carry an explicit risk/capability/idempotency authorization model. Durability is an append-only event store plus a workspace transaction layer (WAL, commit coordinator, savepoints, recovery).
- Renderer updates use an **incremental patch protocol** (`AUTOMATION_CHANGE_PROTOCOL_VERSION`, sequence numbers, `{upsert, remove}` diffs) instead of pushing the whole `AppSnapshot`; the renderer resyncs with a full `getSnapshot()` when it detects a sequence gap. `test:workflow-performance` guards this against regression.

**Runtimes** (`codex`, `claude`, `api`, `hermes`, `opencode`, `openclaw`) are defined in `engine/shared/runtime-catalog.ts` and dispatched `AgentHub → RuntimeDriverRegistry → RuntimeRouter → driver`. The router owns policy: surface support, execution-mode/continuation-policy validation, conversation ownership, and codec-based state persistence. Model discovery exists in three distinct places — `engine/main/channels/model-catalog.ts` (live channel discovery), `engine/shared/models.ts` (static fallbacks), `src/core/provider-models.ts` (the standalone Providers page).

**Data layer**: `src/main/postgres/managed-postgres.ts` spawns `embedded-postgres` into `<userData>/postgres` with generated SCRAM credentials (or defers entirely to `AGENT_RECALL_DATABASE_URL`). `src/core/postgres/database.ts` applies migrations under a `pg_advisory_lock`, each in its own transaction, tracked in `agent_recall.schema_migrations`. `src/core/postgres/schema.ts` holds `POSTGRES_MIGRATIONS` — **numbered, append-only; never edit an existing migration**. `SessionStore` is an async facade over per-domain repositories.

Tests do **not** start a real server: `src/core/postgres/test-session-store.ts` exposes `createInMemoryStore()`, backed by `PGliteTestPool` (`@electric-sql/pglite`) running the same migration list.

**OpenViking** is the directory-scoped long-term memory subsystem: a packaged CPython runtime built by `scripts/build-openviking-runtime.mjs` and downloaded per release, ~14 `openviking-*` services in `src/main/services/`, and dependency-free hooks in `bin/` that reconcile into `~/.claude`, `~/.codex`, and OpenCode non-destructively. `npm run release:preflight:openviking` checks the pinned runtime inputs still resolve.

**Renderer**: `App.tsx` switches on an `AppPage` union from `components/app-navigation.tsx` (no router). Automation state lives in a `useSyncExternalStore` store (`features/automation/automation-store.ts`) behind `AutomationProvider`; everything else is local React state.

## Test conventions

- Vitest tests are **always colocated** as `<module>.test.ts(x)` next to the source — never a `__tests__/` directory. `environment: "node"` globally; DOM tests opt in with a first-line `// @vitest-environment happy-dom` pragma and drive React via `createRoot` + `act` (no Testing Library, no setup file).
- `scripts/*.test.mjs` are a separate runner: plain `node:test` + `node:assert/strict`, run by `test:scripts`, covering build/release/packaging/hook tooling. They exercise scripts via exported functions or by `execFile`-ing them inside a `mkdtemp` sandbox.
- Repo-level `scripts/*.test.mjs` enforce structural invariants that are easy to break unknowingly: the monorepo has no workspaces, per-app PostCSS configs stay isolated, setup passes the statusline-skip env var and *not* `--ignore-scripts`, install docs use the `v2-latest` URL, and the release workflow keeps specific shell forms and pinned versions. If you edit `package.json` scripts, `.github/workflows/*`, or install docs, run `npm run test:repo`.
- `AGENTS.md`'s safety rule is enforced by convention: anything touching install/update/uninstall/hooks/MCP/skills/session discovery must use a temporary `HOME` (`AGENT_RECALL_TEST_HOME`), a temporary npm prefix, and synthetic fixtures. Never read or mutate the developer's real Claude/Codex/Supabase/session data.

## Before opening an MR

Every branch adds **exactly one** `.release-notes/<branch-slug>.md`: one `#` title, an optional `<!-- release-target: v1|v2|both -->` marker (defaults to `v1`), and at least one bullet under `## 新增功能` or `## Bug 修复`. These bullets ship verbatim as end-user product copy — no MRs, branches, CI, file paths, table names, or internal service names, and no vague filler (the checker rejects "优化代码" and friends). Any feature bullet bumps the minor version; fixes-only bumps the patch. Run `npm run release-note:check`.
