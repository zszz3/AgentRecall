# Search Startup Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the main session search input and recent-search dropdown from taking focus when the application starts.

**Architecture:** Keep the current `SearchBox` focus state and explicit focus entry points intact. Remove only the declarative startup focus attribute, protected by a source-contract regression test scoped to the main `SearchBox` component.

**Tech Stack:** React, TypeScript, Vitest, Electron Vite

---

### Task 1: Stop automatic search focus

**Files:**
- Modify: `src/renderer/src/app-loading.test.ts`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Write the failing regression test**

Add this test to `src/renderer/src/app-loading.test.ts`:

```ts
it("does not focus the main search input on startup", () => {
  const searchBox = sourceBlock("const SearchBox = forwardRef", ["export function App"]);
  expect(searchBox).not.toContain("autoFocus");
  expect(appSource).toContain("searchRef.current?.focus()");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/renderer/src/app-loading.test.ts`

Expected: FAIL because the main `SearchBox` still contains `autoFocus`.

- [ ] **Step 3: Implement the minimal behavior change**

Remove only this prop from the main search input in `src/renderer/src/App.tsx`:

```tsx
autoFocus
```

Keep the `onFocusSearch` listener and `Cmd+K` / `Ctrl+K` handler unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- src/renderer/src/app-loading.test.ts`

Expected: all tests in the file PASS.

- [ ] **Step 5: Run full verification**

Run in order:

```bash
npm run build:mcp
npm test
npm run typecheck
npm run build
```

Expected: all commands exit successfully with zero test failures and no type or build errors.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/renderer/src/app-loading.test.ts src/renderer/src/App.tsx
git commit -m "fix: avoid focusing search on startup"
```
