# Session Time Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the existing session time-range filter to the latest main branch, remove the sort selector, and document the final behavior.

**Architecture:** Reuse the tested date-range model and storage predicates from commit `ec23bb7`, resolving the renderer against the latest `App.tsx`. Keep core sorting compatibility but make the renderer always request activity ordering, so filtering and displayed timestamps share the same latest-activity definition.

**Tech Stack:** TypeScript, React, SQLite, Vitest, CSS, Markdown

---

### Task 1: Port date-range filtering

**Files:**
- Create: `src/renderer/src/date-range.ts`
- Create: `src/renderer/src/date-range.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/session-store.ts`
- Modify: `src/core/session-store.test.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/style-contract.test.ts`

- [x] **Step 1: Apply the existing tested feature commit**

Run: `git cherry-pick ec23bb7`

Expected: Git applies cleanly or reports conflicts only in files changed on `main`; preserve the latest main behavior while retaining `dateFrom`, `dateTo`, `DATE_RANGE_OPTIONS`, and `.date-filter` changes.

- [x] **Step 2: Run the focused feature tests**

Run: `npx vitest run src/renderer/src/date-range.test.ts src/core/session-store.test.ts src/renderer/src/style-contract.test.ts`

Expected: all selected test files pass.

### Task 2: Remove the renderer sort selector

**Files:**
- Create: `src/renderer/src/session-filter-contract.test.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/session-ui.ts`
- Modify: `src/renderer/src/session-ui.test.ts`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/style-contract.test.ts`

- [x] **Step 1: Add a failing renderer contract test**

Create a test that reads `App.tsx` and `styles.css`, then asserts:

```ts
expect(appSource).toContain('sortBy: "activity"');
expect(appSource).toContain('className="date-filter"');
expect(appSource).not.toContain('className="sort-menu"');
expect(appSource).not.toContain("setSortBy");
expect(stylesheet).not.toMatch(/\.sort-menu/);
```

- [x] **Step 2: Verify the contract test fails for the existing sort control**

Run: `npx vitest run src/renderer/src/session-filter-contract.test.ts`

Expected: FAIL because `App.tsx` and `styles.css` still contain `sort-menu`.

- [x] **Step 3: Remove selectable sorting while preserving activity order**

In `App.tsx`, remove `sortBy` state, `sortLabel`, `sessionSortOptions`, the sort `<label>`, and all dependencies on mutable sorting. Set search requests to `sortBy: "activity"`; call `projectSortTimestamp(project, "activity")` and `sessionSortTimestamp(session, "activity")` so displayed times remain latest activity.

Remove `sessionSortOptions` and its option-label tests, while keeping timestamp helpers used by project/session rows. Remove all `.sort-menu` CSS blocks and adjust the toolbar contract to the date filter width introduced by Task 1.

- [x] **Step 4: Verify renderer tests pass**

Run: `npx vitest run src/renderer/src/session-filter-contract.test.ts src/renderer/src/session-ui.test.ts src/renderer/src/style-contract.test.ts`

Expected: all selected test files pass.

### Task 3: Update project documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/README.en.md`
- Modify: `src/core/readme-assets.test.ts`

- [x] **Step 1: Add a failing README behavior assertion**

Extend `src/core/readme-assets.test.ts` to require the Chinese README to mention `7 天、30 天或 90 天` and the English README to mention `7, 30, or 90 days`.

- [x] **Step 2: Verify the README assertion fails**

Run: `npx vitest run src/core/readme-assets.test.ts`

Expected: FAIL because the feature is not documented.

- [x] **Step 3: Document the time filter in both feature summaries**

Add concise text to the unified session-search bullet: users can filter sessions from all time or the last 7, 30, or 90 days, with newest activity shown first. Do not mention the removed sort selector.

- [x] **Step 4: Verify the README assertion passes**

Run: `npx vitest run src/core/readme-assets.test.ts`

Expected: PASS.

### Task 4: Final verification and delivery

**Files:**
- Verify all changed files

- [x] **Step 1: Run full verification**

Run: `npm test && npm run build && git diff --check`

Expected: all Vitest files pass, the Electron build exits successfully, and no whitespace errors are reported.

- [x] **Step 2: Audit the final diff**

Confirm no company domains, local user paths, credentials, remote Star History image URLs, or unrelated changes were introduced.

- [x] **Step 3: Commit the implementation**

Run: `git add README.md docs/README.en.md src/core src/renderer docs/superpowers && git commit -m "feat: add session time range filter"`

Expected: a single implementation commit after the design commit.
