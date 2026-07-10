# Search Match Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show users the exact messages that caused a session search result and open a highlighted three-message context from each hit.

**Architecture:** Keep session-level FTS for candidate ranking, then batch-query message rows for the final page. Return structured hits on `SessionSearchResult`; renderer helpers highlight safe text nodes, and the App loads a separate three-message detail context without changing full-conversation pagination.

**Tech Stack:** TypeScript, Node SQLite/FTS5, Electron IPC, React, Vitest

---

### Task 1: Return structured message hits from SessionStore

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/session-store.ts`
- Test: `src/core/session-store.test.ts`

- [ ] **Step 1: Add failing store tests**

Create sessions where two AND terms appear in separate user/assistant messages and where a third message also matches. Assert the result contains:

```ts
{
  messageMatchCount: 3,
  matchHits: [
    { messageIndex: 0, role: "user", timestamp: "...", matchedTerms: ["login"] },
    { messageIndex: 1, role: "assistant", timestamp: "...", matchedTerms: ["expired"] },
  ],
}
```

Add title-only and project-only cases and assert `metadataMatch`. Assert empty queries return no structured hits.

- [ ] **Step 2: Run the store test and verify failure**

Run: `npm test -- src/core/session-store.test.ts`

Expected: FAIL because the structured fields do not exist.

- [ ] **Step 3: Add shared types**

Add `SessionMatchHit` and required defaulted fields on `SessionSearchResult`:

```ts
matchHits: SessionMatchHit[];
messageMatchCount: number;
metadataMatch: "title" | "project" | "summary" | null;
```

- [ ] **Step 4: Implement a single batch hit query**

After the final sessions are sliced, call a private helper with the page's session keys and normalized positive terms. Build one SQL statement with session-key placeholders and `lower(messages.content) LIKE ?` term predicates. Use `COUNT(*) OVER (PARTITION BY session_key)` and `ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY message_index)`; retain two rows per session.

Build a whitespace-normalized snippet around the earliest term and attach all terms present in that message. If extraction throws, leave empty hits and still return search results.

- [ ] **Step 5: Derive metadata-only reasons**

When a result has no message hit, test all terms against display title/first question, then project path; otherwise label the remaining FTS match as summary. Empty queries use `null`.

- [ ] **Step 6: Run store tests and typecheck**

Run: `npm test -- src/core/session-store.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/core/session-store.ts src/core/session-store.test.ts
git commit -m "feat: return structured search message hits"
```

### Task 2: Add safe search-term highlighting helpers

**Files:**
- Create: `src/renderer/src/search-highlight.tsx`
- Create: `src/renderer/src/search-highlight.test.tsx`

- [ ] **Step 1: Write failing helper tests**

Test standalone AND removal, unique terms, preservation of `android`, regex metacharacter escaping, case-insensitive multiple matches, and unchanged plain text when no term matches.

- [ ] **Step 2: Run the helper test and verify failure**

Run: `npm test -- src/renderer/src/search-highlight.test.tsx`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement helpers**

Export:

```ts
export function searchHighlightTerms(query: string): string[];
export function HighlightedSearchText({ text, terms }: { text: string; terms: string[] }): ReactElement;
```

Escape terms before building a capture-group regular expression. Render matching chunks as `<mark>` with stable index keys and all other chunks as text fragments. Never use `dangerouslySetInnerHTML`.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- src/renderer/src/search-highlight.test.tsx && npm run typecheck`

```bash
git add src/renderer/src/search-highlight.tsx src/renderer/src/search-highlight.test.tsx
git commit -m "feat: highlight search terms safely"
```

### Task 3: Render clickable hits in result rows

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `src/renderer/src/session-ui.test.ts`
- Test: `src/renderer/src/style-contract.test.ts`

- [ ] **Step 1: Add failing UI contract tests**

Assert `SessionRow` renders `messageMatchCount`, maps `matchHits`, uses `HighlightedSearchText`, labels user/assistant, formats time, stops event propagation, and invokes `onOpenMatch(session, hit)`. Assert metadata-only labels exist.

- [ ] **Step 2: Implement result hit UI**

Pass the executed `query` and a stable `onOpenMatch` callback into memoized rows. Render at most the two backend hits as buttons below metadata. Keep `matchSnippet` only as fallback when structured fields are absent.

- [ ] **Step 3: Add styles**

Add compact hit-count, hit-button, role/time, two-line snippet, `<mark>`, hover, and focus styles using existing theme tokens.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm test -- src/renderer/src/session-ui.test.ts src/renderer/src/style-contract.test.ts && npm run typecheck`

```bash
git add src/renderer/src/App.tsx src/renderer/src/styles.css src/renderer/src/session-ui.test.ts src/renderer/src/style-contract.test.ts
git commit -m "feat: show message hits in search results"
```

### Task 4: Load and highlight matched context in detail

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/detail-panel.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `src/renderer/src/detail-panel-actions.test.ts`

- [ ] **Step 1: Add failing context tests**

Assert opening a match fetches `getMessages(sessionKey, Math.max(0, messageIndex - 1), 3)`, stores a separate context, and normal opening clears it. Assert DetailPanel renders the exact message with a target class and highlights query terms.

- [ ] **Step 2: Implement dedicated context state**

Add `matchedContextMessages` and `matchedMessageIndex` to App. Implement `openMatch(session, hit)` to load normal detail plus the three-message context, guarded by the existing detail request sequence. Normal `openDetail` and close clear this state.

- [ ] **Step 3: Update DetailPanel**

Replace its derived context-from-latest-page behavior with explicit props. Render context before full conversation, give the exact hit `message match-target`, and pass highlight terms to `MessageBlock`. Keep full conversation unhighlighted unless it is in the explicit context.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- src/renderer/src/detail-panel-actions.test.ts src/renderer/src/session-ui.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/detail-panel.tsx src/renderer/src/styles.css src/renderer/src/detail-panel-actions.test.ts
git commit -m "feat: open highlighted message context"
```

### Task 5: Final verification

**Files:**
- Verify all changed files

- [ ] **Step 1: Run complete checks**

Run: `npm test && npm run typecheck && npm run build`

Expected: all tests pass and the production build succeeds.

- [ ] **Step 2: Check scope and sensitive information**

Run:

```bash
git diff --check
git status --short
git diff --stat main...HEAD
```

Expected: no whitespace errors and only scoped project changes.
