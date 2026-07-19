# Terminal Custom Title Synchronization Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep saved AgentRecall session titles available after the product rename and visible as stable terminal titles when Codex sessions are resumed from AgentRecall.

**Architecture:** Import user-owned session metadata from the legacy application database into the current database without replacing newer state. For Codex resume launches, disable Codex's own dynamic terminal-title renderer so the existing terminal adapter's saved `displayTitle` is not immediately overwritten.

**Tech Stack:** TypeScript 5.7, Node.js 22 `node:sqlite`, Electron 42, Vitest 2.1, macOS iTerm/Terminal launch scripts.

## Global Constraints

- Preserve current-database values when both databases contain user state; only fill missing titles and union boolean/tag state.
- Do not copy credentials, settings, transcripts, or remote-sync configuration from the legacy application directory.
- Do not write to real user databases in tests; use temporary directories and synthetic SQLite fixtures.
- Keep non-Codex resume commands unchanged.
- Keep copied resume commands unchanged; title-control arguments belong only to launched runtime commands.
- Add exactly one user-facing bug-fix release note and run `npm run release-note:check`.

---

### Task 1: Recover legacy user-owned session metadata

**Files:**
- Modify: `src/core/session-store.ts`
- Modify: `src/core/session-store.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: a path to the legacy `session-search.sqlite` database after the current `SessionStore` is open.
- Produces: `SessionStore.importLegacyUserState(legacyDbPath: string): number`, returning the number of current sessions whose user state was imported.

- [x] **Step 1: Write the failing store test**

Create two temporary SQLite databases. Put a session with `custom_title`, favorite/pinned flags, timestamps, and a tag in the legacy store; put the same indexed session without user state in the current store. Call `current.importLegacyUserState(legacyPath)` and assert that `getSession()` exposes the legacy title and unioned state while preserving any non-null current title.

- [x] **Step 2: Run the focused test to verify RED**

Run: `npx vitest run src/core/session-store.test.ts`

Expected: FAIL because `importLegacyUserState` does not exist.

- [x] **Step 3: Implement the minimal transactional import**

Open the legacy database read-only, select only rows with user-owned state, and apply them to matching current `session_key` rows. Reuse current store operations for title/flags/tags and preserve newer current values. Do not import message bodies, API keys, settings, or sync bindings.

- [x] **Step 4: Wire startup import after current store creation**

Keep the existing first-run directory copy. When the legacy database still exists at a different path, call `store.importLegacyUserState(legacyDbPath)` before registering IPC and indexing.

- [x] **Step 5: Run the focused test to verify GREEN**

Run: `npx vitest run src/core/session-store.test.ts`

Expected: PASS.

---

### Task 2: Stop Codex from overwriting saved terminal titles

**Files:**
- Modify: `src/core/platform.ts`
- Modify: `src/core/platform.test.ts`

**Interfaces:**
- Consumes: a Codex-family `SessionSearchResult` resumed through AgentRecall.
- Produces: a runtime command containing `-c 'tui.terminal_title=[]'` before the `resume` subcommand while keeping `getResumeCommand()` title-free for clipboard use.

- [x] **Step 1: Write the failing runtime-command test**

Assert that the launch command for a Codex session with a saved custom title disables Codex terminal-title rendering and still includes the same resume ID. Assert that Claude and other resume targets do not receive the Codex configuration override.

- [x] **Step 2: Run the focused test to verify RED**

Run: `npx vitest run src/core/platform.test.ts`

Expected: FAIL because Codex launch commands do not contain `tui.terminal_title=[]`.

- [x] **Step 3: Implement the minimal Codex-only launch override**

Add `-c`, `tui.terminal_title=[]` to the Codex-family runtime argv used by terminal launches when `customTitle` is non-empty. Leave copied commands and non-Codex targets unchanged.

- [x] **Step 4: Run the focused test to verify GREEN**

Run: `npx vitest run src/core/platform.test.ts`

Expected: PASS.

---

### Task 3: Release copy and verification

**Files:**
- Create: `.release-notes/fix-terminal-custom-title-sync.md`

**Interfaces:**
- Consumes: the two fixed user-visible behaviors.
- Produces: one final release note containing only a `## Bug 修复` section.

- [x] **Step 1: Add the release note**

Describe that saved custom session names survive upgrades and remain visible in supported terminal tabs after resuming through AgentRecall.

- [x] **Step 2: Run focused and full verification**

Run: `npx vitest run src/core/session-store.test.ts src/core/platform.test.ts src/core/session-title-sync.test.ts src/core/session-focus.test.ts`

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run build`

Run: `npm run release-note:check`

Expected: all commands exit 0 with no leftover Electron processes or package archives.
