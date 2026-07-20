# Workbench Period Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workbench's floating four-button usage-period control with the approved compact dropdown in the usage-card header.

**Architecture:** Keep the existing `SessionStatsPeriod` state and callback unchanged. Reshape only the owning workbench component and its scoped stylesheet, then protect the visual hierarchy and four available periods with the existing renderer source-contract test.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Electron Vite

---

## File map

- `src/renderer/src/features/workbench/workbench-page.tsx`: owns the usage-card markup and maps the four existing periods into the native dropdown.
- `src/renderer/src/styles/workbench.css`: owns the usage header, dropdown, metric spacing, focus, and narrow-window presentation.
- `src/renderer/src/workbench-ui.test.ts`: verifies the dropdown structure, options, callback wiring, and header-level placement.
- `.release-notes/main-2-0.md`: describes the corrected workbench layout in user-facing language.

### Task 1: Lock the approved hierarchy with a failing UI contract test

**Files:**
- Modify: `src/renderer/src/workbench-ui.test.ts`

- [ ] **Step 1: Add the failing contract test**

Add this test inside `describe("workbench application shell", ...)`:

```ts
it("places the usage period in a compact card-header dropdown", () => {
  const usageHead = stylesheet.match(/\.workbench-usage-head\s*\{[^}]*\}/)?.[0] ?? "";
  const periodSelect = stylesheet.match(/\.workbench-period-select\s*\{[^}]*\}/)?.[0] ?? "";
  expect(workbenchSource).toContain('className="workbench-usage-head"');
  expect(workbenchSource).toContain('className="workbench-period-select"');
  expect(workbenchSource).toContain("value={statsPeriod}");
  expect(workbenchSource).toContain("event.currentTarget.value as SessionStatsPeriod");
  expect(workbenchSource).toContain("<option key={period} value={period}>");
  expect(workbenchSource).not.toContain('className="workbench-periods"');
  expect(usageHead).toMatch(/justify-content:\s*space-between/);
  expect(periodSelect).toMatch(/height:\s*24px/);
});
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
npx vitest run src/renderer/src/workbench-ui.test.ts
```

Expected: FAIL because `workbench-usage-head` and `workbench-period-select` do not exist and the old `workbench-periods` group is still present.

### Task 2: Replace the segmented buttons with the compact dropdown

**Files:**
- Modify: `src/renderer/src/features/workbench/workbench-page.tsx`
- Modify: `src/renderer/src/styles/workbench.css`

- [ ] **Step 1: Replace the usage-card top row markup**

In `WorkbenchPage`, replace the existing `workbench-usage-top` block with the following header followed by the unchanged metrics block:

```tsx
<div className="workbench-usage-head">
  <strong>{l("Usage", "用量")}</strong>
  <div className="workbench-usage-actions">
    <select
      className="workbench-period-select"
      value={statsPeriod}
      onChange={(event) => onStatsPeriodChange(event.currentTarget.value as SessionStatsPeriod)}
      aria-label={l("Usage period", "用量周期")}
    >
      {PERIODS.map((period) => (
        <option key={period} value={period}>{statsPeriodLabel(period, language)}</option>
      ))}
    </select>
    <button
      className="workbench-icon-button"
      onClick={onRefreshStats}
      disabled={statsRefreshing}
      aria-label={l("Refresh usage", "刷新用量")}
    >
      <RefreshCw size={14} />
    </button>
  </div>
</div>
<div className="workbench-metrics">
  <UsageMetric value={formatCompactNumber(stats.total.sessionCount)} label={l("Sessions", "会话")} />
  <UsageMetric value={formatCompactNumber(stats.total.messageCount)} label={l("Messages", "消息")} />
  <UsageMetric value={formatTokenCount(stats.total.totalTokens)} label="Token" />
  <UsageMetric value={cacheRate == null ? "—" : `${cacheRate}%`} label={l("Cache rate", "缓存率")} />
</div>
```

Do not change `PERIODS`, `statsPeriod`, `onStatsPeriodChange`, or the data-fetching path.

- [ ] **Step 2: Replace the old period styles with scoped header and dropdown styles**

In `workbench.css`, remove `.workbench-usage-top` and the three `.workbench-periods` rules. Add:

```css
.workbench-usage-head {
  display: flex;
  min-width: 0;
  min-height: 24px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.workbench-usage-head > strong {
  color: var(--text);
  font-size: 11px;
  font-weight: 650;
}

.workbench-usage-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
}

.workbench-period-select {
  width: 76px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--panel-subtle);
  color: var(--text);
  font-size: 10.5px;
  font-weight: 640;
  cursor: pointer;
}

.workbench-period-select:hover {
  border-color: var(--border);
  background: var(--panel-hover);
}
```

Keep the existing shared `select:focus-visible` rule. Remove `flex: 1` from `.workbench-metrics`, set its `margin-top` to `5px`, and tighten `.workbench-usage-detail` to `margin-top: 7px` and `padding-top: 8px` so the card retains its current compact height.

- [ ] **Step 3: Run the focused test and typecheck**

Run:

```bash
npx vitest run src/renderer/src/workbench-ui.test.ts
npm run typecheck
```

Expected: all workbench UI tests pass and TypeScript reports no errors.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/renderer/src/workbench-ui.test.ts src/renderer/src/features/workbench/workbench-page.tsx src/renderer/src/styles/workbench.css
git commit -m "fix: place workbench period in usage header"
```

### Task 3: Release copy and full verification

**Files:**
- Modify: `.release-notes/main-2-0.md`

- [ ] **Step 1: Add the user-facing fix note**

Under `## Bug 修复`, add:

```markdown
- 调整工作台用量周期选择器的位置，以紧凑下拉框归入用量标题栏，避免统计数字被挤压。
```

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
npm test
npm run build
npm run release-note:check
git diff --check
```

Expected:

- Vitest and script tests all pass.
- TypeScript, MCP bundle, Electron main/preload, and renderer production builds succeed.
- The single `main-2.0` release note passes validation.
- `git diff --check` prints no errors.

- [ ] **Step 3: Verify the running development app**

Use the existing `npm run dev` process or start it if absent. On the workbench, confirm:

- The usage card shows “用量” at upper left.
- The upper-right dropdown shows the active period and contains all four values.
- Selecting each value updates the four metrics.
- The refresh button remains beside the dropdown and retains its loading state.
- The overview stays aligned at wide and narrow window widths without horizontal overflow.

- [ ] **Step 4: Commit the release note**

```bash
git add .release-notes/main-2-0.md
git commit -m "docs: update main 2.0 release notes"
```
