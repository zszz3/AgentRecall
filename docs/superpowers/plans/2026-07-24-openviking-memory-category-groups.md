# OpenViking Memory Category Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat OpenViking memory result list with ordered, independently collapsible category groups that default to expanded.

**Architecture:** Keep OpenViking, preload, IPC, and persistence unchanged. Add one pure Renderer domain module that derives canonical categories from memory URIs and source metadata, then let the existing Memory page own transient collapsed-category state and render accessible group headers inside the existing scroll container.

**Tech Stack:** TypeScript, React, Lucide React, CSS, Vitest

---

## File Structure

- Create `src/renderer/src/features/openviking-memory/openviking-memory-groups.ts`: canonical category definitions and pure grouping function.
- Create `src/renderer/src/features/openviking-memory/openviking-memory-groups.test.ts`: category mapping, ordering, counts, and fallback coverage.
- Modify `src/renderer/src/features/openviking-memory/openviking-memory-page.tsx`: collapsed state, grouping memo, reset behavior, and accessible grouped rendering.
- Modify `src/renderer/src/styles/openviking-memory.css`: category header, count, body, and nested memory-row styles.
- Modify `src/renderer/src/openviking-memory-ui.test.ts`: Renderer and CSS wiring contract.

### Task 1: Add the Memory Category Domain

**Files:**
- Create: `src/renderer/src/features/openviking-memory/openviking-memory-groups.ts`
- Create: `src/renderer/src/features/openviking-memory/openviking-memory-groups.test.ts`

- [ ] **Step 1: Write the failing category-grouping tests**

Create `src/renderer/src/features/openviking-memory/openviking-memory-groups.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { OpenVikingMemoryItem } from "../../../../core/openviking-memory";
import { groupOpenVikingMemories } from "./openviking-memory-groups";

function memory(id: string, source?: string): OpenVikingMemoryItem {
  return {
    id,
    workspaceId: "workspace-1",
    title: id.split("/").at(-1) ?? id,
    content: "",
    ...(source ? { source } : {}),
  };
}

describe("groupOpenVikingMemories", () => {
  it("uses stable OpenViking category order while preserving item order", () => {
    const groups = groupOpenVikingMemories([
      memory("viking://user/memories/trajectories/second.md", "trajectories"),
      memory("viking://user/memories/cases/first.md", "cases"),
      memory("viking://user/memories/trajectories/third.md", "trajectories"),
      memory("viking://user/memories/preferences/user/theme.md", "preferences"),
    ]);

    expect(groups.map((group) => [group.key, group.memories.length])).toEqual([
      ["preferences", 1],
      ["cases", 1],
      ["trajectories", 2],
    ]);
    expect(groups[2].memories.map((item) => item.id)).toEqual([
      "viking://user/memories/trajectories/second.md",
      "viking://user/memories/trajectories/third.md",
    ]);
  });

  it("combines identity files and handles manual and unknown memories", () => {
    const groups = groupOpenVikingMemories([
      memory("viking://user/memories/identity.md", "identity.md"),
      memory("viking://user/memories/soul.md", "soul.md"),
      memory("viking://user/memories/manual/note.md"),
      memory("viking://user/memories/custom/note.md", "custom"),
      memory("", undefined),
    ]);

    expect(groups.map((group) => [group.key, group.memories.length])).toEqual([
      ["identity", 2],
      ["manual", 2],
      ["other", 1],
    ]);
  });

  it("uses the memory URI category for semantic results with provenance sources", () => {
    const groups = groupOpenVikingMemories([
      memory("viking://user/memories/events/2026/07/24/imported.md", "session-123"),
    ]);

    expect(groups[0].key).toBe("events");
  });

  it("falls back to source when an item has no OpenViking memory URI", () => {
    const groups = groupOpenVikingMemories([
      memory("opaque-memory-id", "cases"),
    ]);

    expect(groups[0].key).toBe("cases");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run src/renderer/src/features/openviking-memory/openviking-memory-groups.test.ts
```

Expected: FAIL because `openviking-memory-groups.ts` does not exist.

- [ ] **Step 3: Implement the pure grouping domain**

Create `src/renderer/src/features/openviking-memory/openviking-memory-groups.ts`:

```ts
import type { OpenVikingMemoryItem } from "../../../../core/openviking-memory";

export type OpenVikingMemoryCategory =
  | "identity"
  | "preferences"
  | "cases"
  | "experiences"
  | "events"
  | "trajectories"
  | "manual"
  | "other";

export interface OpenVikingMemoryGroup {
  key: OpenVikingMemoryCategory;
  label: { en: string; zh: string };
  memories: OpenVikingMemoryItem[];
}

const CATEGORIES: ReadonlyArray<{
  key: OpenVikingMemoryCategory;
  label: { en: string; zh: string };
}> = [
  { key: "identity", label: { en: "Identity", zh: "身份" } },
  { key: "preferences", label: { en: "Preferences", zh: "偏好" } },
  { key: "cases", label: { en: "Cases", zh: "案例" } },
  { key: "experiences", label: { en: "Experiences", zh: "经验" } },
  { key: "events", label: { en: "Events", zh: "事件" } },
  { key: "trajectories", label: { en: "Trajectories", zh: "轨迹" } },
  { key: "manual", label: { en: "Manual", zh: "手动" } },
  { key: "other", label: { en: "Other", zh: "其他" } },
];

const CATEGORY_KEYS = new Set<OpenVikingMemoryCategory>(
  CATEGORIES.map((category) => category.key),
);

export function groupOpenVikingMemories(
  memories: OpenVikingMemoryItem[],
): OpenVikingMemoryGroup[] {
  const grouped = new Map<OpenVikingMemoryCategory, OpenVikingMemoryItem[]>();
  for (const memory of memories) {
    const key = memoryCategory(memory);
    const bucket = grouped.get(key) ?? [];
    bucket.push(memory);
    grouped.set(key, bucket);
  }
  return CATEGORIES.flatMap((category) => {
    const items = grouped.get(category.key);
    return items?.length ? [{ ...category, memories: items }] : [];
  });
}

function memoryCategory(memory: OpenVikingMemoryItem): OpenVikingMemoryCategory {
  if (!memory.id) return "manual";
  const uriMatch = /^viking:\/\/user\/memories\/?([^/]*)/iu.exec(memory.id);
  const uriSegment = uriMatch?.[1]?.toLowerCase() ?? "";
  const source = memory.source?.trim().toLowerCase() ?? "";
  for (const candidate of [uriSegment, source]) {
    if (candidate === "identity.md" || candidate === "soul.md") return "identity";
    if (CATEGORY_KEYS.has(candidate as OpenVikingMemoryCategory)) {
      return candidate as OpenVikingMemoryCategory;
    }
  }
  return "other";
}
```

- [ ] **Step 4: Run the category tests and verify GREEN**

Run:

```bash
npx vitest run src/renderer/src/features/openviking-memory/openviking-memory-groups.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit the category domain**

```bash
git add src/renderer/src/features/openviking-memory/openviking-memory-groups.ts \
  src/renderer/src/features/openviking-memory/openviking-memory-groups.test.ts
git commit -m "feat(memory): group memories by category"
```

### Task 2: Render Accessible Collapsible Groups

**Files:**
- Modify: `src/renderer/src/features/openviking-memory/openviking-memory-page.tsx`
- Modify: `src/renderer/src/openviking-memory-ui.test.ts`

- [ ] **Step 1: Write a failing Renderer wiring test**

Append to `src/renderer/src/openviking-memory-ui.test.ts`:

```ts
it("renders accessible collapsible memory category groups", async () => {
  const source = await readFile(
    path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
    "utf8",
  );

  expect(source).toContain("groupOpenVikingMemories");
  expect(source).toContain("collapsedCategories");
  expect(source).toContain('aria-expanded={!isCollapsed}');
  expect(source).toContain('className="openviking-result-group-head"');
  expect(source).toContain("group.memories.length");
  expect(source).toContain('aria-hidden="true"');
});
```

- [ ] **Step 2: Run the UI test and verify RED**

Run:

```bash
npx vitest run src/renderer/src/openviking-memory-ui.test.ts
```

Expected: FAIL because the Memory page does not yet contain grouping or collapsed state.

- [ ] **Step 3: Add grouped state and rendering to the Memory page**

In `src/renderer/src/features/openviking-memory/openviking-memory-page.tsx`:

1. Import `ChevronDown` and `ChevronRight` from `lucide-react`.
2. Import `groupOpenVikingMemories` and `OpenVikingMemoryCategory`.
3. Add:

```ts
const [collapsedCategories, setCollapsedCategories] = useState<
  Set<OpenVikingMemoryCategory>
>(() => new Set());
const memoryGroups = useMemo(() => groupOpenVikingMemories(results), [results]);

useEffect(() => {
  setCollapsedCategories(new Set());
}, [results, workspaceId]);

const toggleCategory = (category: OpenVikingMemoryCategory) => {
  setCollapsedCategories((current) => {
    const next = new Set(current);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    return next;
  });
};
```

Replace the flat `results.map` branch with:

```tsx
memoryGroups.map((group) => {
  const isCollapsed = collapsedCategories.has(group.key);
  return (
    <section className="openviking-result-group" key={group.key}>
      <button
        type="button"
        className="openviking-result-group-head"
        aria-expanded={!isCollapsed}
        onClick={() => toggleCategory(group.key)}
      >
        <span aria-hidden="true">
          {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </span>
        <strong>{l(group.label.en, group.label.zh)}</strong>
        <em>{group.memories.length}</em>
      </button>
      {!isCollapsed ? (
        <div className="openviking-result-group-body">
          {group.memories.map((memory) => (
            <button
              type="button"
              key={memory.id}
              className={selected?.id === memory.id ? "active" : ""}
              onClick={() => void openMemory(memory)}
            >
              <strong>{memory.title}</strong>
              <span>{memory.content || memory.source || memory.id}</span>
              {memory.score !== undefined ? <em>{memory.score.toFixed(2)}</em> : null}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
})
```

- [ ] **Step 4: Run the UI and category tests**

Run:

```bash
npx vitest run \
  src/renderer/src/features/openviking-memory/openviking-memory-groups.test.ts \
  src/renderer/src/openviking-memory-ui.test.ts
```

Expected: 11 tests pass.

### Task 3: Style the Category Groups

**Files:**
- Modify: `src/renderer/src/styles/openviking-memory.css`
- Modify: `src/renderer/src/openviking-memory-ui.test.ts`

- [ ] **Step 1: Extend the CSS contract test and verify RED**

Add these expectations to the category-group UI test:

```ts
const css = await readFile(
  path.join(process.cwd(), "src/renderer/src/styles/openviking-memory.css"),
  "utf8",
);
expect(css).toContain(".openviking-result-group-head");
expect(css).toContain(".openviking-result-group-body");
```

Run:

```bash
npx vitest run src/renderer/src/openviking-memory-ui.test.ts
```

Expected: FAIL because category-group CSS is absent.

- [ ] **Step 2: Add compact category and nested row styles**

In `src/renderer/src/styles/openviking-memory.css`, replace the direct-child result row selectors with group-body selectors and add:

```css
.openviking-result-group {
  border-bottom: 1px solid var(--border);
}

.openviking-result-group-head {
  display: grid;
  width: 100%;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 8px 11px;
  background: var(--panel-subtle);
  color: var(--text-muted);
  text-align: left;
}

.openviking-result-group-head:hover {
  background: var(--panel-hover);
  color: var(--text);
}

.openviking-result-group-head > span {
  display: grid;
  place-items: center;
  color: var(--text-faint);
}

.openviking-result-group-head > strong {
  overflow: hidden;
  color: inherit;
  font-size: 11.5px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.openviking-result-group-head > em {
  min-width: 22px;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--panel-bg);
  color: var(--text-faint);
  font-size: 9.5px;
  font-style: normal;
  text-align: center;
}

.openviking-result-group-body > button {
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 4px;
  padding: 11px 13px 11px 22px;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  text-align: left;
}
```

Update the existing hover, active, title, source, and score selectors from `.openviking-result-list > button` to `.openviking-result-group-body > button`.

- [ ] **Step 3: Run focused tests and typecheck**

Run:

```bash
npx vitest run \
  src/renderer/src/features/openviking-memory/openviking-memory-groups.test.ts \
  src/renderer/src/openviking-memory-ui.test.ts
npm run typecheck
```

Expected: 11 tests pass and TypeScript exits 0.

- [ ] **Step 4: Commit grouped rendering and styles**

```bash
git add src/renderer/src/features/openviking-memory/openviking-memory-page.tsx \
  src/renderer/src/openviking-memory-ui.test.ts \
  src/renderer/src/styles/openviking-memory.css
git commit -m "feat(memory): add collapsible category sections"
```

### Task 4: Verify the Live Memory Page

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Verify the focused automated suite**

Run:

```bash
npx vitest run \
  src/renderer/src/features/openviking-memory/openviking-memory-groups.test.ts \
  src/renderer/src/openviking-memory-ui.test.ts
npm run typecheck
```

Expected: 11 tests pass and TypeScript exits 0.

- [ ] **Step 2: Verify the running Electron UI**

In the running development app:

1. Open Memory.
2. Confirm the existing 127 memories appear under non-empty category headings.
3. Confirm all headings initially report `aria-expanded="true"`.
4. Collapse “经验”; confirm only that section's rows disappear and the selected detail remains.
5. Expand “经验”; confirm its rows return.
6. Scroll to “事件”; confirm deep date-based event memories remain reachable.

- [ ] **Step 3: Check the final diff boundary**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; unrelated pre-existing dirty files remain untouched.
