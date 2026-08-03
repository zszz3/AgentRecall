# OpenViking Observability Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a V2 Memory subpage that can start, stop, restart, and continuously inspect OpenViking runtime and import-task state.

**Architecture:** A new read-only diagnostics IPC aggregates runtime health/events from `OpenVikingRuntimeService` and sanitized task rows from `OpenVikingMemoryService`. A focused React monitor component polls that IPC only while visible; lifecycle mutations continue through the owning control service.

**Tech Stack:** TypeScript, Electron IPC, React, PostgreSQL repository APIs, Vitest, CSS.

---

### Task 1: Define the diagnostics contract

**Files:**
- Modify: `apps/main-2.0/src/core/openviking-memory.ts`
- Modify: `apps/main-2.0/src/shared/ipc/openviking-memory.ts`
- Modify: `apps/main-2.0/src/main/ipc/openviking-memory.ts`
- Modify: `apps/main-2.0/src/preload/openviking-memory.ts`
- Test: `apps/main-2.0/src/main/openviking-memory-ipc.test.ts`

- [ ] Add `OpenVikingRuntimeDiagnostics`, `OpenVikingRuntimeEvent`, `OpenVikingImportTaskDiagnostics`, and `OpenVikingDiagnosticsSnapshot` types. Runtime diagnostics contain the existing status plus health, PID, start time, uptime, latency and events. Task diagnostics contain identifiers and counters but no `payload`.
- [ ] Add validated no-input `diagnostics` and `restartRuntime` IPC contracts.
- [ ] Add `diagnostics()` and `restartRuntime()` to `OpenVikingMemoryIpcService`, register both handlers, and expose `getOpenVikingDiagnostics()` and `restartOpenVikingRuntime()` from preload.
- [ ] Extend the existing IPC test so invoking every contract proves both new operations use the same validated channel list.
- [ ] Run `npm test -- --run src/main/openviking-memory-ipc.test.ts` from `apps/main-2.0`; expect all tests to pass.

### Task 2: Capture runtime health and lifecycle events

**Files:**
- Modify: `apps/main-2.0/src/main/services/openviking-runtime-service.ts`
- Test: `apps/main-2.0/src/main/services/openviking-runtime-service.test.ts`

- [ ] Extend persisted runtime state with optional `startedAt` and write it when spawning:

```ts
interface PersistedRuntimeState {
  pid: number;
  port: number;
  startedAt?: string;
}
```

- [ ] Keep a capped 50-entry event array and record controlled messages for start, ready, stop, exit and startup failure. Do not copy stderr or model configuration into event text.
- [ ] Implement `getDiagnostics()` without auto-starting: call `getStatus()`, read the owned state, probe the already-running server with the existing health probe, measure latency, and return `not-running` for other states.
- [ ] Add tests proving old state files remain valid, a running process reports PID/uptime/healthy, and stop/exit events are retained.
- [ ] Run `npm test -- --run src/main/services/openviking-runtime-service.test.ts`; expect all tests to pass.

### Task 3: Aggregate sanitized import-task diagnostics and lifecycle controls

**Files:**
- Modify: `apps/main-2.0/src/main/services/openviking-memory-service.ts`
- Modify: `apps/main-2.0/src/main/services/openviking-control-service.ts`
- Test: `apps/main-2.0/src/main/services/openviking-memory-service.test.ts`
- Test: `apps/main-2.0/src/main/services/openviking-control-service.test.ts`

- [ ] Add `listImportTaskDiagnostics(queryRemote: boolean)`. Read tasks through `listOpenVikingImportTasks`, map only metadata and `payload.primary.length`, and cap output at 200 newest rows.
- [ ] For active tasks with credentials and an already-running runtime, call `getTask`; copy only status, stage and a string error. A remote lookup failure populates `remoteError` on that row and does not reject the snapshot.
- [ ] Add `diagnostics()` to the control service. Fetch runtime diagnostics, model status and workspaces, then fetch task diagnostics with remote lookup enabled only when runtime status is `running`.
- [ ] Add serialized `restartRuntime()` using the existing `runtimeStart` guard: wait for any current start, stop once, start once, and notify state change.
- [ ] Extend existing tests to prove task payload text is absent, remote failures are row-local, diagnostics does not request remote state while stopped, and restart calls stop before start.
- [ ] Run the two targeted service test files; expect all tests to pass.

### Task 4: Build the Memory runtime monitor

**Files:**
- Create: `apps/main-2.0/src/renderer/src/features/openviking-memory/openviking-runtime-monitor.tsx`
- Modify: `apps/main-2.0/src/renderer/src/features/openviking-memory/openviking-memory-page.tsx`
- Modify: `apps/main-2.0/src/renderer/src/styles/openviking-memory.css`

- [ ] Add “记忆 / 运行监控” tabs to the existing page and keep monitor selection independent of workspace selection.
- [ ] Implement the monitor component with a 1.5-second non-overlapping poll that retains the last good snapshot on error.
- [ ] Render runtime and model summary cards, PID/port/version/start/uptime/health-latency fields, and Start/Stop/Restart/Refresh controls. Confirm stop/restart only when a workspace is actively importing.
- [ ] Render per-workspace progress and a sanitized task table with local state, remote state, attempt count, turns, update time and errors.
- [ ] Render the 50-entry lifecycle event stream. Use existing theme variables and responsive rules; do not add decorative charts or fake percentages.
- [ ] Run `npm run typecheck`; expect zero TypeScript errors.

### Task 5: Release note and real verification

**Files:**
- Create: `.release-notes/openviking-observability.md`

- [ ] Add one user-facing `新增功能` bullet describing the new runtime monitor and controls.
- [ ] Run the targeted OpenViking tests, `npm run typecheck`, and `npm run release-note:check`.
- [ ] With V2 running, open Memory → 运行监控 and verify stopped state, start, healthy running state, refresh, restart and stop. Confirm PID changes after restart and no workspace is created by polling.
- [ ] Inspect `git diff --check` and `git status`; preserve the existing untracked `specs/` directory.

