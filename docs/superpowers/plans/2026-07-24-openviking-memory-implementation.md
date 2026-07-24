# OpenViking Directory Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rules-file Memory page with an opt-in, directory-scoped OpenViking memory system that installs a managed runtime, imports existing sessions, and configures Claude Code/Codex lifecycle hooks.

**Architecture:** Electron owns a local OpenViking control plane. A focused runtime service installs and starts the Python sidecar; a PostgreSQL repository persists workspace and import state; an OpenViking gateway owns HTTP/SDK contracts; and one application service exposes validated IPC operations to the renderer. Hook wrappers consult a generated directory manifest before forwarding events to the official OpenViking plugin flow.

**Tech Stack:** Electron 42, TypeScript 5.7, React 19, PostgreSQL, Vitest, Node test runner, `@openviking/sdk`, managed CPython/OpenViking archives.

---

## File structure

- `src/core/openviking-memory.ts`: renderer-safe domain types, workspace identity normalization, import fingerprints.
- `src/core/postgres/openviking-memory-repository.ts`: workspace/import persistence only.
- `src/main/services/openviking-runtime-service.ts`: optional component install/status/uninstall and Sidecar lifecycle.
- `src/main/services/openviking-client.ts`: narrow OpenViking API adapter; no UI or database logic.
- `src/main/services/openviking-memory-service.ts`: workspace, memory and import orchestration.
- `src/shared/ipc/openviking-memory.ts`: validated IPC contracts.
- `src/main/ipc/openviking-memory.ts`: IPC registration.
- `src/preload/openviking-memory.ts`: renderer API.
- `src/renderer/src/features/openviking-memory/openviking-memory-page.tsx`: replacement Memory page.
- `src/renderer/src/features/settings/openviking-memory-settings.tsx`: settings pane for the optional component and model.
- `src/renderer/src/styles/openviking-memory.css`: page/settings presentation.
- `bin/openviking-memory-hook.mjs`: directory whitelist wrapper for Claude/Codex hooks.
- `bin/setup-openviking-memory-hooks.cjs`: idempotent hook installation/removal.
- `scripts/build-openviking-runtime.mjs`: platform runtime artifact builder.
- `.release-notes/openviking-directory-memory.md`: one user-facing feature note.

### Task 1: Domain settings and workspace identity

**Files:**
- Create: `src/core/openviking-memory.ts`
- Create: `src/core/openviking-memory.test.ts`
- Modify: `src/core/platform.ts`
- Modify: `src/core/platform.test.ts`

- [ ] **Step 1: Write failing settings and identity tests**

```ts
expect(defaultSettings.openVikingMemoryEnabled).toBe(false);
expect(mergeAppSettings(defaultSettings, {
  openVikingMemoryEnabled: true,
  openVikingClaudeEnabled: true,
}).openVikingMemoryEnabled).toBe(true);

expect(workspaceUserId("repo:github.com/acme/app")).toMatch(/^workspace_[a-f0-9]{24}$/);
expect(workspaceUserId("repo:github.com/acme/app")).toBe(workspaceUserId("repo:github.com/acme/app"));
```

- [ ] **Step 2: Run the focused tests and confirm they fail because the new fields/module do not exist**

Run: `npx vitest run src/core/openviking-memory.test.ts src/core/platform.test.ts`

- [ ] **Step 3: Add normalized settings and domain types**

Add boolean settings for Memory, Claude and Codex integration plus local/remote embedding selection. Implement deterministic SHA-256-derived OpenViking user IDs and path normalization in `src/core/openviking-memory.ts`.

- [ ] **Step 4: Run focused tests and commit**

Run: `npx vitest run src/core/openviking-memory.test.ts src/core/platform.test.ts`

Commit: `feat(memory): add OpenViking domain settings`

### Task 2: PostgreSQL workspace and import persistence

**Files:**
- Modify: `src/core/postgres/schema.ts`
- Create: `src/core/postgres/openviking-memory-repository.ts`
- Create: `src/core/postgres/openviking-memory-repository.test.ts`
- Modify: `src/core/session-store.ts`
- Modify: `src/core/postgres/schema.test.ts`

- [ ] **Step 1: Write failing repository tests**

```ts
const created = await repository.addWorkspace({
  id: "workspace-1",
  userId: "workspace_abcd",
  rootPath: project,
  identity: "repo:github.com/acme/app",
  displayName: "app",
});
expect(await repository.listWorkspaces()).toEqual([created]);

await repository.recordImportedTurn("workspace-1", "codex:1", "turn-hash");
expect(await repository.hasImportedTurn("workspace-1", "codex:1", "turn-hash")).toBe(true);
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/core/postgres/openviking-memory-repository.test.ts src/core/postgres/schema.test.ts`

- [ ] **Step 3: Add migration 4 and repository**

Create `openviking_workspaces`, `openviking_import_jobs`, and `openviking_imported_turns`. Use foreign keys and unique constraints to make retries idempotent. Expose repository operations through `SessionStore` without leaking SQL to the main service.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run src/core/postgres/openviking-memory-repository.test.ts src/core/postgres/schema.test.ts`

Commit: `feat(memory): persist OpenViking workspaces`

### Task 3: Optional runtime and Sidecar lifecycle

**Files:**
- Create: `src/main/services/openviking-runtime-service.ts`
- Create: `src/main/services/openviking-runtime-service.test.ts`
- Create: `scripts/build-openviking-runtime.mjs`
- Create: `scripts/build-openviking-runtime.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
expect(await service.getStatus()).toMatchObject({ state: "not-installed" });
await service.install(manifest);
expect(await service.getStatus()).toMatchObject({ state: "stopped", version: manifest.version });
await service.start();
expect(await service.getStatus()).toMatchObject({ state: "running" });
await service.stop();
expect(fakeChild.killed).toBe(true);
```

Also test archive path traversal rejection, SHA-256 mismatch, loopback-only arguments, stale PID recovery and Windows executable paths.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/main/services/openviking-runtime-service.test.ts`

- [ ] **Step 3: Implement the managed component**

Use `<userData>/openviking/{runtime,data,models,downloads}`. Download to `.part`, validate SHA-256, extract into a versioned staging directory, validate the executable and atomically activate it. Spawn `openviking-server` with an app-owned config, a loopback host and an allocated port. Never use system Python or a global prefix.

The build script must accept an explicit temporary HOME/output directory, package CPython + pinned OpenViking, emit platform metadata and checksums, and refuse broad output paths.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run src/main/services/openviking-runtime-service.test.ts && node --test scripts/build-openviking-runtime.test.mjs`

Commit: `feat(memory): manage OpenViking runtime`

### Task 4: OpenViking API gateway

**Files:**
- Create: `src/main/services/openviking-client.ts`
- Create: `src/main/services/openviking-client.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the official SDK and write failing contract tests**

Run: `npm install @openviking/sdk@0.1.0`

Test health, account/user creation, session batch append/commit/task polling, memory search/read/write/delete and error normalization against a local fake HTTP server.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/main/services/openviking-client.test.ts`

- [ ] **Step 3: Implement a narrow adapter**

```ts
export interface OpenVikingClientPort {
  health(): Promise<void>;
  ensureWorkspaceUser(input: { accountId: string; userId: string }): Promise<{ apiKey: string }>;
  appendMessages(userKey: string, sessionId: string, messages: OpenVikingMessage[]): Promise<void>;
  commitSession(userKey: string, sessionId: string): Promise<OpenVikingTaskRef>;
  searchMemories(userKey: string, query: string): Promise<OpenVikingMemoryItem[]>;
}
```

Keep authentication headers and SDK response-envelope handling inside this file.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run src/main/services/openviking-client.test.ts`

Commit: `feat(memory): add OpenViking API gateway`

### Task 5: Memory application service and historical import

**Files:**
- Create: `src/main/services/openviking-memory-service.ts`
- Create: `src/main/services/openviking-memory-service.test.ts`
- Modify: `src/core/postgres/session-repository.ts`
- Modify: `src/core/session-store.ts`

- [ ] **Step 1: Write failing orchestration tests**

Cover directory add/duplicate/relink, import preview, deterministic session IDs, turn filtering, max-content truncation, imported-turn dedupe, pause/resume, failed-task retry, stop management and delete ordering.

```ts
const preview = await service.previewDirectory(project);
expect(preview).toMatchObject({ rootPath: project, sessionCount: 2 });
await service.addWorkspace(project);
await service.importWorkspace("workspace-1");
expect(client.appendedMessages).toEqual([
  expect.objectContaining({ role: "user", content: "question" }),
  expect.objectContaining({ role: "assistant", content: "answer" }),
]);
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/main/services/openviking-memory-service.test.ts`

- [ ] **Step 3: Implement minimal orchestration**

Add a bounded session query by exact `project_path`. Normalize user/assistant messages, remove empty content, cap individual content and total batch size, compute turn fingerprints and persist checkpoints only after OpenViking accepts the batch. Delete remote user data before deleting the local workspace mapping.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run src/main/services/openviking-memory-service.test.ts src/core/postgres/session-repository.test.ts`

Commit: `feat(memory): import directory sessions into OpenViking`

### Task 6: IPC and preload API

**Files:**
- Create: `src/shared/ipc/openviking-memory.ts`
- Create: `src/main/ipc/openviking-memory.ts`
- Create: `src/main/openviking-memory-ipc.test.ts`
- Create: `src/preload/openviking-memory.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/global.d.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Write failing IPC validation tests**

Reject NUL paths, oversized search queries, invalid workspace IDs and unknown destructive actions. Verify every registered handler delegates exactly once.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/main/openviking-memory-ipc.test.ts`

- [ ] **Step 3: Register the service**

Expose snapshot, runtime install/uninstall/start, model download/delete, directory preview/add/relink, import pause/resume/retry, search/read/save/delete memory, stop management and delete workspace.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run src/main/openviking-memory-ipc.test.ts src/preload/automation.test.ts`

Commit: `feat(memory): expose OpenViking IPC`

### Task 7: Replace Memory and add settings UI

**Files:**
- Create: `src/renderer/src/features/openviking-memory/openviking-memory-page.tsx`
- Create: `src/renderer/src/features/openviking-memory/openviking-memory-page.test.tsx`
- Create: `src/renderer/src/features/settings/openviking-memory-settings.tsx`
- Create: `src/renderer/src/features/settings/openviking-memory-settings.test.tsx`
- Create: `src/renderer/src/styles/openviking-memory.css`
- Modify: `src/renderer/src/features/settings/settings-dialog.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/main.tsx`
- Delete: `src/renderer/src/features/agent-memory/agent-memory-page.tsx`
- Delete: `src/renderer/src/styles/agent-memory.css`
- Delete: `src/renderer/src/styles/agent-memory-sync.css`

- [ ] **Step 1: Write failing renderer tests**

Test disabled empty state, component/model progress, add-directory preview, workspace list, import status, search/detail editing, stop vs delete confirmation and bilingual labels.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/renderer/src/features/openviking-memory/openviking-memory-page.test.tsx src/renderer/src/features/settings/openviking-memory-settings.test.tsx`

- [ ] **Step 3: Implement the approved UI**

Use the existing Memory sidebar route. Keep runtime configuration in Settings and directory/memory operations on the Memory page. Poll only while a runtime/import task is non-terminal. Do not expose AGENTS/CLAUDE/Cursor file controls.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run src/renderer/src/features/openviking-memory/openviking-memory-page.test.tsx src/renderer/src/features/settings/openviking-memory-settings.test.tsx src/renderer/src/agent-memory-ui.test.ts`

Commit: `feat(memory): replace Memory page with OpenViking`

### Task 8: Directory-scoped Claude and Codex hooks

**Files:**
- Create: `bin/openviking-memory-hook.mjs`
- Create: `bin/setup-openviking-memory-hooks.cjs`
- Create: `scripts/openviking-memory-hooks.test.mjs`
- Modify: `package.json`
- Modify: `bin/uninstall.cjs`

- [ ] **Step 1: Write failing synthetic-HOME tests**

Use a temporary HOME and synthetic hook payloads. Verify unmanaged directories exit without reading Prompt content or making a request; managed directories resolve the correct workspace user; recall output uses each harness protocol; capture writes are queued on transient failure; setup is idempotent; uninstall removes only AgentRecall-owned entries.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/openviking-memory-hooks.test.mjs`

- [ ] **Step 3: Implement hook wrapper and installer**

Read a mode-0600 manifest generated by AgentRecall. Resolve real paths with platform-aware containment checks. Forward managed events to OpenViking using the workspace user key. Implement Claude `UserPromptSubmit`, `Stop`, `PreCompact`, `SessionEnd` and Codex equivalents supported by the installed version. Fail open on every hook error and keep a bounded retry queue.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test scripts/openviking-memory-hooks.test.mjs scripts/uninstall.test.mjs`

Commit: `feat(memory): add directory-scoped OpenViking hooks`

### Task 9: Release note, documentation and full verification

**Files:**
- Create: `.release-notes/openviking-directory-memory.md`
- Modify: `README.md`
- Modify: `docs/README.en.md`

- [ ] **Step 1: Add user-facing release copy**

```md
# 目录级长期记忆

## 新增功能

- 可为选定项目启用本地长期记忆，自动从历史和新会话中沉淀经验，并在 Claude Code 与 Codex 工作时召回相关内容。
```

- [ ] **Step 2: Run focused safety checks**

Run hooks/install tests with temporary HOME and prefix. Confirm no real Agent, model, OpenViking or session data is touched.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run release-note:check
```

- [ ] **Step 4: Inspect diff and commit**

Confirm exactly one release note exists for the branch, no generated runtime archives are tracked, no Sidecar processes remain, and no unrelated files changed.

Commit: `docs(memory): document OpenViking memory`
