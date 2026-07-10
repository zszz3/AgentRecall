# Hide Subagent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Claude and Codex subagent sessions, persist their parent relationship, and hide them by default from all application lists and aggregates through a Settings toggle.

**Architecture:** Source loaders attach relationship metadata to `IndexedSession`; `SessionStore` persists it and accepts an `excludeSubagents` query option. The main process injects the persisted default-on setting into all user-visible searches, project queries, and statistics, while direct lookup remains available.

**Tech Stack:** TypeScript, Electron, React, Node SQLite, Vitest

---

### Task 1: Detect source-native subagent relationships

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/session-loader.ts`
- Test: `src/core/session-loader.test.ts`
- Test: `src/core/session-loader-extra-sources.test.ts`

- [ ] **Step 1: Write failing Codex metadata tests**

Add cases asserting that `parseCodexSessionMetaLine` returns `isSubagent: true` and `parentSessionId` for both `payload.source.subagent.thread_spawn.parent_thread_id` and the legacy `payload.thread_source` shape. Add negative cases for `forked_from_id`, `originator`, and `session_id` without an explicit subagent marker.

- [ ] **Step 2: Run the focused loader tests and verify failure**

Run: `npm test -- src/core/session-loader.test.ts`

Expected: FAIL because relationship fields are absent.

- [ ] **Step 3: Extend shared session types and Codex parsing**

Add to `IndexedSession`:

```ts
isSubagent: boolean;
parentSessionId: string | null;
```

Extend `CodexConversationLine.payload` for the two observed metadata shapes. Update `parseCodexSessionMetaLine` to return:

```ts
const spawn = line.payload.source?.subagent?.thread_spawn;
const legacyParent = line.payload.thread_source === "subagent" ? line.payload.parent_thread_id : undefined;
return {
  ...existing,
  isSubagent: Boolean(spawn?.parent_thread_id || legacyParent),
  parentSessionId: spawn?.parent_thread_id || legacyParent || null,
};
```

Make `createIndexedSession` require or safely default the two fields and pass the parsed Codex values.

- [ ] **Step 4: Add Claude discovery tests**

Create a fixture layout containing:

```text
projects/<project>/<parent-id>.jsonl
projects/<project>/<parent-id>/subagents/agent-child.jsonl
```

Assert that the child is loaded with `rawId === "child"`, `isSubagent === true`, `parentSessionId === "parent-id"`, and the parent's project path fallback. Add an `isSidechain: true` fixture case.

- [ ] **Step 5: Implement Claude subagent discovery**

Keep top-level session loading unchanged, then discover `subagents/*.jsonl` beneath each parent session directory. Read `agentId`, `sessionId`, `isSidechain`, and `cwd` from structured rows; use the directory parent ID only as a fallback. Call `loadClaudeCliSessionRows` with explicit relationship metadata and a child raw ID normalized from `agent-<id>.jsonl`.

- [ ] **Step 6: Run loader tests**

Run: `npm test -- src/core/session-loader.test.ts src/core/session-loader-extra-sources.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit source detection**

```bash
git add src/core/types.ts src/core/session-loader.ts src/core/session-loader.test.ts src/core/session-loader-extra-sources.test.ts
git commit -m "feat: detect subagent session relationships"
```

### Task 2: Persist and filter subagent sessions

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/session-store.ts`
- Test: `src/core/session-store.test.ts`

- [ ] **Step 1: Write failing migration and upsert tests**

Add a legacy schema test that constructs a store without relationship columns and asserts both columns are added. Add an upsert test asserting `is_subagent = 1` and `parent_session_id` are inserted and updated.

- [ ] **Step 2: Write failing query consistency tests**

Insert one root and one subagent in the same project and source. Assert that `excludeSubagents: true` excludes the child from search results and `totalCount`, `listProjects`, and all `getStats` totals, while omitted/false includes both and `getSession(childKey)` still returns the child.

- [ ] **Step 3: Run store tests and verify failure**

Run: `npm test -- src/core/session-store.test.ts`

Expected: FAIL because schema and query options are missing.

- [ ] **Step 4: Add schema migration and persistence**

Add columns to fresh schema and additive migration:

```sql
is_subagent INTEGER NOT NULL DEFAULT 0,
parent_session_id TEXT
```

Update `SessionRow`, INSERT, conflict UPDATE, and hydration. Detect whether `is_subagent` was newly added; when it is, set `file_mtime_ms = 0` for Claude and Codex source families so the normal startup refresh reparses legacy rows.

- [ ] **Step 5: Add query options and SQL predicates**

Add `excludeSubagents?: boolean` to `SearchOptions` and `SessionStatsOptions`, and define:

```ts
export interface ProjectQueryOptions {
  excludeSubagents?: boolean;
}
```

Apply `sessions.is_subagent = 0` inside candidate selection/counting, FTS matching eligibility, project grouping, active-session/message/token aggregates, and all-time token fallback before calculation.

- [ ] **Step 6: Run store tests**

Run: `npm test -- src/core/session-store.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit storage and queries**

```bash
git add src/core/types.ts src/core/session-store.ts src/core/session-store.test.ts
git commit -m "feat: filter subagents in session queries"
```

### Task 3: Add the persisted default-on setting and main-process injection

**Files:**
- Modify: `src/core/platform.ts`
- Modify: `src/main/index.ts`
- Test: `src/core/platform.test.ts`
- Test: `src/main/index.test.ts`

- [ ] **Step 1: Write failing settings tests**

Assert `defaultSettings.hideSubagentSessions === true` and `mergeAppSettings(defaultSettings, savedSettingsWithoutField)` retains true.

- [ ] **Step 2: Add the setting type and default**

Add:

```ts
hideSubagentSessions: boolean;
```

to `AppSettings` and set it to `true` in `defaultSettings`. Existing `AppSettingsUpdate` and Electron Store merging then persist it automatically.

- [ ] **Step 3: Write failing main-process injection tests**

Assert the handlers for `search:sessions`, `projects:list`, and `stats:get` pass `excludeSubagents: getSettings().hideSubagentSessions`. Cover internal AI finder calls that search the store.

- [ ] **Step 4: Inject visibility centrally**

Add small wrappers:

```ts
const visibleSearchOptions = (options: SearchOptions = {}): SearchOptions => ({
  ...options,
  excludeSubagents: getSettings().hideSubagentSessions,
});
```

Use the equivalent option for projects and stats in IPC handlers and internal user-visible searches. Do not filter `getSession(sessionKey)`.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- src/core/platform.test.ts src/main/index.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit settings integration**

```bash
git add src/core/platform.ts src/main/index.ts src/core/platform.test.ts src/main/index.test.ts
git commit -m "feat: hide subagent sessions by default"
```

### Task 4: Add the Settings toggle and immediate refresh

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Test: `src/renderer/src/theme.test.ts`

- [ ] **Step 1: Write failing renderer contract tests**

Assert `SettingsDialog` renders the bilingual `Hide subagent sessions` field, binds `checked` to `settings.hideSubagentSessions`, and calls `onSettingsChange({ hideSubagentSessions: event.currentTarget.checked })`. Assert `updateSettings` treats this change as a visibility change that reloads sessions, projects, and stats without invoking `refreshIndex`.

- [ ] **Step 2: Run renderer test and verify failure**

Run: `npm test -- src/renderer/src/theme.test.ts`

Expected: FAIL because the toggle is absent.

- [ ] **Step 3: Implement the toggle**

Add a checkbox in the general session visibility/source area:

```tsx
<label className="settings-field">
  <div className="settings-field-text">
    <span className="settings-field-title">{l("Hide subagent sessions", "隐藏 Subagent 会话")}</span>
    <span className="settings-field-sub">
      {l("Exclude subagents from session lists, project counts, and statistics.", "从会话列表、项目数量和统计中排除 Subagent。")}
    </span>
  </div>
  <input
    type="checkbox"
    checked={Boolean(settings?.hideSubagentSessions)}
    disabled={!settings || saving}
    onChange={(event) => onSettingsChange({ hideSubagentSessions: event.currentTarget.checked })}
  />
</label>
```

The existing `updateSettings` post-save `Promise.all([load(), loadSidebarMetadata(), loadStats()])` supplies the immediate refresh; do not add an index refresh.

- [ ] **Step 4: Run renderer tests and typecheck**

Run: `npm test -- src/renderer/src/theme.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit UI**

```bash
git add src/renderer/src/App.tsx src/renderer/src/theme.test.ts
git commit -m "feat: add subagent visibility setting"
```

### Task 5: Preserve relationship metadata through remote sessions and verify

**Files:**
- Modify: `src/core/remote-session-sync.ts`
- Modify: `src/core/remote-session-loader.ts`
- Test: `src/core/remote-session-sync.test.ts`
- Test: `src/core/remote-session-loader.test.ts`

- [ ] **Step 1: Write failing remote compatibility tests**

Assert portable payloads containing `isSubagent` and `parentSessionId` round-trip those values. Assert older payloads without them load as `false` and `null`.

- [ ] **Step 2: Implement backward-compatible serialization**

Add optional relationship fields to the remote portable/index metadata. Normalize absent values with:

```ts
isSubagent: payload.isSubagent === true,
parentSessionId: typeof payload.parentSessionId === "string" ? payload.parentSessionId : null,
```

- [ ] **Step 3: Run remote tests**

Run: `npm test -- src/core/remote-session-sync.test.ts src/core/remote-session-loader.test.ts`

Expected: PASS.

- [ ] **Step 4: Run the complete verification suite**

Run: `npm test && npm run typecheck && npm run build`

Expected: all tests pass, typecheck succeeds, and Electron/Vite production build completes.

- [ ] **Step 5: Inspect repository content and diff**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~4..HEAD
```

Expected: no whitespace errors and only scoped files changed.

- [ ] **Step 6: Commit remote compatibility if changed**

```bash
git add src/core/remote-session-sync.ts src/core/remote-session-loader.ts src/core/remote-session-sync.test.ts src/core/remote-session-loader.test.ts
git commit -m "feat: preserve subagent metadata in remote sessions"
```
