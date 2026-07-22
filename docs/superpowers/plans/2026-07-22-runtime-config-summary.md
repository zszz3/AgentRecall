# Runtime Configuration Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Runtime page's always-visible Provider wall with a compact current-configuration summary, searchable Provider picker, and collapsed low-frequency sections.

**Architecture:** Keep Runtime state and existing callbacks in `RuntimePage`, extract only the controlled Provider picker because it owns a modal interaction boundary, and layer page-specific styles in the existing AgentRecall override stylesheet. No shared runtime types, persistence, or backend services change.

**Tech Stack:** React 19, TypeScript, Lucide React, Vitest, React server rendering tests, Electron/Vite CSS.

---

## File map

- Create `src/automation/engine/renderer/src/pages/runtime/RuntimeProviderPicker.tsx`: searchable, categorized Provider modal.
- Create `src/automation/engine/renderer/src/pages/runtime/RuntimeProviderPicker.test.ts`: server-rendered picker filtering and empty-state coverage.
- Modify `src/automation/engine/renderer/src/pages/runtime/RuntimePage.tsx`: current-config summary, compact actions, connection fields, collapsed models/plugins/advanced sections, picker integration.
- Modify `src/automation/engine/renderer/src/pages/runtime/RuntimePage.test.ts`: observable default-page structure and Provider-wall regression coverage.
- Modify `src/renderer/src/styles/automation.css`: centered Runtime sheet, summary hierarchy, disclosure rows, modal and responsive behavior.
- Modify `src/renderer/src/automation-ui.test.ts`: style contract for bounded width and responsive summary layout.
- Modify `.release-notes/main-2-0.md`: describe the user-visible Runtime page simplification.

### Task 1: Searchable Provider picker

**Files:**
- Create: `src/automation/engine/renderer/src/pages/runtime/RuntimeProviderPicker.test.ts`
- Create: `src/automation/engine/renderer/src/pages/runtime/RuntimeProviderPicker.tsx`

- [ ] **Step 1: Write the failing picker rendering tests**

Cover a matching query and an empty query result through the controlled `query` prop:

```ts
const html = renderToStaticMarkup(createElement(RuntimeProviderPicker, {
  language: "zh",
  presets,
  selectedPresetId: "openai",
  query: "open",
  onQueryChange: vi.fn(),
  onSelect: vi.fn(),
  onClose: vi.fn(),
}));

expect(html).toContain('role="dialog"');
expect(html).toContain("OpenAI Official");
expect(html).not.toContain(">DeepSeek<");
```

Render again with `query: "not-a-provider"` and expect `没有匹配的 Provider`.

- [ ] **Step 2: Run the picker test and verify RED**

Run:

```bash
npx vitest run src/automation/engine/renderer/src/pages/runtime/RuntimeProviderPicker.test.ts
```

Expected: FAIL because `RuntimeProviderPicker` does not exist.

- [ ] **Step 3: Implement the controlled picker**

Create a component with this public contract:

```ts
interface RuntimeProviderPickerProps {
  language: Language;
  presets: AgentProviderPreset[];
  selectedPresetId?: string;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (preset: AgentProviderPreset) => void | Promise<void>;
  onClose: () => void;
}
```

Filter case-insensitively over `label`, `providerName`, `modelProvider`, and `id`. Render only non-empty categories in the existing category order. Use a presentation backdrop, `role="dialog"`, `aria-modal="true"`, a search field, selected-state buttons, a close button, backdrop dismissal, and an `onKeyDown` Escape handler.

- [ ] **Step 4: Run the picker test and verify GREEN**

Run the same focused Vitest command. Expected: the new test file passes.

- [ ] **Step 5: Commit the picker boundary**

```bash
git add src/automation/engine/renderer/src/pages/runtime/RuntimeProviderPicker.tsx src/automation/engine/renderer/src/pages/runtime/RuntimeProviderPicker.test.ts
git commit -m "feat: add searchable runtime provider picker"
```

### Task 2: Current configuration summary and progressive disclosure

**Files:**
- Modify: `src/automation/engine/renderer/src/pages/runtime/RuntimePage.test.ts`
- Modify: `src/automation/engine/renderer/src/pages/runtime/RuntimePage.tsx`

- [ ] **Step 1: Extend the Runtime page test for the desired default view**

Add observable assertions:

```ts
expect(markup).toContain('class="runtime-config-summary');
expect(markup).toContain("更换 Provider");
expect(markup).toContain("OpenAI");
expect(markup).not.toContain('aria-label="Provider presets"');
expect(markup).toContain('class="runtime-config-disclosure runtime-models-disclosure"');
expect(markup).toContain('class="runtime-config-disclosure runtime-plugins-disclosure"');
```

Keep existing assertions proving that the configuration selector contains only the selected Runtime's channels.

- [ ] **Step 2: Run the Runtime page test and verify RED**

```bash
npx vitest run src/automation/engine/renderer/src/pages/runtime/RuntimePage.test.ts
```

Expected: FAIL because the summary, change action, and disclosure classes do not exist and the Provider catalog still renders by default.

- [ ] **Step 3: Replace the flat page hierarchy**

In `RuntimePage`:

1. Add `providerPickerOpen` and `providerQuery` state.
2. Keep the six Runtime choices but remove the redundant `CLI` help copy from the visible layout.
3. Replace `runtime-editor-actions` plus the separate balance panel with `runtime-config-summary` containing:
   - Runtime badge, selected config `<select>`, add/delete controls.
   - Current Provider label and a `更换 Provider` action.
   - First balance item value/detail, or a short idle/error message, with one refresh icon action.
   - Import and test actions.
4. Keep API Key and configurable Model ID fields immediately below the summary as `runtime-connection-fields`.
5. Render `RuntimeProviderPicker` only while `providerPickerOpen` is true. On selection, await `applyRuntimePreset`, close, and clear the query.
6. Convert Codex plugins, models, and advanced Provider fields into `details.runtime-config-disclosure` sections without the `open` attribute. Put counts in each summary.
7. Keep the existing no-config empty state unchanged.

Use the existing test-result data and content, but place it directly after the summary. Do not change callbacks or persistence behavior.

- [ ] **Step 4: Run focused Runtime tests and typecheck**

```bash
npx vitest run src/automation/engine/renderer/src/pages/runtime/RuntimePage.test.ts src/automation/engine/renderer/src/pages/runtime/RuntimeProviderPicker.test.ts
npm run typecheck
```

Expected: both test files and TypeScript compilation pass.

- [ ] **Step 5: Commit the Runtime hierarchy**

```bash
git add src/automation/engine/renderer/src/pages/runtime/RuntimePage.tsx src/automation/engine/renderer/src/pages/runtime/RuntimePage.test.ts
git commit -m "feat: simplify runtime configuration hierarchy"
```

### Task 3: Intentional compact visual system

**Files:**
- Modify: `src/renderer/src/automation-ui.test.ts`
- Modify: `src/renderer/src/styles/automation.css`

- [ ] **Step 1: Add failing style-contract assertions**

Read `automation.css` as the existing test does and assert:

```ts
const sheetRule = automationStyleSource.match(/\.automation-runtime-content \.runtime-editor\s*\{([^}]*)\}/)?.[1];
const summaryRule = automationStyleSource.match(/\.automation-runtime-content \.runtime-config-summary\s*\{([^}]*)\}/)?.[1];

expect(sheetRule).toContain("max-width: 1040px");
expect(sheetRule).toContain("margin: 0 auto");
expect(summaryRule).toContain("grid-template-columns");
```

- [ ] **Step 2: Run the style test and verify RED**

```bash
npx vitest run src/renderer/src/automation-ui.test.ts
```

Expected: FAIL because the bounded sheet and summary-grid declarations are absent.

- [ ] **Step 3: Add Runtime-specific styling in `automation.css`**

Implement these visual rules without changing upstream shared CSS:

- Center `.runtime-editor` with `width: 100%`, `max-width: 1040px`, and `margin: 0 auto`.
- Make the Runtime selector a quiet horizontal rail with compact choices and horizontal overflow below 760px.
- Style `.runtime-config-summary` as one restrained surface with a 3px Runtime-colored identity edge, an identity block, a compact status/balance block, and wrapping actions.
- Style connection fields as a two-column row that collapses to one column.
- Style disclosure summaries as 42px list rows separated by hairlines; expanded content receives compact internal padding rather than another nested card.
- Add a centered Provider modal no wider than 760px, a sticky search/header region, categorized options, clear focus rings, and an empty state.
- Use only existing theme variables and `agent-*` accent classes.
- Add responsive rules at 760px and reduced-motion handling.

- [ ] **Step 4: Run style and Runtime tests**

```bash
npx vitest run src/renderer/src/automation-ui.test.ts src/automation/engine/renderer/src/pages/runtime/RuntimePage.test.ts src/automation/engine/renderer/src/pages/runtime/RuntimeProviderPicker.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit the visual treatment**

```bash
git add src/renderer/src/styles/automation.css src/renderer/src/automation-ui.test.ts
git commit -m "style: compact the runtime configuration workspace"
```

### Task 4: Release copy and end-to-end verification

**Files:**
- Modify: `.release-notes/main-2-0.md`

- [ ] **Step 1: Update the existing Runtime bug-fix bullet**

Replace the current Runtime selector bullet with user-facing copy:

```md
- 重整 Runtime 配置页：当前执行器、配置、Provider、余额和测试状态集中显示；低频 Provider 列表改为可搜索弹窗，模型、插件与高级配置默认折叠，减少首屏拥挤和横向空白。
```

- [ ] **Step 2: Stop the development Electron process before automated verification**

Stop only the development session started for this checkout. Do not touch installed AgentRecall instances or user data.

- [ ] **Step 3: Run complete verification**

```bash
npm test
npm run build
npm run release-note:check
git diff --check
```

Expected: all discovered Vitest files, script tests, build, release-note validation, and whitespace validation pass.

- [ ] **Step 4: Restart this checkout and visually review the real Electron page**

Run `npm run dev`, open Runtime, and verify at normal and narrow widths:

- Provider wall is absent on first render.
- Current config, Provider, balance, and actions read as one summary.
- Provider picker search and close interactions work.
- Models, plugins, and advanced settings start collapsed and expand without overflow.
- Runtime switching preserves all existing actions.

- [ ] **Step 5: Commit release copy and any verified visual corrections**

```bash
git add .release-notes/main-2-0.md src/automation/engine/renderer/src/pages/runtime src/renderer/src/styles/automation.css src/renderer/src/automation-ui.test.ts
git commit -m "fix: polish runtime configuration workspace"
```

Do not push unless the user asks after reviewing the running application.
