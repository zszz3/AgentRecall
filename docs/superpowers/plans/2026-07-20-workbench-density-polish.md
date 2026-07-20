# Workbench Density Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclaim the persistent index-status space, narrow the navigation rail, add workbench session search, show ten sessions in a scrollable standalone card, align usage metrics, and reuse the README brand mark.

**Architecture:** Keep indexing and search behavior in the existing `App` owner. Change only the application-shell and workbench presentation: expose one compact navigation refresh action, use a transient toast for refresh feedback, and keep the existing smart query ordering without a visible sort switcher.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Electron Vite

---

### Task 1: Lock the shell behavior with source-contract tests

**Files:**
- Modify: `src/renderer/src/workbench-ui.test.ts`
- Modify: `src/renderer/src/style-contract.test.ts`
- Modify: `src/renderer/src/session-filter-contract.test.ts`

- [x] **Step 1: Write failing tests**

Add assertions that the application has no `.app-topbar` render, does not render `.sort-filter`, keeps `sortBy` fixed to `smart`, renders a compact navigation index-refresh button, and references `assets/logo.png` for the brand mark. Add CSS assertions that the removed topbar has no rule and the refresh button is compact.

- [x] **Step 2: Verify the tests fail for the missing behavior**

Run: `npx vitest run src/renderer/src/workbench-ui.test.ts src/renderer/src/style-contract.test.ts`

Expected: FAIL because the persistent header and sort switcher still render and the new compact shell styles do not exist.

### Task 2: Lock the density and alignment behavior with CSS contracts

**Files:**
- Modify: `src/renderer/src/workbench-ui.test.ts`

- [x] **Step 1: Write failing assertions**

Assert that `.workbench-session-row` uses a 46px minimum height with 4px vertical padding, `.workbench-resume` uses a 26px height, and `.workbench-metrics` uses four equal columns. Assert that metric values and labels share stable line heights and tabular-number alignment.

- [x] **Step 2: Verify the tests fail for the current spacious layout**

Run: `npx vitest run src/renderer/src/workbench-ui.test.ts`

Expected: FAIL against the current 56px rows, 7px padding, 28px Resume button, and unnormalized metric baselines.

### Task 3: Implement the approved shell and density changes

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles/app-shell.css`
- Modify: `src/renderer/src/styles/sessions.css`
- Modify: `src/renderer/src/styles/workbench.css`

- [x] **Step 1: Replace the persistent header**

Remove the `.app-topbar` markup. Add an icon-only index refresh action above Settings in the navigation, preserve spinning/error states and accessible text, and route manual refresh feedback through the existing transient toast.

Set the navigation rail and its matching title-bar divider geometry to 84px so labels remain readable without spending 104px of horizontal space.

- [x] **Step 2: Reuse the README brand mark**

Reference `assets/logo.png` from `App.tsx` and crop its existing purple circular mark inside the compact navigation brand container without creating a second logo design.

- [x] **Step 3: Remove the visible sort switcher**

Replace the mutable session sort state with the fixed `smart` value, remove sort button markup and obsolete `.sort-filter` CSS, and keep workbench navigation scopes limited to live-status changes.

- [x] **Step 4: Tighten workbench session rows and align metrics**

Apply the tested row, section, trajectory, time, and Resume dimensions. Normalize metric value and label line boxes with `font-variant-numeric: tabular-nums` and four equal grid tracks.

- [x] **Step 5: Build the standalone searchable session card**

Load at most ten workbench sessions, order live sessions before recent sessions, and render them as one independently scrollable list. Reuse `SearchBox` so typing remains local and only Enter commits a query; carry that query into the full Sessions page when “View all” is selected.

- [x] **Step 6: Verify targeted tests pass**

Run: `npx vitest run src/renderer/src/workbench-ui.test.ts src/renderer/src/session-ui.test.ts src/renderer/src/search-history.test.ts src/renderer/src/style-contract.test.ts src/renderer/src/session-filter-contract.test.ts src/renderer/src/app-update-ui.test.ts`

Expected: PASS with no warnings.

### Task 4: Verify packaging-facing quality gates

**Files:**
- Verify: `.release-notes/main-2-0.md`

- [x] **Step 1: Run type and production build checks**

Run: `npm run build`

Expected: TypeScript, MCP bundle, main, preload, and renderer builds complete successfully.

- [x] **Step 2: Run the branch release-note check**

Run: `npm run release-note:check`

Expected: The single `main-2-0` release note passes validation.

- [x] **Step 3: Inspect the already-running development app**

Confirm hot reload removes the status row and sort switcher, keeps the refresh action usable, shows the README brand mark, aligns all four metrics, and presents denser session rows in both themes. Do not start another Electron process.
