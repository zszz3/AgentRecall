# Hide Tool Events in Session Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted `Tools` toggle beside the session-detail role filter so Tool Call and Tool Output events are hidden by default and restored in chronological order on demand.

**Architecture:** Keep the feature renderer-only. A focused preference module owns safe `localStorage` parsing and persistence; `DetailPanel` owns the in-memory toggle and filters the already-sorted timeline at the final visibility stage, leaving loading, indexing, exporting, synchronization, and core session data unchanged.

**Tech Stack:** React 19, TypeScript, Electron renderer, CSS, Vitest

## Global Constraints

- Keep `ALL / USER / Assistant` as the existing mutually exclusive role filter.
- Place an independent `Tools` toggle immediately to its right with a small horizontal gap and no vertical divider.
- `Tools` defaults to off, hides both `tool_call` and `tool_result`, and remembers the user's last choice across sessions and application restarts.
- `Tools` composes with every role filter; for example, `USER + Tools` shows User messages and all tool events in chronological order.
- Do not add a count to the toggle or change the existing trace-event count.
- Do not change loading, indexing, search, statistics, remote snapshots, copying, exports, migration, IPC, database schema, or core session loaders.
- Missing, malformed, unreadable, or unwritable preference storage must not prevent the detail panel from working.

---

### Task 1: Safe Tool-Event Visibility Preference

**Files:**
- Create: `src/renderer/src/tool-events-visibility.ts`
- Create: `src/renderer/src/tool-events-visibility.test.ts`

**Interfaces:**
- Consumes: browser-compatible storage with `getItem(key)` and `setItem(key, value)`.
- Produces: `TOOL_EVENTS_VISIBILITY_STORAGE_KEY`, `readStoredToolEventsVisibility(value: string | null): boolean`, `readInitialToolEventsVisibility(storage?: ToolEventsVisibilityStorage | null): boolean`, and `storeToolEventsVisibility(visible: boolean, storage?: ToolEventsVisibilityStorage | null): void`.

- [ ] **Step 1: Write failing preference tests**

Create `src/renderer/src/tool-events-visibility.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  TOOL_EVENTS_VISIBILITY_STORAGE_KEY,
  readInitialToolEventsVisibility,
  readStoredToolEventsVisibility,
  storeToolEventsVisibility,
} from "./tool-events-visibility";

describe("tool-event visibility preference", () => {
  it("defaults missing and malformed values to hidden", () => {
    expect(readStoredToolEventsVisibility(null)).toBe(false);
    expect(readStoredToolEventsVisibility("false")).toBe(false);
    expect(readStoredToolEventsVisibility("1")).toBe(false);
    expect(readStoredToolEventsVisibility("invalid")).toBe(false);
  });

  it("restores only an explicitly enabled preference", () => {
    expect(readStoredToolEventsVisibility("true")).toBe(true);
  });

  it("falls back to hidden when reading storage fails", () => {
    const storage = { getItem: vi.fn(() => { throw new Error("denied"); }), setItem: vi.fn() };
    expect(readInitialToolEventsVisibility(storage)).toBe(false);
    expect(storage.getItem).toHaveBeenCalledWith(TOOL_EVENTS_VISIBILITY_STORAGE_KEY);
  });

  it("stores explicit changes and ignores write failures", () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() };
    storeToolEventsVisibility(true, storage);
    storeToolEventsVisibility(false, storage);
    expect(storage.setItem).toHaveBeenNthCalledWith(1, TOOL_EVENTS_VISIBILITY_STORAGE_KEY, "true");
    expect(storage.setItem).toHaveBeenNthCalledWith(2, TOOL_EVENTS_VISIBILITY_STORAGE_KEY, "false");

    expect(() => storeToolEventsVisibility(true, {
      getItem: vi.fn(),
      setItem: vi.fn(() => { throw new Error("denied"); }),
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `npm test -- --run src/renderer/src/tool-events-visibility.test.ts`

Expected: FAIL because `./tool-events-visibility` does not exist.

- [ ] **Step 3: Implement the minimal safe preference module**

Create `src/renderer/src/tool-events-visibility.ts`:

```ts
export const TOOL_EVENTS_VISIBILITY_STORAGE_KEY = "agent-recall-tool-events-visible";

export interface ToolEventsVisibilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readStoredToolEventsVisibility(value: string | null): boolean {
  return value === "true";
}

function browserStorage(): ToolEventsVisibilityStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readInitialToolEventsVisibility(
  storage: ToolEventsVisibilityStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    return readStoredToolEventsVisibility(storage.getItem(TOOL_EVENTS_VISIBILITY_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function storeToolEventsVisibility(
  visible: boolean,
  storage: ToolEventsVisibilityStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(TOOL_EVENTS_VISIBILITY_STORAGE_KEY, String(visible));
  } catch {
    // Persistence is best-effort; keep the current in-memory selection usable.
  }
}
```

- [ ] **Step 4: Run the preference tests**

Run: `npm test -- --run src/renderer/src/tool-events-visibility.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit the preference boundary**

```bash
git add src/renderer/src/tool-events-visibility.ts src/renderer/src/tool-events-visibility.test.ts
git commit -m "feat: persist tool event visibility"
```

---

### Task 2: Independent Tools Toggle and Timeline Filtering

**Files:**
- Modify: `src/renderer/src/components/detail-panel.tsx`
- Modify: `src/renderer/src/detail-panel-actions.test.ts`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/style-contract.test.ts`

**Interfaces:**
- Consumes: `readInitialToolEventsVisibility()` and `storeToolEventsVisibility(visible)` from Task 1, plus the existing `ConversationTimelineItem[]`, `ConversationRoleFilter`, and chronological `conversationTimeline()` output.
- Produces: exported `filterConversationTimeline(items: ConversationTimelineItem[], roleFilter: ConversationRoleFilter, showTools: boolean): ConversationTimelineItem[]` and the accessible `Tools` toggle in `DetailPanel`.

- [ ] **Step 1: Add failing behavioral and renderer-contract tests**

In `src/renderer/src/detail-panel-actions.test.ts`, import the pure filter and the session types:

```ts
import { filterConversationTimeline } from "./components/detail-panel";
import type { SessionMessage, SessionTraceEvent } from "../../core/types";
```

Add fixtures and tests inside `describe("detail panel actions", ...)`:

```ts
  it("composes role filtering with independent tool-event visibility", () => {
    const user = { index: 0, role: "user", content: "question", timestamp: "2026-07-11T00:00:00.000Z" } as SessionMessage;
    const toolCall = { index: 0, kind: "tool_call", title: "Read", timestamp: "2026-07-11T00:00:01.000Z" } as SessionTraceEvent;
    const assistant = { index: 1, role: "assistant", content: "answer", timestamp: "2026-07-11T00:00:02.000Z" } as SessionMessage;
    const toolResult = { index: 1, kind: "tool_result", title: "tool output", timestamp: "2026-07-11T00:00:03.000Z" } as SessionTraceEvent;
    const items = [
      { kind: "message" as const, key: "message:0", timestampMs: 0, order: 0, message: user },
      { kind: "trace" as const, key: "trace:0", timestampMs: 1, order: 1, event: toolCall },
      { kind: "message" as const, key: "message:1", timestampMs: 2, order: 2, message: assistant },
      { kind: "trace" as const, key: "trace:1", timestampMs: 3, order: 3, event: toolResult },
    ];

    expect(filterConversationTimeline(items, "all", false).map((item) => item.key)).toEqual(["message:0", "message:1"]);
    expect(filterConversationTimeline(items, "all", true).map((item) => item.key)).toEqual(["message:0", "trace:0", "message:1", "trace:1"]);
    expect(filterConversationTimeline(items, "user", true).map((item) => item.key)).toEqual(["message:0", "trace:0", "trace:1"]);
    expect(filterConversationTimeline(items, "assistant", false).map((item) => item.key)).toEqual(["message:1"]);
  });

  it("renders Tools as a separate persisted toggle beside the role filter", () => {
    expect(detailPanelSource).toContain("readInitialToolEventsVisibility");
    expect(detailPanelSource).toContain("storeToolEventsVisibility");
    expect(detailPanelSource).toContain('className={`conversation-tools-toggle ${showTools ? "active" : ""}`}');
    expect(detailPanelSource).toContain('aria-pressed={showTools}');
    expect(detailPanelSource).toContain('l("Tools", "工具")');
    expect(detailPanelSource).toContain("setShowTools");
  });
```

In `src/renderer/src/style-contract.test.ts`, add:

```ts
  it("separates the Tools toggle from role filters with spacing and no divider", () => {
    const controls = stylesheet.match(/\.conversation-filters\s*\{[^}]*\}/)?.[0] ?? "";
    const tools = stylesheet.match(/\.conversation-tools-toggle\s*\{[^}]*\}/)?.[0] ?? "";
    expect(controls).toMatch(/gap:\s*7px/);
    expect(tools).not.toMatch(/border-left/);
  });
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- --run src/renderer/src/detail-panel-actions.test.ts src/renderer/src/style-contract.test.ts`

Expected: FAIL because `filterConversationTimeline`, the toggle markup, and the new CSS selectors do not exist.

- [ ] **Step 3: Add the pure final-stage timeline filter**

In `src/renderer/src/components/detail-panel.tsx`, export the timeline types needed by the test and add the filter after `conversationTimeline()`:

```ts
export type ConversationTimelineItem =
  | { kind: "message"; key: string; timestampMs: number | null; order: number; message: SessionMessage }
  | { kind: "trace"; key: string; timestampMs: number | null; order: number; event: SessionTraceEvent };

export type ConversationRoleFilter = "all" | SessionMessage["role"];

export function filterConversationTimeline(
  items: ConversationTimelineItem[],
  roleFilter: ConversationRoleFilter,
  showTools: boolean,
): ConversationTimelineItem[] {
  return items.filter((item) => {
    if (item.kind === "trace") return showTools;
    return roleFilter === "all" || item.message.role === roleFilter;
  });
}
```

Replace the separate `roleFilteredMessages` / conditional timeline memo with:

```ts
  const visibleTimelineItems = useMemo(
    () => filterConversationTimeline(timelineItems, roleFilter, showTools),
    [roleFilter, showTools, timelineItems],
  );
  const roleFilterEmpty = !loading
    && messages.length > 0
    && roleFilter !== "all"
    && !messages.some((message) => message.role === roleFilter);
```

This filters only presentation output; it does not alter `traceEvents`, `conversationTimeline()`, or header counts.

- [ ] **Step 4: Add the persisted `Tools` state and independent control**

Import Task 1 helpers:

```ts
import { readInitialToolEventsVisibility, storeToolEventsVisibility } from "../tool-events-visibility";
```

Initialize state beside `roleFilter` and do not reset it in the session-change effect:

```ts
  const [roleFilter, setRoleFilter] = useState<ConversationRoleFilter>("all");
  const [showTools, setShowTools] = useState(readInitialToolEventsVisibility);
```

Add a handler that updates the current UI even if persistence fails:

```ts
  const toggleTools = () => {
    setShowTools((current) => {
      const next = !current;
      storeToolEventsVisibility(next);
      return next;
    });
  };
```

Replace the header's single role-filter container with adjacent controls:

```tsx
<div className="conversation-filters">
  <div className="conversation-role-filter" role="group" aria-label={l("Conversation role filter", "会话角色过滤")}>
    {CONVERSATION_ROLE_FILTERS.map((filter) => (
      <button
        key={filter}
        className={roleFilter === filter ? "active" : ""}
        onClick={() => setRoleFilter(filter)}
        aria-pressed={roleFilter === filter}
      >
        {conversationRoleFilterLabel(filter, language)}
      </button>
    ))}
  </div>
  <button
    className={`conversation-tools-toggle ${showTools ? "active" : ""}`}
    onClick={toggleTools}
    aria-pressed={showTools}
  >
    {l("Tools", "工具")}
  </button>
</div>
```

- [ ] **Step 5: Style the adjacent independent toggle without a divider**

In `src/renderer/src/styles.css`, add:

```css
.conversation-filters {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
}

.conversation-tools-toggle {
  height: 29px;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--panel-subtle);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
}

.conversation-tools-toggle:hover {
  color: var(--text);
}

.conversation-tools-toggle.active {
  background: var(--panel-bg);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
}
```

Do not add `border-left`, a pseudo-element divider, or a trace count.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm test -- --run src/renderer/src/tool-events-visibility.test.ts src/renderer/src/detail-panel-actions.test.ts src/renderer/src/style-contract.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 7: Commit the detail interaction**

```bash
git add src/renderer/src/components/detail-panel.tsx src/renderer/src/detail-panel-actions.test.ts src/renderer/src/styles.css src/renderer/src/style-contract.test.ts
git commit -m "feat: hide tool events in session details"
```

---

### Task 3: Full Regression Verification

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: the completed renderer preference and detail-panel interaction from Tasks 1 and 2.
- Produces: evidence that the renderer-only feature does not regress the application test suite or production build.

- [ ] **Step 1: Run the complete test suite with loopback access**

Run: `npm test -- --run`

Expected: PASS, including the proxy tests that bind `127.0.0.1`.

- [ ] **Step 2: Run the production build**

Run: `npm run build`

Expected: PASS; typecheck, MCP bundle, main/preload bundles, and renderer bundle all complete successfully.

- [ ] **Step 3: Inspect the final diff and branch state**

Run: `git diff --check HEAD~2..HEAD && git status --short --branch && git log -3 --oneline`

Expected: no whitespace errors, a clean `feature/hide-tool-events` worktree, and two implementation commits after design commit `f74aa9a`.
