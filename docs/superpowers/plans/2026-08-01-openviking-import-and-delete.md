# OpenViking Import and Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each scanned Agent Session produce one OpenViking commit and make deleting the final managed directory remove all OpenViking runtime data without deleting installed components.

**Architecture:** `OpenVikingMemoryService` owns the per-workspace import lifecycle and creates one persisted import task per changed Session snapshot. `OpenVikingControlService` coordinates deletion by pausing and settling imports before remote deletion, then asks `OpenVikingRuntimeService` to remove only its `data` directory after the last workspace is gone.

**Tech Stack:** TypeScript, Electron main process, PostgreSQL repositories, Vitest, Node.js filesystem APIs.

---

### Task 1: Commit each scanned Session once

**Files:**
- Modify: `apps/main-2.0/src/main/services/openviking-memory-service.ts`
- Test: `apps/main-2.0/src/main/services/openviking-memory-service.test.ts`

- [ ] **Step 1: Write the failing oversized-Session test**

Add a test that creates one Session with more than 50 completed Turns and more than 10K estimated tokens, calls `importWorkspace`, and asserts:

```ts
const plannedTasks = vi.mocked(h.store.syncOpenVikingImportTasks).mock.calls[0][1];
expect(plannedTasks).toHaveLength(1);
expect(plannedTasks[0].payload.primary).toHaveLength(60);
expect(h.client.commitSession).toHaveBeenCalledOnce();
expect(h.client.appendMessages).toHaveBeenCalledTimes(60);
```

Update the existing multi-Session concurrency test to expect one task and one commit per Session while retaining maximum concurrency `2` and per-Session concurrency `1`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run apps/main-2.0/src/main/services/openviking-memory-service.test.ts
```

Expected: the new test fails because `buildImportChunks` creates multiple tasks for one Session.

- [ ] **Step 3: Replace chunk planning with one snapshot task per Session**

Remove `IMPORT_CHUNK_TOKEN_LIMIT`, `IMPORT_CHUNK_TURN_LIMIT`, and intermediate `ImportChunk` batching. For each changed Session, derive one pending snapshot:

```ts
const primary = (candidatesBySession.get(session.sessionKey) ?? [])
  .filter((candidate) => !importedCandidates.has(
    importedTurnCheckpointKey(candidate.sourceTurnId, candidate.fingerprint),
  ));
if (primary.length === 0) continue;
taskInputs.push({
  id: deterministicImportTaskId(workspaceId, session.sessionKey, sourceRevision, primary),
  position: taskInputs.length,
  workspaceId,
  sessionKey: session.sessionKey,
  sourceRevision,
  sessionTitle: session.displayTitle,
  payload: { context: [], primary: primary.map(importTaskTurn), keepRecentCount: 0 },
});
```

Keep the current scan snapshot, fingerprint checkpoints, deterministic IDs, 12,000-character per-message limit, and cross-Session concurrency.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same Vitest command. Expected: all memory-service tests pass.

### Task 2: Stop in-flight imports before workspace deletion

**Files:**
- Modify: `apps/main-2.0/src/main/services/openviking-memory-service.ts`
- Modify: `apps/main-2.0/src/main/services/openviking-control-service.ts`
- Test: `apps/main-2.0/src/main/services/openviking-memory-service.test.ts`
- Test: `apps/main-2.0/src/main/services/openviking-control-service.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add a memory-service test where `getTask` remains pending, call `pauseImport`, then assert a new public method waits until `activeImports`/`followUpImports` have settled:

```ts
await h.service.pauseImport("workspace-1");
await expect(h.service.waitForImportToSettle("workspace-1")).resolves.toBeUndefined();
```

Add a control-service deletion test that verifies ordering:

```ts
expect(memory.pauseImport).toHaveBeenCalledWith("workspace-1");
expect(runtime.stop.mock.invocationCallOrder[0])
  .toBeLessThan(vi.mocked(memory.waitForImportToSettle).mock.invocationCallOrder[0]);
expect(vi.mocked(memory.waitForImportToSettle).mock.invocationCallOrder[0])
  .toBeLessThan(runtime.startFromPersistedConfig.mock.invocationCallOrder[0]);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run both service test files. Expected: failures because `waitForImportToSettle` and deletion coordination do not exist.

- [ ] **Step 3: Implement import settling and deletion ordering**

Add `waitForImportToSettle(workspaceId)` directly to `OpenVikingMemoryService`; it awaits the current active and follow-up promises, swallowing the import failure because the persisted job contains the outcome.

In `OpenVikingControlService.deleteWorkspace`:

1. Pause the target import when its workspace still exists.
2. Stop Runtime so a currently blocked HTTP request exits.
3. Await `waitForImportToSettle`.
4. Restart using persisted configuration.
5. Delete remote data, local records, and credentials.
6. Preserve existing remaining-workspace runtime behavior.

Treat an already-removed workspace as idempotent cleanup.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run both service test files. Expected: all pass with deletion order asserted.

### Task 3: Clear runtime data after deleting the last workspace

**Files:**
- Modify: `apps/main-2.0/src/main/services/openviking-runtime-service.ts`
- Modify: `apps/main-2.0/src/main/services/openviking-control-service.ts`
- Test: `apps/main-2.0/src/main/services/openviking-runtime-service.test.ts`
- Test: `apps/main-2.0/src/main/services/openviking-control-service.test.ts`

- [ ] **Step 1: Write failing cleanup tests**

Create a temporary Runtime root containing:

```text
data/_system/queue/queue.db
data/vectordb/context/store/file
runtime/0.4.11/bin/python3
models/bge/model.gguf
downloads/openviking.tar.gz
```

Call `clearData()` and assert `data` no longer exists while `runtime`, `models`, and `downloads` remain.

Extend the last-workspace control test to assert `runtime.stop()` happens before `runtime.clearData()`. Extend the remaining-workspace test to assert `clearData()` is not called.

- [ ] **Step 2: Run focused tests and verify RED**

Run runtime and control service tests. Expected: failures because `clearData` is absent.

- [ ] **Step 3: Implement owned data cleanup**

Add to `RuntimePort` and `OpenVikingRuntimeService`:

```ts
async clearData(): Promise<void> {
  const status = await this.getStatus();
  if (status.state === "running") {
    throw new Error("Stop OpenViking before clearing its data.");
  }
  await rm(this.resolveOwnedPath("data"), { recursive: true, force: true });
}
```

After the last workspace is deleted, call `stopRuntime()` and then `clearData()`. Do not call it when any workspace remains.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run runtime, control, and memory service tests. Expected: all pass.

### Task 4: Product copy and verification

**Files:**
- Modify: `.release-notes/openviking-memory-editing.md`

- [ ] **Step 1: Update the existing single release note**

Add user-facing Bug-fix bullets explaining that a selected Session is imported in one pass and deleting the final directory removes unfinished memory work. Do not add a second release-note file.

- [ ] **Step 2: Run targeted verification**

```bash
npx vitest run apps/main-2.0/src/main/services/openviking-memory-service.test.ts apps/main-2.0/src/main/services/openviking-control-service.test.ts apps/main-2.0/src/main/services/openviking-runtime-service.test.ts
npm --prefix apps/main-2.0 run typecheck
npm run release-note:check
```

Expected: all commands exit 0.

- [ ] **Step 3: Run OpenViking regression tests**

```bash
npx vitest run apps/main-2.0/src/main/openviking-main-wiring.test.ts apps/main-2.0/src/main/openviking-memory-ipc.test.ts apps/main-2.0/src/main/services/openviking-client.test.ts apps/main-2.0/src/main/services/openviking-settings-lifecycle.test.ts
```

Expected: all commands exit 0 with no UI or Electron process started by the tests.
