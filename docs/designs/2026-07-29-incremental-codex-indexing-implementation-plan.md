# Incremental Codex Session Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AgentRecall V1 and V2 index arbitrarily large Codex JSONL sessions with a bounded-memory first scan and byte-cursor incremental updates after Resume.

**Architecture:** Add equivalent Codex streaming scanners to V1 and V2 that reduce each complete JSONL line immediately into indexed messages, token events, traces, and metadata. Persist a cursor-safe index version and the last complete-line byte offset; append deltas transactionally when the source only grew, and stream-rebuild when the source shrank, was replaced, or contains a rollback that invalidates prior visible turns.

**Tech Stack:** TypeScript, Node.js file descriptors and `TextDecoder`, Vitest, SQLite (`node:sqlite`) for V1, PostgreSQL/pg and PGlite tests for V2.

---

## File Map

- Create `apps/main-1.0/src/core/codex-jsonl-stream.ts`: V1 bounded-memory complete-line reader and Codex accumulator.
- Create `apps/main-2.0/src/core/codex-jsonl-stream.ts`: V2 equivalent kept application-local.
- Create `apps/main-1.0/src/core/codex-jsonl-stream.test.ts`: reader and accumulator tests with synthetic files.
- Create `apps/main-2.0/src/core/codex-jsonl-stream.test.ts`: V2 parity tests.
- Modify `apps/main-1.0/src/core/session-loader.ts`: route Codex files through the streaming scanner.
- Modify `apps/main-2.0/src/core/session-loader.ts`: route Codex files through the streaming scanner.
- Modify `apps/main-1.0/src/core/types.ts`: add cursor/update contracts.
- Modify `apps/main-2.0/src/core/types.ts`: add cursor/update contracts.
- Modify `apps/main-1.0/src/core/store/schema.ts`: add the cursor-safe format version.
- Modify `apps/main-2.0/src/core/postgres/schema.ts`: add the cursor-safe format version.
- Modify `apps/main-1.0/src/core/store/sessions.ts`: expose cursor state and transactional delta append.
- Modify `apps/main-2.0/src/core/postgres/session-repository.ts`: expose cursor state and transactional delta append.
- Modify both `src/core/session-store.ts` files: expose the backend operations to the indexer.
- Modify both `src/core/indexer.ts` files: choose skip, append, or rebuild per Codex file and surface scan failures.
- Modify both Session catalog query paths so open sessions are included alongside the normal first page.
- Add `.release-notes/fix-incremental-codex-indexing.md`: one user-facing bug-fix note covering V1 and V2.

### Task 1: Complete-line streaming reader in both applications

**Files:**
- Create: `apps/main-1.0/src/core/codex-jsonl-stream.ts`
- Create: `apps/main-2.0/src/core/codex-jsonl-stream.ts`
- Test: `apps/main-1.0/src/core/codex-jsonl-stream.test.ts`
- Test: `apps/main-2.0/src/core/codex-jsonl-stream.test.ts`

- [ ] **Step 1: Write failing tests for chunk boundaries and incomplete tails**

Each test creates a temporary JSONL file containing one record larger than the configured test chunk, followed by a complete record and an incomplete record. The desired API is:

```ts
const result = scanCompleteJsonl(filePath, {
  startOffset: 0,
  chunkSize: 17,
  onRecord: (record) => records.push(record),
});

expect(records).toEqual([largeRecord, secondRecord]);
expect(result.committedOffset).toBe(Buffer.byteLength(
  `${JSON.stringify(largeRecord)}\n${JSON.stringify(secondRecord)}\n`,
));
expect(result.fileSize).toBeGreaterThan(result.committedOffset);
```

- [ ] **Step 2: Run both focused tests and verify RED**

Run:

```bash
npm --prefix apps/main-1.0 exec vitest run src/core/codex-jsonl-stream.test.ts
npm --prefix apps/main-2.0 exec vitest run src/core/codex-jsonl-stream.test.ts
```

Expected: FAIL because `scanCompleteJsonl` does not exist.

- [ ] **Step 3: Implement the bounded reader**

Implement the same application-local contract in both files:

```ts
export interface JsonlScanResult {
  startOffset: number;
  committedOffset: number;
  fileSize: number;
  malformedLines: number;
}

export function scanCompleteJsonl(
  filePath: string,
  options: {
    startOffset?: number;
    chunkSize?: number;
    onRecord(record: unknown): void;
  },
): JsonlScanResult;
```

Use `fs.openSync`, `fs.readSync`, and a UTF-8 `TextDecoder`. Carry bytes after the final newline into the next chunk, support CRLF, invoke `onRecord` immediately, and advance `committedOffset` only after a complete newline. Throw file open/read errors; count malformed complete lines without throwing.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the two commands from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the reader**

```bash
git add apps/main-1.0/src/core/codex-jsonl-stream.ts apps/main-1.0/src/core/codex-jsonl-stream.test.ts \
  apps/main-2.0/src/core/codex-jsonl-stream.ts apps/main-2.0/src/core/codex-jsonl-stream.test.ts
git commit -m "fix: stream complete Codex JSONL records"
```

### Task 2: Stateful Codex reduction without retaining raw rows

**Files:**
- Modify: `apps/main-1.0/src/core/codex-jsonl-stream.ts`
- Modify: `apps/main-2.0/src/core/codex-jsonl-stream.ts`
- Modify: `apps/main-1.0/src/core/session-loader.ts`
- Modify: `apps/main-2.0/src/core/session-loader.ts`
- Test: both `codex-jsonl-stream.test.ts` files

- [ ] **Step 1: Write a failing bounded-retention behavior test**

Generate thousands of tool-output rows containing large payloads and assert the accumulator returns metadata, visible messages, deduplicated/truncated trace events, and token events without exposing a `rows` collection:

```ts
const indexed = loadCodexSessionFileStreaming(filePath, {
  chunkSize: 31,
  includeTraceEvents: true,
});

expect(indexed?.session.rawId).toBe("session-large");
expect(indexed?.messages.map((message) => message.content)).toContain("final answer");
expect(indexed?.traceEvents.every((event) => event.detail.length <= TRACE_DETAIL_LIMIT)).toBe(true);
expect("rows" in (indexed ?? {})).toBe(false);
```

Also add a rollback case. When a `thread_rolled_back` record removes an already committed turn during an append scan, the result must set `requiresRebuild: true`.

- [ ] **Step 2: Run focused tests and verify RED**

Expected: FAIL because the streaming Codex accumulator is absent.

- [ ] **Step 3: Move Codex row reduction behind a stateful accumulator**

Implement:

```ts
export interface CodexIndexScan {
  mode: "rebuild" | "append";
  startOffset: number;
  committedOffset: number;
  fileSize: number;
  requiresRebuild: boolean;
  loaded: LoadedSession | null;
}

export function loadCodexSessionFileStreaming(
  filePath: string,
  options: {
    mode?: "rebuild" | "append";
    startOffset?: number;
    chunkSize?: number;
    title?: string;
    updatedAt?: string;
    sourceOverride?: SessionSource;
    includeTraceEvents?: boolean;
  },
): CodexIndexScan;
```

The accumulator consumes one parsed record at a time. It retains only derived messages/events and the current visible-turn state. It keeps cumulative-token state while rebuilding; append scans derive new token events from `last_token_usage`, whose records are safe because the cursor prevents reprocessing. Existing `loadCodexSessionRows` remains available for migration fixtures and non-file callers.

- [ ] **Step 4: Route Codex file iteration through the new scanner**

In each `loadCodexSessionsIterator`, replace `readJsonl(filePath)` for Codex session files with `loadCodexSessionFileStreaming`. Keep `session_index.jsonl` on the small generic reader. Do not change Claude, CodeBuddy, or other source loaders.

- [ ] **Step 5: Run focused loader suites**

Run:

```bash
npm --prefix apps/main-1.0 exec vitest run src/core/codex-jsonl-stream.test.ts src/core/session-loader.test.ts
npm --prefix apps/main-2.0 exec vitest run src/core/codex-jsonl-stream.test.ts src/core/session-loader.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the reducer**

```bash
git add apps/main-1.0/src/core/codex-jsonl-stream.ts apps/main-1.0/src/core/codex-jsonl-stream.test.ts \
  apps/main-1.0/src/core/session-loader.ts apps/main-2.0/src/core/codex-jsonl-stream.ts \
  apps/main-2.0/src/core/codex-jsonl-stream.test.ts apps/main-2.0/src/core/session-loader.ts
git commit -m "fix: reduce large Codex logs during streaming"
```

### Task 3: Cursor-safe state and incremental SQLite persistence in V1

**Files:**
- Modify: `apps/main-1.0/src/core/types.ts`
- Modify: `apps/main-1.0/src/core/store/schema.ts`
- Modify: `apps/main-1.0/src/core/store/sessions.ts`
- Modify: `apps/main-1.0/src/core/session-store.ts`
- Modify: `apps/main-1.0/src/core/indexer.ts`
- Test: `apps/main-1.0/src/core/session-store.test.ts`
- Test: `apps/main-1.0/src/core/indexer.test.ts`

- [ ] **Step 1: Write failing SQLite cursor and append tests**

Index an initial synthetic Codex file, append one user/assistant turn, refresh, and assert the old message rows remain while only the new indices are appended. Assert an incomplete final line does not advance the cursor. Then truncate the source and assert a rebuild replaces the derived content.

The store contract is:

```ts
interface CodexIndexCursor {
  sessionKey: string;
  filePath: string;
  committedOffset: number;
  indexVersion: number;
  messageCount: number;
  traceCount: number;
}

store.getCodexIndexCursor(filePath);
store.appendCodexIndexDelta(expectedOffset, scan);
```

- [ ] **Step 2: Run the focused V1 tests and verify RED**

Run:

```bash
npm --prefix apps/main-1.0 exec vitest run src/core/indexer.test.ts src/core/session-store.test.ts
```

Expected: FAIL because cursor state and delta append do not exist.

- [ ] **Step 3: Add the V1 schema marker**

Add `content_index_version INTEGER NOT NULL DEFAULT 0` to new schemas and `addColumnIfMissing`. Version `1` means `content_indexed_size` is a committed complete-line byte cursor produced by the streaming reader.

- [ ] **Step 4: Implement transactional SQLite append**

Within one SQLite transaction:

```ts
if (stored.content_indexed_size !== expectedOffset || stored.content_index_version !== 1) {
  throw new CodexIndexCursorMismatchError();
}
```

Continue message and trace indices from stored counts, insert new token events with existing dedupe constraints, refresh affected FTS rows, update totals, and finally set `content_indexed_size = scan.committedOffset`. On rollback or cursor mismatch, leave all prior rows unchanged.

- [ ] **Step 5: Select append versus rebuild in the V1 indexer**

Use append only when version is `1`, file size is at least the cursor, and the streaming delta does not request a rebuild. Legacy version `0`, truncation, cursor mismatch, and rollback use a streamed full rebuild.

- [ ] **Step 6: Run V1 focused and full tests**

Run:

```bash
npm --prefix apps/main-1.0 exec vitest run src/core/codex-jsonl-stream.test.ts src/core/indexer.test.ts src/core/session-store.test.ts
npm --prefix apps/main-1.0 test
```

Expected: PASS.

- [ ] **Step 7: Commit V1 persistence**

```bash
git add apps/main-1.0/src/core
git commit -m "fix: append resumed Codex sessions in V1"
```

### Task 4: Cursor-safe state and incremental PostgreSQL persistence in V2

**Files:**
- Modify: `apps/main-2.0/src/core/types.ts`
- Modify: `apps/main-2.0/src/core/postgres/schema.ts`
- Modify: `apps/main-2.0/src/core/postgres/session-repository.ts`
- Modify: `apps/main-2.0/src/core/session-store.ts`
- Modify: `apps/main-2.0/src/core/indexer.ts`
- Test: `apps/main-2.0/src/core/postgres/session-repository.test.ts`
- Test: `apps/main-2.0/src/core/indexer.test.ts`

- [ ] **Step 1: Write failing PostgreSQL cursor and append tests**

Repeat the V1 observable scenarios through the V2 `SessionStore`: initial rebuild, append, incomplete tail, truncation, and injected read failure preserving prior indexed content.

- [ ] **Step 2: Run focused V2 tests and verify RED**

Run:

```bash
npm --prefix apps/main-2.0 exec vitest run src/core/indexer.test.ts src/core/postgres/session-repository.test.ts
```

Expected: FAIL because PostgreSQL cursor state and append are absent.

- [ ] **Step 3: Add the V2 schema marker**

Add `content_index_version integer NOT NULL DEFAULT 0` to the base schema and idempotent migration.

- [ ] **Step 4: Implement transactional PostgreSQL append**

Lock the session row with `SELECT ... FOR UPDATE`, compare version and expected cursor, append derived raw/message/token events, regenerate only the final affected turn plus new turns, update session counts/totals, and advance the cursor last. Sanitize NUL characters through the existing `SessionStore` boundary.

- [ ] **Step 5: Select append versus rebuild in the V2 indexer**

Mirror V1 decisions and ensure a per-file scan exception increments the failed-session count rather than yielding an empty `LoadedSession`.

- [ ] **Step 6: Run V2 focused and full tests**

Run:

```bash
npm --prefix apps/main-2.0 exec vitest run src/core/codex-jsonl-stream.test.ts src/core/indexer.test.ts src/core/postgres/session-repository.test.ts
npm --prefix apps/main-2.0 test
```

Expected: PASS.

- [ ] **Step 7: Commit V2 persistence**

```bash
git add apps/main-2.0/src/core
git commit -m "fix: append resumed Codex sessions in V2"
```

### Task 5: Include older open Codex sessions in the first Session page

**Files:**
- Modify: `apps/main-1.0/src/renderer/src/features/sessions/use-session-catalog.ts`
- Modify: `apps/main-2.0/src/renderer/src/features/sessions/use-session-catalog.ts`
- Modify: `apps/main-1.0/src/core/store/sessions.ts`
- Modify: `apps/main-2.0/src/core/postgres/session-search-repository.ts`
- Test: `apps/main-1.0/src/core/session-store.test.ts`
- Test: `apps/main-2.0/src/core/postgres/session-search.test.ts`

- [ ] **Step 1: Write a failing page-selection test**

Create more than 30 indexed sessions, mark an older Codex raw ID live, request the default first page, and assert the live session is present, ordered before closed sessions, without reducing the closed-session page below 30.

- [ ] **Step 2: Run the focused tests and verify RED**

Expected: FAIL because live keys are omitted when `liveStatus === "all"`.

- [ ] **Step 3: Pass live keys for the default page and merge open rows**

The repository returns the union of:

- every matching indexed session whose computed live key is in `liveSessionKeys`;
- the normal limited page of matching sessions.

Deduplicate by `session_key`, order open sessions first in the renderer, and keep pagination counts based on unique rows.

- [ ] **Step 4: Run focused Session page/search tests**

Expected: PASS in both applications.

- [ ] **Step 5: Commit Session visibility**

```bash
git add apps/main-1.0/src apps/main-2.0/src
git commit -m "fix: keep resumed Codex sessions visible"
```

### Task 6: Release note and verification

**Files:**
- Create: `.release-notes/fix-incremental-codex-indexing.md`

- [ ] **Step 1: Add exactly one user-facing release note**

```md
# 大型 Codex 会话可持续索引

## Bug 修复

- 修复大型 Codex 会话可能无法出现在 Session 页面，以及恢复旧会话后打开状态不易看到的问题；首次扫描改为低内存处理，后续只索引新增内容。
```

- [ ] **Step 2: Run static and release-note checks**

Run:

```bash
npm run typecheck
npm run release-note:check
git diff --check
```

Expected: all exit successfully.

- [ ] **Step 3: Run both complete test suites**

Run:

```bash
npm run test:v1
npm run test:v2
```

Expected: PASS.

- [ ] **Step 4: Build both applications**

Run:

```bash
npm run build
```

Expected: V1 and V2 production builds complete successfully.

- [ ] **Step 5: Perform a bounded real-file read-only verification**

Run the streaming scanner against the existing large Codex source with persistence disabled. Report file size, committed offset, session ID, and derived counts only; do not print message contents or modify the source.

Expected: the scan completes without Node's maximum-string error and without changing the Codex file.

- [ ] **Step 6: Confirm no user data or processes were changed**

Verify tests used temporary homes/databases, no Electron process remains, and `git status` contains only intended branch changes plus the user's pre-existing `.gitignore` edit.

- [ ] **Step 7: Commit release metadata**

```bash
git add .release-notes/fix-incremental-codex-indexing.md
git commit -m "docs: note large Codex indexing fix"
```
