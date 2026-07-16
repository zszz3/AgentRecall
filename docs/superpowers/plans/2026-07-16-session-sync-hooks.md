# Session Sync Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add removable Claude Code and Codex Stop hooks that queue local sessions for revision-aware Supabase upload while simplifying the session-sync settings hierarchy.

**Architecture:** Self-contained CommonJS scripts merge user hook configuration and append one JSON event file per completed turn. The Electron main process drains those files, refreshes the existing index, finds the matching non-subagent session, and reuses `uploadSessionToRemote` for revision and conflict safety.

**Tech Stack:** Electron, React, TypeScript, Node.js CommonJS hook scripts, Vitest, node:test.

## Global Constraints

- Session and Skill Supabase settings remain independent.
- Only session synchronization receives automatic hooks.
- Hooks never receive Supabase credentials or perform network requests.
- Tests use a temporary HOME and remove all fixtures.

---

### Task 1: Hook installer and recorder

**Files:**
- Create: `bin/setup-session-sync-hook.cjs`
- Create: `bin/session-sync-record.cjs`
- Create: `src/core/setup-session-sync-hook.test.ts`
- Create: `src/core/session-sync-record.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `installSessionSyncHooks(options)`, `uninstallSessionSyncHooks(options)`, `sessionSyncHookStatus(options)`, and `buildSessionSyncEvent(input, agent)`.

- [x] Write tests asserting idempotent Claude/Codex installation, preservation of foreign hooks, complete removal, and valid event creation.
- [x] Run `npx vitest run src/core/setup-session-sync-hook.test.ts src/core/session-sync-record.test.ts` and confirm the missing modules fail.
- [x] Implement the two dependency-free CommonJS scripts and package bin entries.
- [x] Re-run the focused tests and confirm they pass.

### Task 2: Background queue consumer

**Files:**
- Create: `src/core/session-sync-queue.ts`
- Create: `src/core/session-sync-queue.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: event files from `~/.agent-recall/session-sync-queue` and existing `uploadSessionToRemote(sessionKey)`.
- Produces: `readSessionSyncQueue()`, `removeSessionSyncQueueEvent()`, and the main-process periodic drain.

- [x] Write tests for malformed events, duplicate session coalescing, removal, and retained failures.
- [x] Run `npx vitest run src/core/session-sync-queue.test.ts` and confirm it fails because the queue module is missing.
- [x] Implement queue parsing and add a bounded main-process drain that refreshes the index once, excludes subagents, skips unchanged revisions, and retains retryable failures.
- [x] Re-run queue and remote-session tests.

### Task 3: Settings hierarchy and Hook controls

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`
- Create: `src/renderer/src/session-sync-settings.test.ts`

**Interfaces:**
- Produces renderer APIs for Hook status/install/remove and a top-level remote-sync toggle.

- [x] Write a source-level UI test asserting the enable toggle precedes and gates the connection fields and that Hook install/remove controls exist.
- [x] Run the focused test and confirm it fails on the current layout.
- [x] Move the enable card to the top, conditionally render the remaining settings, and make disabling remove hooks before saving `remoteSyncEnabled: false`.
- [x] Re-run the focused UI test and typecheck.

### Task 4: Uninstall, documentation, and verification

**Files:**
- Modify: `bin/uninstall.cjs`
- Modify: `README.md`
- Modify: `.release-notes/stabilize-sync-experience.md`
- Modify: script tests as needed

**Interfaces:**
- `agent-recall uninstall` removes both session hooks and queued events without removing Supabase settings or cloud data.

- [x] Add a failing uninstall test using a temporary HOME.
- [x] Extend uninstall and user documentation with automatic session sync and Codex trust instructions.
- [x] Run focused tests, `npm run typecheck`, `npm test`, `npm run build`, and `npm run release-note:check`.
- [x] Confirm no test processes or temporary files remain.
