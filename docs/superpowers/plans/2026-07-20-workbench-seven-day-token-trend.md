# Workbench Seven-Day Token Trend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty Workbench overview slot with an accessible seven-day Token line chart and let users drill into sessions active on a selected day.

**Architecture:** Extend the existing `SessionStats` response with seven zero-filled local-calendar-day Token buckets produced by `SessionsStore`, preserving the current cross-source dedupe rule. Render those buckets in a focused Workbench chart component and keep the selected chart day as renderer state that overrides the Sessions page’s preset date range.

**Tech Stack:** TypeScript, React 19, inline SVG, CSS, Node SQLite, Vitest, Electron IPC through the existing `stats:get` contract.

---

## File map

- Modify `src/core/types.ts`: define the daily Token bucket and expose it on `SessionStats`.
- Modify `src/core/store/sessions.ts`: calculate seven local day boundaries and aggregate deduplicated Token events into them.
- Modify `src/core/session-store.test.ts`: verify zero filling, natural-day boundaries, mirror dedupe, future-event exclusion, and Subagent filtering.
- Create `src/renderer/src/features/workbench/token-trend-chart.tsx`: own SVG geometry, point focus/hover state, tooltip, empty state, labels, and day activation.
- Modify `src/renderer/src/features/workbench/workbench-page.tsx`: render the trend card and forward day selection.
- Modify `src/renderer/src/App.tsx`: initialize trend data, apply and clear an exact-day Sessions filter, and reset stale global filters during drilldown.
- Modify `src/renderer/src/styles/workbench.css`: style the trend card and change the three-column proportions and responsive behavior.
- Modify `src/renderer/src/styles/sessions.css`: style the temporary exact-day filter without breaking the toolbar.
- Modify `src/renderer/src/workbench-ui.test.ts`: assert the chart structure, one-refresh behavior, proportions, and responsive presence.
- Modify `src/renderer/src/session-filter-contract.test.ts`: assert exact-day drilldown and replacement by preset ranges.
- Modify `.release-notes/main-2-0.md`: describe the user-visible trend and drilldown in the branch’s existing single release note.

### Task 1: Add daily Token statistics

**Files:**
- Modify: `src/core/session-store.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/store/sessions.ts`

- [ ] **Step 1: Write the failing store test**

Add a test that creates local-calendar timestamps with `setDate`, inserts a normal event, a larger mirrored event with the same dedupe key, an older event, a Subagent event, and a future event. Assert that `dailyTokenUsage` contains seven consecutive local day buckets, zero-fills missing days, counts the mirrored key once, excludes the Subagent when requested, and excludes the future event:

```ts
it("reports seven local days of deduplicated token usage", () => {
  const store = createInMemoryStore();
  const nowDate = new Date(2026, 6, 20, 12, 0, 0, 0);
  const now = nowDate.getTime();
  const atLocalDay = (offset: number, hour: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    date.setHours(hour, 0, 0, 0);
    return date.getTime();
  };

  store.upsertIndexedSession(
    sampleSession({ sessionKey: "codex:trend", rawId: "trend", source: "codex-cli" }),
    messages,
    [{ dedupeKey: "turn:today", timestamp: atLocalDay(0, 9), inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 160 }],
  );
  store.upsertIndexedSession(
    sampleSession({ sessionKey: "codex:mirror", rawId: "mirror", source: "codex-app" }),
    messages,
    [{ dedupeKey: "turn:today", timestamp: atLocalDay(0, 10), inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 160 }],
  );
  store.upsertIndexedSession(
    sampleSession({ sessionKey: "claude:older", rawId: "older", source: "claude-cli" }),
    messages,
    [{ dedupeKey: "turn:older", timestamp: atLocalDay(-3, 14), inputTokens: 40, cachedInputTokens: 5, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 50 }],
  );
  store.upsertIndexedSession(
    sampleSession({ sessionKey: "codex:subagent", rawId: "subagent", source: "codex-cli", isSubagent: true }),
    messages,
    [{ dedupeKey: "turn:subagent", timestamp: atLocalDay(-1, 14), inputTokens: 90, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 100 }],
  );
  store.upsertIndexedSession(
    sampleSession({ sessionKey: "codex:future", rawId: "future", source: "codex-cli" }),
    messages,
    [{ dedupeKey: "turn:future", timestamp: atLocalDay(0, 18), inputTokens: 90, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 100 }],
  );

  const trend = store.getStats({ period: "today", excludeSubagents: true }, now).dailyTokenUsage;

  expect(trend).toHaveLength(7);
  expect(trend.map((day) => day.totalTokens)).toEqual([0, 0, 0, 50, 0, 0, 160]);
  expect(trend[6]).toMatchObject({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10 });
  for (let index = 1; index < trend.length; index += 1) {
    expect(trend[index - 1].dayEndExclusive).toBe(trend[index].dayStart);
  }
  expect(trend[6].dayStart).toBe(new Date(2026, 6, 20).getTime());
});
```

- [ ] **Step 2: Run the store test and verify RED**

Run: `npx vitest run src/core/session-store.test.ts`

Expected: FAIL because `SessionStats.dailyTokenUsage` does not exist.

- [ ] **Step 3: Add the response type and aggregation**

Add to `src/core/types.ts`:

```ts
export interface SessionDailyTokenUsage extends TokenUsage {
  dayStart: number;
  dayEndExclusive: number;
}

export interface SessionStats {
  total: SessionStatsSummary;
  bySource: SessionSourceStats[];
  dailyTokenUsage: SessionDailyTokenUsage[];
  range: {
    period: SessionStatsPeriod;
    since: number | null;
    until: number;
  };
}
```

In `src/core/store/sessions.ts`, import `SessionDailyTokenUsage`, compute seven boundaries with calendar arithmetic, call one grouped query, and return the result from `getStats`:

```ts
const dailyTokenUsage = this.aggregateDailyTokenUsage(resolveDailyTokenRanges(now), options.excludeSubagents ?? false, now);
return { total, bySource, dailyTokenUsage, range };
```

```ts
private aggregateDailyTokenUsage(
  days: Array<Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive">>,
  excludeSubagents: boolean,
  now: number,
): SessionDailyTokenUsage[] {
  const bucketCase = days.map((_, index) => `WHEN timestamp >= ? AND timestamp < ? THEN ${index}`).join("\n");
  const rows = this.db.prepare(`
    WITH ranked AS (
      SELECT token_events.*, sessions.source,
        ROW_NUMBER() OVER (
          PARTITION BY token_events.dedupe_key
          ORDER BY token_events.total_tokens DESC,
            CASE sessions.source
              WHEN 'codex-cli' THEN 1 WHEN 'claude-cli' THEN 1
              WHEN 'codex-app' THEN 2 WHEN 'claude-app' THEN 2 ELSE 9
            END,
            token_events.timestamp ASC
        ) AS row_rank
      FROM token_events
      JOIN sessions ON sessions.session_key = token_events.session_key
      WHERE token_events.timestamp >= ? AND token_events.timestamp <= ?
        ${excludeSubagents ? "AND sessions.is_subagent = 0" : ""}
    ), bucketed AS (
      SELECT CASE ${bucketCase} END AS day_index, *
      FROM ranked
      WHERE row_rank = 1
    )
    SELECT day_index,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM bucketed
    WHERE day_index IS NOT NULL
    GROUP BY day_index
  `).all(days[0].dayStart, now, ...days.flatMap((day) => [day.dayStart, day.dayEndExclusive])) as DailyTokenRow[];
  const byDay = new Map(rows.map((row) => [row.day_index, row]));
  return days.map((day, index) => {
    const row = byDay.get(index);
    return {
      ...day,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      cachedInputTokens: row?.cached_input_tokens ?? 0,
      reasoningOutputTokens: row?.reasoning_output_tokens ?? 0,
      totalTokens: row?.total_tokens ?? 0,
    };
  });
}
```

Use this row shape beside the existing store-private row interfaces:

```ts
interface DailyTokenRow {
  day_index: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}
```

```ts
function resolveDailyTokenRanges(now: number): Array<Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive">> {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, index) => {
    const start = new Date(today);
    start.setDate(start.getDate() - (6 - index));
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { dayStart: start.getTime(), dayEndExclusive: end.getTime() };
  });
}
```

- [ ] **Step 4: Update exact `SessionStats` fixtures and verify GREEN**

Add `dailyTokenUsage: []` to `EMPTY_STATS`. In the two pre-existing assertions that compare the complete `SessionStats` object, change the outer matcher from `toEqual({...})` to `toMatchObject({...})`; their existing totals, source rows, and ranges remain asserted while the dedicated trend test owns the new array. Run: `npx vitest run src/core/session-store.test.ts`

Expected: PASS with no failed tests.

- [ ] **Step 5: Commit the data layer**

```bash
git add src/core/types.ts src/core/store/sessions.ts src/core/session-store.test.ts src/renderer/src/App.tsx
git commit -m "feat: add daily token trend statistics"
```

### Task 2: Render the accessible Token trend card

**Files:**
- Create: `src/renderer/src/features/workbench/token-trend-chart.tsx`
- Modify: `src/renderer/src/features/workbench/workbench-page.tsx`
- Modify: `src/renderer/src/styles/workbench.css`
- Modify: `src/renderer/src/workbench-ui.test.ts`

- [ ] **Step 1: Write the failing UI contract test**

Read the new chart source in `workbench-ui.test.ts` and assert the observable structure:

```ts
const tokenTrendSource = readFileSync(new URL("./features/workbench/token-trend-chart.tsx", import.meta.url), "utf8");

it("replaces the reserved slot with an accessible seven-day Token trend", () => {
  const overview = stylesheet.match(/\.workbench-overview\s*\{[^}]*\}/)?.[0] ?? "";
  expect(workbenchSource).toContain("<TokenTrendChart");
  expect(workbenchSource).toContain("points={stats.dailyTokenUsage}");
  expect(workbenchSource).not.toContain('className="workbench-overview-slot"');
  expect(tokenTrendSource).toContain('className="workbench-token-trend"');
  expect(tokenTrendSource).toContain("<svg");
  expect(tokenTrendSource).toContain('<button');
  expect(tokenTrendSource).toContain('role="tooltip"');
  expect(overview).toMatch(/grid-template-columns:[^;]*1\.24fr[^;]*1\.04fr[^;]*\.78fr/);
});
```

- [ ] **Step 2: Run the UI contract test and verify RED**

Run: `npx vitest run src/renderer/src/workbench-ui.test.ts`

Expected: FAIL because the chart file and markup do not exist.

- [ ] **Step 3: Create the chart component and replace the slot**

Create `TokenTrendChart` with props:

```ts
interface TokenTrendChartProps {
  points: SessionDailyTokenUsage[];
  language: LanguageMode;
  onSelectDay: (day: SessionDailyTokenUsage) => void;
}
```

Use a fixed `viewBox="0 0 280 72"`, calculate seven evenly spaced coordinates from the maximum daily total, draw one `path` for the area and one for the line, and overlay seven real `<button>` elements for pointer and keyboard access. Each button must set the active tooltip on hover/focus, call `onSelectDay` on click, and handle Enter/Space through its native button behavior. Render the seven-day sum, average, today total, short day labels, an all-zero message, and a tooltip with all five Token values using `formatTokenCount`.

Replace the old `<aside className="workbench-overview-slot">` in `WorkbenchPage` with:

```tsx
<TokenTrendChart
  points={stats.dailyTokenUsage}
  language={language}
  onSelectDay={onSelectTrendDay}
/>
```

Add `onSelectTrendDay: (day: SessionDailyTokenUsage) => void` to `WorkbenchPageProps`, and remove the unused `Plus` import.

- [ ] **Step 4: Style the card and responsive layout**

Change the wide grid to:

```css
.workbench-overview {
  grid-template-columns: minmax(390px, 1.24fr) minmax(330px, 1.04fr) minmax(230px, .78fr);
}
```

Style `.workbench-token-trend` as the same-height third card, its SVG container as a positioned responsive region, point buttons with an accent focus ring, an internal tooltip, seven equal day labels, and a compact footer. At `max-width: 1180px`, use two columns and make `.workbench-token-trend` span both columns; at `max-width: 880px`, use one column and reset its span. Do not hide the trend at any breakpoint.

- [ ] **Step 5: Run the UI test and verify GREEN**

Run: `npx vitest run src/renderer/src/workbench-ui.test.ts`

Expected: PASS with no failed tests.

- [ ] **Step 6: Commit the chart**

```bash
git add src/renderer/src/features/workbench/token-trend-chart.tsx src/renderer/src/features/workbench/workbench-page.tsx src/renderer/src/styles/workbench.css src/renderer/src/workbench-ui.test.ts
git commit -m "feat: show weekly token trend on workbench"
```

### Task 3: Add exact-day Sessions drilldown

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles/sessions.css`
- Modify: `src/renderer/src/session-filter-contract.test.ts`

- [ ] **Step 1: Write the failing drilldown contract test**

Add assertions for exact-day state, the exclusive-to-inclusive conversion, filter reset, visible chip, and preset replacement:

```ts
it("drills a trend day into Sessions and lets presets replace it", () => {
  expect(appSource).toContain("const [customDateRange, setCustomDateRange]");
  expect(appSource).toContain("dateTo: customDateRange.dayEndExclusive - 1");
  expect(appSource).toContain("onSelectTrendDay={(day) => {");
  expect(appSource).toContain('setActivePage("sessions")');
  expect(appSource).toContain('className="date-filter-custom active"');
  expect(appSource).toContain("setCustomDateRange(null);");
  expect(appSource).toContain('setSource("all")');
  expect(appSource).toContain('setLiveStatus("all")');
});
```

- [ ] **Step 2: Run the filter test and verify RED**

Run: `npx vitest run src/renderer/src/session-filter-contract.test.ts`

Expected: FAIL because custom date state and drilldown do not exist.

- [ ] **Step 3: Implement exact-day state and navigation**

Add renderer state:

```ts
const [customDateRange, setCustomDateRange] = useState<Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive"> | null>(null);
```

Resolve search dates with the override:

```ts
const { dateFrom, dateTo } = customDateRange
  ? { dateFrom: customDateRange.dayStart, dateTo: customDateRange.dayEndExclusive - 1 }
  : resolveDateRange(dateRange);
```

Include both custom boundaries in the search scope key and `load` dependencies. Pass this callback to `WorkbenchPage`:

```tsx
onSelectTrendDay={(day) => {
  setQuery("");
  setSource("all");
  selectEnvironment("all");
  clearProjectFilter();
  setTag(undefined);
  setVisibility("default");
  setLiveStatus("all");
  setDateRange("all");
  setCustomDateRange({ dayStart: day.dayStart, dayEndExclusive: day.dayEndExclusive });
  setActivePage("sessions");
}}
```

Render an active custom-day button before the preset buttons. Its click clears the custom range. Preset buttons use `className={!customDateRange && dateRange === option.value ? "active" : ""}` and clear the custom range before setting the preset.

- [ ] **Step 4: Style and verify the exact-day filter**

Give `.date-filter-custom` enough width for a locale-formatted month/day plus its × marker, raise `--date-filter-width` only enough to accommodate the extra temporary item, and preserve the existing 38px toolbar height. Run:

`npx vitest run src/renderer/src/session-filter-contract.test.ts src/renderer/src/style-contract.test.ts`

Expected: PASS with no failed tests.

- [ ] **Step 5: Commit the drilldown**

```bash
git add src/renderer/src/App.tsx src/renderer/src/styles/sessions.css src/renderer/src/session-filter-contract.test.ts src/renderer/src/style-contract.test.ts
git commit -m "feat: drill token trend into daily sessions"
```

### Task 4: Release copy and full verification

**Files:**
- Modify: `.release-notes/main-2-0.md`

- [ ] **Step 1: Update the existing branch release note**

Add one product-facing bullet under `## 新增功能`:

```md
- 工作台新增近 7 天 Token 折线，可查看每天的输入、缓存、输出和推理用量，并从任意日期直接筛选当天活跃的会话。
```

Do not create a second release-note file.

- [ ] **Step 2: Run focused verification**

Run:

```bash
npx vitest run src/core/session-store.test.ts src/renderer/src/workbench-ui.test.ts src/renderer/src/session-filter-contract.test.ts src/renderer/src/style-contract.test.ts
```

Expected: all selected test files pass with zero failures.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm test
npm run build
npm run release-note:check
git diff --check
```

Expected: every command exits 0, all tests pass, the Electron/Vite build succeeds, the single branch release note passes validation, and the diff has no whitespace errors.

- [ ] **Step 4: Review product and privacy boundaries**

Inspect the final diff and run a case-insensitive scan for company names, internal hosts, credentials, `/Users/` paths, and generated `.superpowers` files. Confirm only synthetic test fixtures are present and no real session, Skill, Electron, or remote-sync data was read or modified.

- [ ] **Step 5: Commit, push, and report**

```bash
git add .release-notes/main-2-0.md
git commit -m "docs: announce workbench token trend"
git push origin main-2.0
```

Report the pushed commit range, test/build evidence, and the user-visible behavior. Do not include `.superpowers/` in any commit.
