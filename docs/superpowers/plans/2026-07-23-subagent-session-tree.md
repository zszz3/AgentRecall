# Subagent Session Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在会话详情中展示可折叠的完整子 Agent 会话树，并让子会话可以返回其父会话，同时保持主列表隐藏子会话的设置不变。

**Architecture:** 新增独立的 `session-family` 领域查询，直接从 SQLite 按 `source + environmentId + rawId/parentSessionId` 构建安全树；通过现有 Discovery IPC 暴露只读结果；渲染层使用独立组件展示父会话入口和子树，并复用现有详情导航。

**Tech Stack:** TypeScript、Node SQLite、Electron IPC、React、Vitest、CSS。

## Global Constraints

- 不改变现有数据库结构和子 Agent 索引格式。
- 树查询忽略全局 `hideSubagentSessions`，但排除 `hidden = 1` 的会话。
- 关联必须同时匹配 `source` 和 `environmentId`。
- 最多返回 12 层、200 个节点；循环或超限时设置 `truncated = true`。
- 列表、搜索和统计的子 Agent 隐藏行为保持不变。
- 每个实现步骤先运行失败测试，再写最小实现。
- 分支必须添加且只添加一个 `.release-notes/associate-subagent-sessions.md` 用户发布说明。

---

### Task 1: Session family domain query

**Files:**
- Create: `src/core/session-family.ts`
- Create: `src/core/session-family.test.ts`
- Modify: `src/core/session-store.ts`

**Interfaces:**
- Consumes: `SessionStoreDatabase` and existing `sessions` / `environments` tables.
- Produces: `SubagentSessionSummary`, `SubagentSessionNode`, `SessionFamily`, `findSessionFamily(db, sessionKey)`, and `SessionStore.getSessionFamily(sessionKey)`.

- [ ] **Step 1: Write the failing domain tests**

Create fixtures for a root, two direct children, one grandchild, a same-ID session in another environment, one individually hidden child, an orphan, and a two-node cycle. Assert:

```ts
const family = findSessionFamily(db, "codex:root");
expect(family.children.map((node) => node.sessionKey)).toEqual(["codex:child-a", "codex:child-b"]);
expect(family.children[0].children[0].sessionKey).toBe("codex:grandchild");
expect(JSON.stringify(family)).not.toContain("ssh:duplicate-child");
expect(JSON.stringify(family)).not.toContain("codex:hidden-child");
expect(family.truncated).toBe(false);

const childFamily = findSessionFamily(db, "codex:child-a");
expect(childFamily.parent?.sessionKey).toBe("codex:root");

const cycleFamily = findSessionFamily(db, "codex:cycle-a");
expect(cycleFamily.truncated).toBe(true);
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx vitest run src/core/session-family.test.ts`

Expected: FAIL because `findSessionFamily` and its types do not exist.

- [ ] **Step 3: Implement the typed query and bounded tree builder**

Define:

```ts
export interface SubagentSessionSummary {
  sessionKey: string;
  rawId: string;
  title: string;
  source: SessionSource;
  environmentId: string;
  environmentLabel: string;
  messageCount: number;
  lastActivityAt: number;
  aiSummary: string | null;
}

export interface SubagentSessionNode extends SubagentSessionSummary {
  children: SubagentSessionNode[];
}

export interface SessionFamily {
  parent: SubagentSessionSummary | null;
  children: SubagentSessionNode[];
  truncated: boolean;
}
```

Read the target first, then query visible candidates with the same `source` and `environment_id`. Build `rawId -> row` and `parentSessionId -> rows` maps. Recursively build descendants with a path-local visited set, maximum depth 12, and shared maximum node count 200. Sort siblings by `last_activity_at`, then lowercase title and `session_key`. Return an empty family when the target is missing.

- [ ] **Step 4: Delegate from SessionStore**

Add:

```ts
getSessionFamily(sessionKey: string): SessionFamily {
  return findSessionFamily(this.db, sessionKey);
}
```

Export the domain types through `session-store.ts`.

- [ ] **Step 5: Run domain tests and typecheck**

Run:

```bash
npx vitest run src/core/session-family.test.ts src/core/session-store.test.ts
npm run typecheck
```

Expected: all selected tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/session-family.ts src/core/session-family.test.ts src/core/session-store.ts
git commit -m "Add bounded subagent session family queries"
```

### Task 2: Typed Discovery IPC

**Files:**
- Modify: `src/shared/ipc/discovery.ts`
- Modify: `src/preload/discovery.ts`
- Modify: `src/main/ipc/discovery.ts`
- Modify: `src/main/index.ts`
- Create: `src/main/discovery-ipc.test.ts`

**Interfaces:**
- Consumes: `SessionStore.getSessionFamily(sessionKey): SessionFamily`.
- Produces: `window.sessionSearch.getSessionFamily(sessionKey): Promise<SessionFamily>`.

- [ ] **Step 1: Write the failing IPC test**

Register Discovery IPC against a fake service and invoke the captured handler:

```ts
expect(DISCOVERY_IPC.getSessionFamily.channel).toBe("discovery:session-family");
await handlers.get(DISCOVERY_IPC.getSessionFamily.channel)?.({}, "codex:root");
expect(service.getSessionFamily).toHaveBeenCalledWith("codex:root");

const api = createDiscoveryApi(ipc);
await api.getSessionFamily("codex:root");
expect(ipc.invoke).toHaveBeenCalledWith("discovery:session-family", "codex:root");
```

- [ ] **Step 2: Run the IPC test and verify RED**

Run: `npx vitest run src/main/discovery-ipc.test.ts`

Expected: FAIL because the channel and API method are missing.

- [ ] **Step 3: Add the contract, preload method, and main handler**

Add a one-string Zod tuple:

```ts
getSessionFamily: defineIpcRequest(
  "discovery:session-family",
  z.tuple([z.string().trim().min(1)]),
),
```

Add `getSessionFamily` to `DiscoveryIpcService`, register the typed handler, expose the preload method, and delegate from `createDiscoveryService()` to `store.getSessionFamily`.

- [ ] **Step 4: Run the IPC test and typecheck**

Run:

```bash
npx vitest run src/main/discovery-ipc.test.ts
npm run typecheck
```

Expected: test passes and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc/discovery.ts src/preload/discovery.ts src/main/ipc/discovery.ts src/main/index.ts src/main/discovery-ipc.test.ts
git commit -m "Expose subagent session families over IPC"
```

### Task 3: Independent tree component

**Files:**
- Create: `src/renderer/src/features/session-detail/subagent-session-tree.tsx`
- Create: `src/renderer/src/features/session-detail/subagent-session-tree.test.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `SessionFamily`, `LanguageMode`, and `onOpen(sessionKey)`.
- Produces: `SubagentSessionTree` React component.

- [ ] **Step 1: Write failing component rendering tests**

Use `renderToStaticMarkup` with one direct child and one grandchild:

```ts
const html = renderToStaticMarkup(
  <SubagentSessionTree family={family} language="zh" onOpen={() => undefined} />,
);
expect(html).toContain("子 Agent 会话");
expect(html).toContain("一级任务");
expect(html).not.toContain("二级任务");
expect(html).toContain("父会话");
```

Also assert an empty family renders an empty string, and a truncated family renders the localized truncation message.

- [ ] **Step 2: Run the component test and verify RED**

Run: `npx vitest run src/renderer/src/features/session-detail/subagent-session-tree.test.tsx`

Expected: FAIL because the component is missing.

- [ ] **Step 3: Implement the component**

Implement:

```ts
export function SubagentSessionTree({
  family,
  language,
  onOpen,
}: {
  family: SessionFamily;
  language: LanguageMode;
  onOpen: (sessionKey: string) => void;
}): ReactElement | null
```

Render the parent as a separate relationship button. Render direct children immediately. Keep deeper node IDs in a local `Set<string>` of expanded nodes; a node with children receives an accessible expand/collapse button. Show title, source/environment label, message count, relative time, and up to two lines of summary. Do not render the section when there is no parent, no children, and no truncation.

- [ ] **Step 4: Add focused styles**

Add `.subagent-session-tree`, `.subagent-tree-node`, `.subagent-tree-children`, `.subagent-parent-link`, and truncation styles next to the existing related-session styles. Use existing color, border, spacing, and typography variables.

- [ ] **Step 5: Run component tests and typecheck**

Run:

```bash
npx vitest run src/renderer/src/features/session-detail/subagent-session-tree.test.tsx
npm run typecheck
```

Expected: tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/session-detail/subagent-session-tree.tsx src/renderer/src/features/session-detail/subagent-session-tree.test.tsx src/renderer/src/styles.css
git commit -m "Render subagent session trees"
```

### Task 4: Detail page integration

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/features/session-detail/detail-panel.tsx`
- Modify: `src/renderer/src/detail-panel-actions.test.ts`

**Interfaces:**
- Consumes: `window.sessionSearch.getSessionFamily` and `SubagentSessionTree`.
- Produces: family loading tied to the selected detail and navigation through the existing `openDetail`.

- [ ] **Step 1: Write failing integration assertions**

Extend `detail-panel-actions.test.ts`:

```ts
expect(appSource).toContain("getSessionFamily(detail.sessionKey)");
expect(appSource).toContain("setSessionFamily");
expect(detailPanelSource).toContain("<SubagentSessionTree");
expect(detailPanelSource.indexOf("<SubagentSessionTree")).toBeLessThan(
  detailPanelSource.indexOf("<RelatedSessions"),
);
```

Assert `DetailPanel` receives `sessionFamily` and uses the same open-session callback as related sessions.

- [ ] **Step 2: Run the renderer test and verify RED**

Run: `npx vitest run src/renderer/src/detail-panel-actions.test.ts`

Expected: FAIL because family state and rendering are absent.

- [ ] **Step 3: Load family data with the selected detail**

Add `sessionFamily` state initialized to `{ parent: null, children: [], truncated: false }`. When `detail?.sessionKey` changes, request related sessions and session family concurrently, apply cancellation guards, and reset both values on close or failure.

- [ ] **Step 4: Wire DetailPanel and navigation**

Pass:

```tsx
sessionFamily={sessionFamily}
onOpenSession={openRelatedSession}
```

Render `SubagentSessionTree` after the conversation section and before `RelatedSessions`. Reuse the existing callback so opening a parent or child refreshes messages, traces, relations, and family data through `openDetail`.

- [ ] **Step 5: Run renderer tests, typecheck, and build**

Run:

```bash
npx vitest run src/renderer/src/detail-panel-actions.test.ts src/renderer/src/session-ui.test.ts
npm run typecheck
npm run build
```

Expected: tests pass, TypeScript exits 0, and the production build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/features/session-detail/detail-panel.tsx src/renderer/src/detail-panel-actions.test.ts
git commit -m "Connect subagent trees to session details"
```

### Task 5: Release note and full verification

**Files:**
- Create: `.release-notes/associate-subagent-sessions.md`

**Interfaces:**
- Consumes: completed feature.
- Produces: user-facing release copy and verified branch.

- [ ] **Step 1: Add the release note**

```markdown
# 在父会话中查看子 Agent 工作

## 新增功能
- 会话详情现在会以可折叠树展示它创建的全部子 Agent 会话；即使子会话已从主列表隐藏，也可以查看摘要、逐层展开并打开对应会话。
```

- [ ] **Step 2: Run focused and full verification**

Run:

```bash
npx vitest run src/core/session-family.test.ts src/main/discovery-ipc.test.ts src/renderer/src/features/session-detail/subagent-session-tree.test.tsx src/renderer/src/detail-panel-actions.test.ts
npm test
npm run typecheck
npm run build
npm run release-note:check
npm run package:smoke
git diff --check
```

Expected: all tests pass, build and package smoke test exit 0, one valid release note is detected, and no whitespace errors remain.

- [ ] **Step 3: Commit**

```bash
git add .release-notes/associate-subagent-sessions.md
git commit -m "Document subagent session tree"
```

- [ ] **Step 4: Review final branch state**

Run:

```bash
git status --short --branch
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: clean worktree with the design, plan, implementation, tests, and exactly one new release note on this branch.
