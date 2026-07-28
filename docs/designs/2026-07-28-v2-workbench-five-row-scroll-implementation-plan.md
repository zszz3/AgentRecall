# V2 Workbench Five-Row Session Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep 30 recent sessions loaded in the V2 Workbench while showing five rows at once and scrolling the remainder inside the card.

**Architecture:** Preserve the existing 30-session data limit and change only the Workbench list viewport. The existing 50px session-row height makes a 250px maximum list height equal to five visible rows.

**Tech Stack:** React, CSS, Vitest, Electron Vite

---

### Task 1: Set the Workbench session viewport to five rows

**Files:**
- Modify: `apps/main-2.0/src/renderer/src/features/workbench/workbench-page.test.ts`
- Modify: `apps/main-2.0/src/renderer/src/styles/workbench.css`
- Create: `.release-notes/v2-workbench-five-row-scroll.md`

- [ ] **Step 1: Change the style regression test to require five rows**

Replace the `160px` expectation with `250px`:

```ts
it("keeps the thirty-session preview inside a scrollable five-row card", () => {
  expect(workbenchStyles).toMatch(
    /\.workbench-session-list\s*\{[^}]*max-height:\s*250px;[^}]*overflow-y:\s*auto;/s,
  );
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd apps/main-2.0
npx vitest run src/renderer/src/features/workbench/workbench-page.test.ts
```

Expected: one failure because `.workbench-session-list` still uses `max-height: 160px`.

- [ ] **Step 3: Implement the five-row viewport**

Update the existing Workbench list rule:

```css
.workbench-session-list {
  min-height: 0;
  max-height: 250px;
  flex: 0 0 auto;
  margin-top: 7px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
}
```

- [ ] **Step 4: Add the V2 release note**

Create `.release-notes/v2-workbench-five-row-scroll.md`:

```markdown
# 调整工作台会话列表高度

<!-- release-target: v2 -->

## Bug 修复

- 工作台会话卡片现在默认展示 5 行，并可在卡片内滚动查看最近 30 个会话。
```

- [ ] **Step 5: Run focused and repository checks**

Run:

```bash
cd apps/main-2.0
npx vitest run src/renderer/src/features/workbench/workbench-page.test.ts
npm run build
cd ../..
npm run release-note:check
git diff --check
```

Expected: all commands pass.

- [ ] **Step 6: Commit the implementation**

```bash
git add apps/main-2.0/src/renderer/src/features/workbench/workbench-page.test.ts \
  apps/main-2.0/src/renderer/src/styles/workbench.css \
  .release-notes/v2-workbench-five-row-scroll.md
git commit -m "fix: show five V2 workbench session rows"
```

### Task 2: Install and verify the local V2 package

**Files:**
- Verify: `apps/main-2.0/out/`

- [ ] **Step 1: Package into a temporary directory**

Run from `apps/main-2.0`:

```bash
package_dir=$(mktemp -d)
npm pack --pack-destination "$package_dir"
```

Expected: `$package_dir/agent-recall-v2-0.1.0.tgz` exists.

- [ ] **Step 2: Install the built package globally**

```bash
npm install -g "$package_dir/agent-recall-v2-0.1.0.tgz"
trash "$package_dir"
```

Expected: npm reports a successful package replacement.

- [ ] **Step 3: Launch without replacing the local build with an older Release**

```bash
AGENT_RECALL_NO_UPDATE_CHECK=1 AGENT_RECALL_SOURCE_BUILD=1 \
  agent-recall-v2 --no-update-check
```

Expected: the Electron main process, PostgreSQL child process, and Renderer process remain running.
