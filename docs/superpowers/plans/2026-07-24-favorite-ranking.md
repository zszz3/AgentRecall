# 收藏会话排序迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让收藏状态继承 Pin 原有的列表优先级、普通相关性加权和智能排序加权，不迁移历史 Pin 数据。

**Architecture:** SQLite 仍保留旧 `pinned` 列，但查询只读取 `favorited`。空查询候选 SQL 和内存排序都优先收藏；有关键词时，普通相关性和智能排序分别使用原 Pin 的 `+25` 与 `×1.2` 权重。

**Tech Stack:** TypeScript、Node.js SQLite、Vitest。

## Global Constraints

- 不把历史 `pinned = true` 转成 `favorited = true`。
- 旧 `pinned` 值继续不影响展示、筛选或排序。
- 收藏筛选、收藏和取消收藏操作保持不变。
- 先运行失败测试，再写生产代码。
- 更新现有 PR #166，不创建新 PR。

---

### Task 1: 收藏继承三项排序规则

**Files:**
- Modify: `src/core/session-store.test.ts`
- Modify: `src/core/session-store-performance.test.ts`
- Modify: `src/core/store/sessions.ts`
- Modify: `.release-notes/remove-pin.md`

**Interfaces:**
- Consumes: `SessionSearchResult.favorited`
- Produces: 收藏优先的空查询、普通相关性和智能排序

- [ ] **Step 1: 写空查询失败测试**

在 `session-store.test.ts` 中创建一新一旧两个会话，把旧会话设为收藏：

```ts
store.setFavorited("codex:older", true);
expect(store.searchSessions({ query: "" }).map((session) => session.sessionKey)).toEqual([
  "codex:older",
  "codex:newer",
]);
```

- [ ] **Step 2: 写普通相关性失败测试**

创建相关性相同但时间不同的两个关键词命中会话，使用 `sortBy: "activity"`，把较旧会话设为收藏：

```ts
store.setFavorited("codex:older-match", true);
expect(
  store.searchSessions({ query: "deploy", sortBy: "activity" }).map((session) => session.sessionKey),
).toEqual(["codex:older-match", "codex:newer-match"]);
```

- [ ] **Step 3: 写智能排序失败测试**

固定系统时间，创建相关性相同、相差五天的两个会话，把较旧会话设为收藏：

```ts
vi.useFakeTimers();
vi.setSystemTime(new Date("2026-07-24T00:00:00Z"));
store.setFavorited("codex:favorite-smart", true);
expect(
  store.searchSessions({ query: "deploy", sortBy: "smart" }).map((session) => session.sessionKey),
).toEqual(["codex:favorite-smart", "codex:recent-smart"]);
vi.useRealTimers();
```

- [ ] **Step 4: 验证 RED**

Run:

```bash
npx vitest run src/core/session-store.test.ts src/core/session-store-performance.test.ts
```

Expected: 三项收藏排序断言失败，现有旧 Pin 不影响排序测试继续通过。

- [ ] **Step 5: 写最小实现**

在空查询 SQL 中恢复原优先级，但改用收藏：

```sql
ORDER BY favorited DESC, ${sessionSortSql(options.sortBy)} DESC
```

在 `score` 中使用原权重：

```ts
if (!query) return result.favorited ? 1_000_000_000_000 : 0;
// ...
if (result.favorited) score += 25;
```

在 `smartScore` 中使用原乘数：

```ts
const favoriteBoost = result.favorited ? 1.2 : 1.0;
return relevance * (0.08 + 0.92 * decay) * favoriteBoost;
```

- [ ] **Step 6: 更新源码契约测试**

在 `session-store-performance.test.ts` 断言：

```ts
expect(candidatesBlock).toContain("ORDER BY favorited DESC");
expect(storeSource).toContain("if (result.favorited) score += 25");
expect(storeSource).toContain("result.favorited ? 1.2 : 1.0");
expect(storeSource).not.toContain("result.pinned");
```

- [ ] **Step 7: 验证 GREEN**

Run:

```bash
npx vitest run src/core/session-store.test.ts src/core/session-store-performance.test.ts
```

Expected: 全部通过。

- [ ] **Step 8: 更新 release note**

```markdown
# 移除会话置顶功能

## Bug 修复

- 会话整理入口不再显示置顶选项；收藏会话会继续在列表和搜索结果中优先展示。
```

- [ ] **Step 9: 完整验证**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run release-note:check
git diff --check origin/main...HEAD
```

Expected: 所有命令退出 0。

- [ ] **Step 10: 提交并推送**

```bash
git add src/core/session-store.test.ts src/core/session-store-performance.test.ts src/core/store/sessions.ts .release-notes/remove-pin.md
git commit -m "feat(search): prioritize favorite sessions"
git push
```
