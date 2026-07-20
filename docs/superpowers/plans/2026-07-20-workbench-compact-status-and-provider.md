# Workbench Compact Status and Provider Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a readable three-zone workbench overview, show explicit Open / Closed session state, and promote Provider configuration into the main navigation.

**Architecture:** Keep all usage, quota, live-session, and provider data flows unchanged. Present permanent usage details on the left, combine both providers behind one refresh action in the middle, reserve an independent module slot on the right, then keep Provider configuration in the main navigation.

**Tech Stack:** React 18, TypeScript, Electron renderer, CSS modules-by-import, Vitest source-contract tests.

---

### Task 1: Specify the compact status rail and session state

**Files:**
- Modify: `src/renderer/src/workbench-ui.test.ts`
- Test: `src/renderer/src/workbench-ui.test.ts`

- [x] **Step 1: Write the failing workbench structure tests**

Add expectations that require the compact overview, accessible detail hints, and visible session state:

```ts
it("compresses usage and quota into one status rail without permanent detail rows", () => {
  const overview = stylesheet.match(/\.workbench-overview\s*\{[^}]*\}/)?.[0] ?? "";
  expect(overview).toMatch(/min-height:\s*72px/);
  expect(workbenchSource).not.toContain("<TokenComposition");
  expect(workbenchSource).not.toContain('className="workbench-source-usage"');
  expect(workbenchSource).toContain('className="workbench-detail-hint"');
  expect(workbenchSource).toContain("tabIndex={0}");
});

it("shows explicit Open and Closed state in every workbench session row", () => {
  expect(workbenchSource).toContain("localizedLiveStateLabel(liveState, language)");
  expect(workbenchSource).toContain("workbench-session-state ${liveState}");
});
```

- [x] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run src/renderer/src/workbench-ui.test.ts
```

Expected: FAIL because the overview still renders permanent Token/source detail rows and the session row has no explicit state label.

- [x] **Step 3: Commit the failing test**

```bash
git add src/renderer/src/workbench-ui.test.ts
git commit -m "test: define compact workbench status rail"
```

### Task 2: Implement the status rail and Open / Closed label

**Files:**
- Modify: `src/renderer/src/features/workbench/workbench-page.tsx`
- Modify: `src/renderer/src/styles/workbench.css`
- Test: `src/renderer/src/workbench-ui.test.ts`

- [x] **Step 1: Replace permanent details with focused hints**

Compute source and token-composition detail strings in `WorkbenchPage`, pass them to the existing metric component, and render a keyboard-focusable hint:

```tsx
function UsageMetric({ value, label, detail }: { value: string; label: string; detail?: string }): ReactElement {
  return (
    <div className={detail ? "workbench-metric workbench-has-detail" : "workbench-metric"} tabIndex={detail ? 0 : undefined} aria-label={detail ? `${label}: ${value}. ${detail}` : `${label}: ${value}`}>
      <strong>{value}</strong><span>{label}</span>
      {detail ? <span className="workbench-detail-hint" role="tooltip">{detail}</span> : null}
    </div>
  );
}
```

Remove the visible `<TokenComposition />` and `.workbench-source-usage` blocks. Put reset time and stale status in the same detail-hint treatment on each quota window.

- [x] **Step 2: Render explicit session state from the existing detector**

Use the already-computed live state and append it to the secondary row:

```tsx
const liveState = getLiveSessionState(session, liveSessionKeys, liveDetectionFailed);
const live = liveState === "open";
```

```tsx
<span className={`workbench-session-state ${liveState}`}>
  <i aria-hidden="true" />{localizedLiveStateLabel(liveState, language)}
</span>
```

- [x] **Step 3: Compress the wide layout to a 72px rail**

Update `workbench.css` so the wide layout uses one row and details appear only on hover/focus:

```css
.workbench-overview {
  min-height: 72px;
  grid-template-columns: minmax(490px, 1.35fr) repeat(2, minmax(190px, .72fr));
}

.workbench-usage {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  padding: 9px 12px;
}

.workbench-quota {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
}

.workbench-detail-hint {
  position: absolute;
  z-index: 12;
  pointer-events: none;
  opacity: 0;
}

.workbench-has-detail:hover .workbench-detail-hint,
.workbench-has-detail:focus-visible .workbench-detail-hint {
  opacity: 1;
}
```

At `max-width: 1100px`, place usage across both columns and quotas side by side so content stays legible without horizontal overflow.

- [x] **Step 4: Run the focused tests**

Run:

```bash
npx vitest run src/renderer/src/workbench-ui.test.ts src/renderer/src/session-ui.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit the workbench implementation**

```bash
git add src/renderer/src/features/workbench/workbench-page.tsx src/renderer/src/styles/workbench.css src/renderer/src/workbench-ui.test.ts
git commit -m "feat: compact workbench status overview"
```

### Task 3: Promote Provider configuration into the main navigation

**Files:**
- Move: `src/renderer/src/features/providers/api-config-dialog.tsx` to `src/renderer/src/features/providers/provider-page.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/styles/providers.css`
- Modify: `src/renderer/src/styles/settings.css`
- Modify: `src/renderer/src/workbench-ui.test.ts`
- Modify: `src/renderer/src/style-contract.test.ts`
- Modify: `src/renderer/src/theme.test.ts`

- [x] **Step 1: Write failing navigation and page-shell tests**

Require Provider in the page union and main navigation, require the page component, and reject the old overlay:

```ts
expect(appSource).toContain('type AppPage = "workbench" | "sessions" | "skills" | "providers"');
expect(appSource).toContain('data-page="providers"');
expect(appSource).toContain("<ProviderPage");
expect(appSource).not.toContain("apiConfigOpen");
expect(providerSource).toContain("export function ProviderPage");
expect(providerSource).toContain('className="provider-page"');
expect(providerSource).not.toContain('className="dialog-backdrop"');
```

Change the style contract from `.api-config-dialog` to `.provider-page`, requiring a full-height flex page, a scrollable `.api-config-body`, and a non-scrolling action footer.

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run src/renderer/src/workbench-ui.test.ts src/renderer/src/style-contract.test.ts src/renderer/src/theme.test.ts
```

Expected: FAIL because Provider is still an overlay dialog and is absent from `AppPage`.

- [x] **Step 3: Convert the existing component into a page**

Rename the component and replace only its outer shell:

```tsx
export function ProviderPage({
  settings,
  language,
  feedback,
  onSettingsChange,
  onApplyToCodex,
  onApplyToClaude,
}: {
  settings: AppSettings | null;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onApplyToCodex: (apiConfig: ApiConfig) => void;
  onApplyToClaude: (claudeApiConfig: ClaudeApiConfig) => void;
}): ReactElement {
  // Keep the existing draft, detection, save, and apply logic.
  return (
    <section className="provider-page" data-page="providers">
      <header className="provider-page-head">
        <h2>Provider</h2>
        <p>{l("Configure the routes used by Codex, Claude Code, summaries, and AI search.", "配置 Codex、Claude Code、摘要和 AI 搜索使用的服务。")}</p>
      </header>
      {/* existing api-target-tabs, api-config-body and api-config-actions */}
    </section>
  );
}
```

Remove the `onClose` prop, backdrop, dialog section, close button, and unused `X` icon. Keep all provider form behavior unchanged.

- [x] **Step 4: Route all existing entries to the Provider tab**

Extend `AppPage`, add a KeyRound navigation button, render `ProviderPage` in `.app-page-host`, delete `apiConfigOpen`, delete the duplicate session-toolbar API button, and change the settings callback to:

```tsx
onOpenApiConfig={() => {
  setSettingsOpen(false);
  setActivePage("providers");
}}
```

- [x] **Step 5: Give Provider an independent page stylesheet**

Import `styles/providers.css` after settings styles. Define the page shell there:

```css
.provider-page {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--app-bg);
}

.provider-page-head {
  padding: 18px 22px 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.provider-page .api-config-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 22px 20px;
  scrollbar-gutter: stable;
}
```

Move provider-only shell rules out of `settings.css`; retain shared field rules only where both settings and Provider use them.

- [x] **Step 6: Run focused renderer tests**

Run:

```bash
npx vitest run src/renderer/src/workbench-ui.test.ts src/renderer/src/style-contract.test.ts src/renderer/src/theme.test.ts src/renderer/src/app-update-ui.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit the Provider page**

```bash
git add src/renderer/src/App.tsx src/renderer/src/main.tsx src/renderer/src/features/providers src/renderer/src/styles/providers.css src/renderer/src/styles/settings.css src/renderer/src/workbench-ui.test.ts src/renderer/src/style-contract.test.ts src/renderer/src/theme.test.ts
git commit -m "feat: add Provider navigation page"
```

### Task 4: Release note and full verification

**Files:**
- Modify: `.release-notes/main-2-0.md`
- Modify: `docs/superpowers/plans/2026-07-20-workbench-compact-status-and-provider.md`

- [x] **Step 1: Update the single branch release note**

Add user-facing bullets under the existing `## 新增功能` section:

```md
- 工作台顶部现在以紧凑状态带展示用量与 Codex、Claude Code 额度，为会话列表留出更多空间。
- 工作台会话会明确显示 Open 或 Closed 状态，Provider 配置也可从左侧 Tab 直接进入。
```

- [x] **Step 2: Run complete verification**

Run:

```bash
npm test
npm run build
npm run release-note:check
git diff --check
```

Expected: all tests pass, renderer and Electron bundles build, exactly one valid release note is accepted, and no whitespace errors are reported.

- [x] **Step 3: Inspect the running UI**

Use the existing development process or start the app, verify the wide and medium window layouts, confirm tooltip focus behavior, Provider navigation, Open / Closed labels, and then stop any temporary UI process started only for testing.

- [ ] **Step 4: Commit verification documentation**

```bash
git add .release-notes/main-2-0.md docs/superpowers/plans/2026-07-20-workbench-compact-status-and-provider.md
git commit -m "docs: record workbench and Provider updates"
```

### Task 5: Revise the overview after visual review

**Files:**
- Modify: `src/renderer/src/features/workbench/workbench-page.tsx`
- Modify: `src/renderer/src/styles/workbench.css`
- Modify: `src/renderer/src/workbench-ui.test.ts`
- Modify: `.release-notes/main-2-0.md`

- [x] **Step 1: Replace the single-rail contract with the approved three-zone contract**

Require visible Token composition and source totals, one combined quota card with one refresh action, and an independent right-side module slot.

- [x] **Step 2: Run the focused test and verify it fails**

```bash
npx vitest run src/renderer/src/workbench-ui.test.ts
```

- [x] **Step 3: Implement the permanent detail layer and combined quota card**

Keep statistics on the left, render both providers side by side inside one card, show quota reset details without hover, and reserve the third grid column.

- [x] **Step 4: Run focused and full verification**

```bash
npx vitest run src/renderer/src/workbench-ui.test.ts src/renderer/src/session-ui.test.ts
npm run typecheck
npm run build
npm run release-note:check
git diff --check
```

- [x] **Step 5: Inspect the updated running UI**

Verify the wide three-column layout, the medium two-column fallback, the single quota refresh action, visible detail rows, and unchanged Open / Closed and Provider behavior.

### Task 6: Unify page headers and session actions

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/features/workbench/workbench-page.tsx`
- Modify: `src/renderer/src/features/skills/skills-page.tsx`
- Modify: `src/renderer/src/features/providers/provider-page.tsx`
- Modify: `src/renderer/src/styles/app-shell.css`
- Modify: `src/renderer/src/styles/workbench.css`
- Modify: `src/renderer/src/styles/skills-page.css`
- Modify: `src/renderer/src/styles/providers.css`

- [x] **Step 1: Add a failing shared-page-header contract**

- [x] **Step 2: Add consistent title and description bars to all four tabs**

- [x] **Step 3: Keep “工作台 / Workbench” as the workbench title and use `One for all` as its subtitle**

- [x] **Step 4: Remove the duplicate Settings action from the sessions toolbar while preserving the global update indicator**

- [x] **Step 5: Verify the workbench and sessions layouts in the running macOS app**
