# Codex App Task Workspace Friendly Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AgentRecall 左侧项目树把 Codex App 自动日期任务目录显示为唯一根会话的可读标题，同时保持真实路径作为稳定身份。

**Architecture:** `SessionStore.listProjects()` 继续拥有项目聚合和路径消歧，并从现有会话字段推导结构化显示字段；不增加数据库表或 schema migration。渲染器通过一个复用的展示函数完成中英文未命名占位符和后缀拼接，所有筛选与 Resume 仍使用 `projectPath + environmentId`。

**Tech Stack:** TypeScript、Electron、React、Node.js `node:sqlite`、Vitest。

## Global Constraints

- 只识别唯一根会话来源为 `codex-app` 且路径末尾符合 `Codex/YYYY-MM-DD/<任务目录>` 的项目。
- `Codex` 路径段按 ASCII 不区分大小写；日期必须是有效 ISO 日历日期；同时支持 `/` 与 `\`。
- `custom_title` 优先于 `original_title`，后者已经吸收 Codex `thread_name` 和会话元数据标题；随后回退到 `first_question`。
- subagent 不参与名称选择，但现有可见性设置仍决定项目会话计数和活动时间。
- 不读取任务目录正文，不要求目录存在，不修改真实 Codex 会话、物理目录或 Resume 路径。
- 不新增 AI 请求、设置项、IPC 或数据库 schema。
- 普通项目和其他来源保持当前路径标签、父目录消歧和跨环境消歧行为。
- macOS、Linux、Windows 路径测试使用合成数据；不得读取或改写真实用户会话。
- 分支最终只新增一份 `.release-notes/codex-task-workspace-labels.md`。

---

### Task 1: 引入结构化项目显示契约且保持现有行为

**Files:**
- Modify: `src/core/types.ts:223-232`
- Modify: `src/core/store/sessions.ts:740-807`
- Modify: `src/core/session-store.test.ts:1183-1256, 1817-1869`
- Modify: `src/renderer/src/session-ui.ts:132-134`
- Modify: `src/renderer/src/session-ui.test.ts:1-18`
- Modify: `src/renderer/src/App.tsx:1060-1130, 1838-1875`

**Interfaces:**
- Produces: `ProjectLabelKind = "path" | "codex-task-title" | "codex-task-untitled"`。
- Produces: `ProjectSummary.labelKind: ProjectLabelKind` 和 `ProjectSummary.labelSuffix: string | null`。
- Produces: `projectDisplayLabel(project, language): string`，后续任务复用。
- Preserves: `ProjectSummary.path`、`environmentId`、排序和点击筛选语义。

- [ ] **Step 1: 为结构化标签写失败测试**

在 `src/core/session-store.test.ts` 的现有项目列表断言中加入结构化字段。普通重复目录与跨环境项目必须分别得到以下结果：

```ts
expect(store.listProjects()).toEqual([
  {
    path: "/work/team-a/app",
    label: "team-a/app",
    labelKind: "path",
    labelSuffix: null,
    sessionCount: 2,
    environmentId: "local",
    environmentLabel: "Local",
    createdAt,
    lastActivityAt,
  },
  {
    path: "/work/team-b/app",
    label: "team-b/app",
    labelKind: "path",
    labelSuffix: null,
    sessionCount: 1,
    environmentId: "local",
    environmentLabel: "Local",
    createdAt,
    lastActivityAt,
  },
]);
```

跨环境的现有测试改为断言基础标签和环境后缀分离：

```ts
expect(store.listProjects().map(({ label, labelKind, labelSuffix }) => ({ label, labelKind, labelSuffix }))).toEqual([
  { label: "app", labelKind: "path", labelSuffix: "Local" },
  { label: "app", labelKind: "path", labelSuffix: "devbox" },
]);
```

在 `src/renderer/src/session-ui.test.ts` 导入 `projectDisplayLabel` 并加入：

```ts
it("renders structured project labels in both languages", () => {
  expect(projectDisplayLabel({ label: "app", labelKind: "path", labelSuffix: "Local" }, "zh")).toBe("app · Local");
  expect(projectDisplayLabel({ label: "Hermes 重写", labelKind: "codex-task-title", labelSuffix: "07-18" }, "zh")).toBe(
    "Hermes 重写 · 07-18",
  );
  expect(projectDisplayLabel({ label: "Untitled session", labelKind: "codex-task-untitled", labelSuffix: "07-19 19:25" }, "zh")).toBe(
    "未命名会话 · 07-19 19:25",
  );
  expect(projectDisplayLabel({ label: "Untitled session", labelKind: "codex-task-untitled", labelSuffix: null }, "en")).toBe(
    "Untitled session",
  );
});
```

- [ ] **Step 2: 运行测试并确认契约尚不存在**

Run:

```bash
npx vitest run src/core/session-store.test.ts src/renderer/src/session-ui.test.ts
```

Expected: FAIL，TypeScript 报告 `labelKind`、`labelSuffix` 或 `projectDisplayLabel` 缺失。

- [ ] **Step 3: 实现结构化显示字段**

在 `src/core/types.ts` 定义：

```ts
export type ProjectLabelKind = "path" | "codex-task-title" | "codex-task-untitled";

export interface ProjectSummary {
  path: string;
  label: string;
  labelKind: ProjectLabelKind;
  labelSuffix: string | null;
  sessionCount: number;
  environmentId: string;
  environmentLabel: string;
  createdAt: number;
  lastActivityAt: number;
}
```

在 `src/core/store/sessions.ts` 创建普通项目 summary 时增加：

```ts
const summaries = rows.map((row) => ({
  path: row.project_path,
  label: projectLabel(row.project_path),
  labelKind: "path" as const,
  labelSuffix: null,
  sessionCount: row.session_count,
  environmentId: row.environment_id,
  environmentLabel: row.environment_label ?? localEnvironment().label,
  createdAt: row.created_at,
  lastActivityAt: row.last_activity_at,
}));
```

在现有路径标签函数附近增加后缀组合函数，后续任务继续复用：

```ts
function appendLabelSuffix(current: string | null, next: string | null): string | null {
  if (!next) return current;
  return current ? `${current} · ${next}` : next;
}
```

把现有返回映射改为基础名称与后缀分离。父目录消歧仍写入 `label`，环境消歧写入 `labelSuffix`：

```ts
return summaries
  .map((summary) => {
    const repeatedAcrossEnvironments = (environmentsByPath.get(summary.path)?.size ?? 0) > 1;
    return {
      ...summary,
      label:
        !repeatedAcrossEnvironments && (basenameCounts.get(projectBasename(summary.path)) || 0) > 1
          ? projectParentLabel(summary.path)
          : summary.label,
      labelSuffix: repeatedAcrossEnvironments
        ? appendLabelSuffix(summary.labelSuffix, summary.environmentLabel)
        : summary.labelSuffix,
    };
  })
  .sort(
    (a, b) =>
      environmentSortValue(a.environmentId) - environmentSortValue(b.environmentId) ||
      b.lastActivityAt - a.lastActivityAt ||
      a.label.localeCompare(b.label),
  );
```

在 `src/renderer/src/session-ui.ts` 增加复用展示函数：

```ts
export function projectDisplayLabel(
  project: Pick<ProjectSummary, "label" | "labelKind" | "labelSuffix">,
  language: LanguageMode,
): string {
  const base = project.labelKind === "codex-task-untitled"
    ? localize(language, "Untitled session", "未命名会话")
    : project.label;
  return project.labelSuffix ? `${base} · ${project.labelSuffix}` : base;
}
```

在 `src/renderer/src/App.tsx` 导入 `projectDisplayLabel`，并在 `selectedProject` 后计算：

```ts
const selectedProjectLabel = selectedProject ? projectDisplayLabel(selectedProject, language) : "";
```

三个展示位置统一改为：

```tsx
label: selectedProjectLabel,
```

```tsx
const searchPlaceholder = projectPath
  ? t(`Search within ${selectedProjectLabel || "project"}`, `在 ${selectedProjectLabel || "项目"} 中搜索`)
  : tag
```

```tsx
<span>{projectDisplayLabel(project, language)}</span>
```

在 `src/renderer/src/session-ui.test.ts` 增加源码约束，确保三个位置都走同一个展示函数：

```ts
it("uses the structured project label everywhere the selected project is shown", () => {
  expect(appSource).toContain('const selectedProjectLabel = selectedProject ? projectDisplayLabel(selectedProject, language) : ""');
  expect(appSource).toContain("label: selectedProjectLabel");
  expect(appSource).toContain('Search within ${selectedProjectLabel || "project"}');
  expect(appSource).toContain("projectDisplayLabel(project, language)");
});
```

更新 `src/core/session-store.test.ts` 中所有完整 `ProjectSummary` 相等断言，使普通项目包含 `labelKind: "path"` 和正确的 `labelSuffix`。

- [ ] **Step 4: 运行结构化标签测试**

Run:

```bash
npx vitest run src/core/session-store.test.ts src/renderer/src/session-ui.test.ts
npm run typecheck
```

Expected: 两个测试文件全部 PASS，TypeScript 无错误，普通项目 UI 文案保持原样。

- [ ] **Step 5: 提交无行为变化的显示契约**

```bash
git add src/core/types.ts src/core/store/sessions.ts src/core/session-store.test.ts src/renderer/src/session-ui.ts src/renderer/src/session-ui.test.ts src/renderer/src/App.tsx
git commit -m "refactor: structure project display labels"
```

---

### Task 2: 从唯一根会话生成 Codex 日期任务名称

**Files:**
- Modify: `src/core/store/sessions.ts:740-807, 1818-1834`
- Modify: `src/core/session-store.test.ts:1183-1280`

**Interfaces:**
- Consumes: Task 1 的 `ProjectSummary.labelKind` 与 `labelSuffix`。
- Produces: `listProjects()` 对唯一 `codex-app` 根会话返回 `codex-task-title` 或 `codex-task-untitled`。
- Preserves: 普通项目继续返回 `labelKind: "path"`。

- [ ] **Step 1: 写任务识别、标题优先级和降级测试**

在 `src/core/session-store.test.ts` 增加测试辅助函数：

```ts
function projectByPath(store: SessionStore, projectPath: string) {
  const project = store.listProjects().find((item) => item.path === projectPath);
  expect(project).toBeDefined();
  return project!;
}
```

增加主行为测试：

```ts
it("labels a Codex App dated task workspace from its unique root session", () => {
  const store = createInMemoryStore();
  const taskPath = "/Users/me/Documents/Codex/2026-07-18/https-example-com-wiki-token";
  store.upsertIndexedSession(
    sampleSession({
      sessionKey: "codex:task-root",
      rawId: "task-root",
      source: "codex-app",
      projectPath: taskPath,
      originalTitle: "Hermes 重写",
      firstQuestion: "https://example.com/wiki/token",
      isSubagent: false,
    }),
    messages,
  );
  store.upsertIndexedSession(
    sampleSession({
      sessionKey: "codex:task-child",
      rawId: "task-child",
      source: "codex-app",
      projectPath: taskPath,
      originalTitle: "worker-1",
      firstQuestion: "worker prompt",
      isSubagent: true,
      parentSessionId: "task-root",
    }),
    messages,
  );

  expect(projectByPath(store, taskPath)).toMatchObject({
    label: "Hermes 重写",
    labelKind: "codex-task-title",
    labelSuffix: null,
  });

  store.setCustomTitle("codex:task-root", "Hermes 教程重写");
  expect(projectByPath(store, taskPath).label).toBe("Hermes 教程重写");

  store.upsertIndexedSession(
    sampleSession({
      sessionKey: "codex:task-root",
      rawId: "task-root",
      source: "codex-app",
      projectPath: taskPath,
      originalTitle: "重新索引后的原生标题",
      firstQuestion: "https://example.com/wiki/token",
      isSubagent: false,
    }),
    messages,
  );
  expect(projectByPath(store, taskPath).label).toBe("Hermes 教程重写");

  store.setCustomTitle("codex:task-root", null);
  expect(projectByPath(store, taskPath).label).toBe("重新索引后的原生标题");
});
```

增加边界测试：

```ts
it("recognizes Windows task paths but rejects invalid dates, normal projects, and multiple roots", () => {
  const store = createInMemoryStore();
  const windowsTask = "C:\\Users\\me\\Documents\\cOdEx\\2026-07-18\\new-chat";
  const invalidDate = "/Users/me/Documents/Codex/2026-02-30/new-chat";
  const normalRepo = "/Users/me/work/agent-recall";
  const multipleRoots = "/Users/me/Documents/Codex/2026-07-19/shared";
  const cliTask = "/Users/me/Documents/Codex/2026-07-19/cli-task";

  store.upsertIndexedSession(sampleSession({ sessionKey: "codex:win", rawId: "win", source: "codex-app", projectPath: windowsTask, originalTitle: "Windows 任务" }), messages);
  store.upsertIndexedSession(sampleSession({ sessionKey: "codex:bad-date", rawId: "bad-date", source: "codex-app", projectPath: invalidDate, originalTitle: "无效日期" }), messages);
  store.upsertIndexedSession(sampleSession({ sessionKey: "codex:repo", rawId: "repo", source: "codex-app", projectPath: normalRepo, originalTitle: "普通项目对话" }), messages);
  store.upsertIndexedSession(sampleSession({ sessionKey: "codex:root-a", rawId: "root-a", source: "codex-app", projectPath: multipleRoots, originalTitle: "根 A" }), messages);
  store.upsertIndexedSession(sampleSession({ sessionKey: "codex:root-b", rawId: "root-b", source: "codex-app", projectPath: multipleRoots, originalTitle: "根 B" }), messages);
  store.upsertIndexedSession(sampleSession({ sessionKey: "codex:cli", rawId: "cli", source: "codex-cli", projectPath: cliTask, originalTitle: "CLI 任务" }), messages);

  expect(projectByPath(store, windowsTask)).toMatchObject({ label: "Windows 任务", labelKind: "codex-task-title" });
  expect(projectByPath(store, invalidDate)).toMatchObject({ label: "new-chat", labelKind: "path" });
  expect(projectByPath(store, normalRepo)).toMatchObject({ label: "agent-recall", labelKind: "path" });
  expect(projectByPath(store, multipleRoots)).toMatchObject({ label: "shared", labelKind: "path" });
  expect(projectByPath(store, cliTask)).toMatchObject({ label: "cli-task", labelKind: "path" });
});
```

增加原生标题缺失时的首条问题回退：

```ts
it("falls back to the root first question when no usable native title exists", () => {
  const store = createInMemoryStore();
  const taskPath = "/Users/me/Documents/Codex/2026-07-19/question-fallback";
  store.upsertIndexedSession(
    sampleSession({
      sessionKey: "codex:question-fallback",
      rawId: "question-fallback",
      source: "codex-app",
      projectPath: taskPath,
      originalTitle: "Untitled Session",
      firstQuestion: "分析 AgentRecall 项目名称",
    }),
    messages,
  );

  expect(projectByPath(store, taskPath)).toMatchObject({
    label: "分析 AgentRecall 项目名称",
    labelKind: "codex-task-title",
    labelSuffix: null,
  });
});
```

增加未命名降级测试，使用本地构造时间避免 CI 时区差异：

```ts
it("uses a localized-ready untitled label with the root creation time", () => {
  const store = createInMemoryStore();
  const timestamp = new Date(2026, 6, 19, 19, 25).getTime();
  const taskPath = "/Users/me/Documents/Codex/2026-07-19/new-chat";
  store.upsertIndexedSession(
    sampleSession({
      sessionKey: "codex:untitled",
      rawId: "untitled",
      source: "codex-app",
      projectPath: taskPath,
      originalTitle: "Untitled Session",
      firstQuestion: "",
      timestamp,
    }),
    [],
  );

  expect(projectByPath(store, taskPath)).toMatchObject({
    label: "Untitled session",
    labelKind: "codex-task-untitled",
    labelSuffix: "07-19 19:25",
  });
});
```

- [ ] **Step 2: 运行测试并确认仍显示目录 basename**

Run:

```bash
npx vitest run src/core/session-store.test.ts
```

Expected: 新测试 FAIL；任务项目仍返回 URL/code slug 或 `labelKind: "path"`。

- [ ] **Step 3: 扩展项目聚合查询并实现识别规则**

在 `src/core/store/sessions.ts` 的项目聚合 SELECT 中加入：

```sql
SUM(CASE WHEN sessions.is_subagent = 0 THEN 1 ELSE 0 END) AS root_count,
MAX(CASE WHEN sessions.is_subagent = 0 THEN sessions.source END) AS root_source,
MAX(CASE WHEN sessions.is_subagent = 0 THEN sessions.custom_title END) AS root_custom_title,
MAX(CASE WHEN sessions.is_subagent = 0 THEN sessions.original_title END) AS root_original_title,
MAX(CASE WHEN sessions.is_subagent = 0 THEN sessions.first_question END) AS root_first_question,
MAX(CASE WHEN sessions.is_subagent = 0 THEN sessions.timestamp END) AS root_created_at,
```

把查询结果类型补成：

```ts
type ProjectAggregateRow = {
  project_path: string;
  environment_id: string;
  environment_label: string | null;
  session_count: number;
  created_at: number;
  last_activity_at: number;
  root_count: number;
  root_source: SessionSource | null;
  root_custom_title: string | null;
  root_original_title: string | null;
  root_first_question: string | null;
  root_created_at: number | null;
};
```

在现有 `projectParts()` 附近加入非导出领域函数：

```ts
function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function codexTaskWorkspaceDate(projectPath: string): string | null {
  const parts = projectParts(projectPath);
  if (parts.length < 3) return null;
  const codexSegment = parts.at(-3) || "";
  const dateSegment = parts.at(-2) || "";
  const taskSegment = parts.at(-1) || "";
  if (codexSegment.toLowerCase() !== "codex" || !taskSegment || !validIsoDate(dateSegment)) return null;
  return dateSegment;
}

function rootProjectTitle(row: ProjectAggregateRow): string | null {
  const customTitle = row.root_custom_title?.trim();
  if (customTitle) return customTitle;
  const originalTitle = row.root_original_title?.trim();
  if (originalTitle && originalTitle !== "Untitled Session") return originalTitle;
  return row.root_first_question?.trim() || null;
}

function formatMonthDayTime(timestamp: number | null): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
```

项目 mapping 使用唯一根会话决定基础名称：

```ts
const taskDate = row.root_count === 1 && row.root_source === "codex-app"
  ? codexTaskWorkspaceDate(row.project_path)
  : null;
const rootTitle = rootProjectTitle(row);
const untitled = !rootTitle;
const taskWorkspace = taskDate !== null;

return {
  path: row.project_path,
  label: taskWorkspace ? (rootTitle || "Untitled session") : projectLabel(row.project_path),
  labelKind: taskWorkspace ? (untitled ? "codex-task-untitled" : "codex-task-title") : "path",
  labelSuffix: null,
  sessionCount: row.session_count,
  environmentId: row.environment_id,
  environmentLabel: row.environment_label ?? localEnvironment().label,
  createdAt: row.created_at,
  lastActivityAt: row.last_activity_at,
  taskWorkspaceDate: taskDate,
  rootCreatedAt: row.root_created_at ?? 0,
};
```

将 mapping 的内部结果声明为 `ProjectSummaryDraft`，在返回前移除 `taskWorkspaceDate` 和 `rootCreatedAt`，防止内部消歧字段泄漏到 IPC：

```ts
type ProjectSummaryDraft = ProjectSummary & {
  taskWorkspaceDate: string | null;
  rootCreatedAt: number;
};

function publicProjectSummary(draft: ProjectSummaryDraft): ProjectSummary {
  return {
    path: draft.path,
    label: draft.label,
    labelKind: draft.labelKind,
    labelSuffix: draft.labelSuffix,
    sessionCount: draft.sessionCount,
    environmentId: draft.environmentId,
    environmentLabel: draft.environmentLabel,
    createdAt: draft.createdAt,
    lastActivityAt: draft.lastActivityAt,
  };
}
```

Task 1 的父目录 basename 消歧只处理 `labelKind === "path"`；环境后缀仍可用于所有 label kind。环境后缀处理完成后，对 `labelKind === "codex-task-untitled"` 的 draft 调用 `appendLabelSuffix(draft.labelSuffix, formatMonthDayTime(draft.rootCreatedAt))`，从而保持“环境、日期时间”的后缀顺序。最终返回前调用 `.map(publicProjectSummary)`。

- [ ] **Step 4: 运行任务识别测试**

Run:

```bash
npx vitest run src/core/session-store.test.ts
npm run typecheck
```

Expected: 新增任务识别、Windows、无效日期、多个根会话、自定义标题和未命名测试全部 PASS。

- [ ] **Step 5: 提交任务名称推导**

```bash
git add src/core/store/sessions.ts src/core/session-store.test.ts
git commit -m "feat: label Codex task workspaces from root sessions"
```

---

### Task 3: 对重复任务标题进行日期和时间消歧

**Files:**
- Modify: `src/core/store/sessions.ts:740-830, 1818-1870`
- Modify: `src/core/session-store.test.ts:1183-1320`

**Interfaces:**
- Consumes: Task 2 的内部 `ProjectSummaryDraft.taskWorkspaceDate` 和 `rootCreatedAt`。
- Produces: 同一环境内重复任务标题的 `labelSuffix`。
- Preserves: 普通项目 basename、父目录和环境消歧。

- [ ] **Step 1: 写日期、时间和 basename 消歧失败测试**

增加三个同名任务，其中两个在同一天：

```ts
it("disambiguates duplicate Codex task titles by date and time", () => {
  const store = createInMemoryStore();
  const cases = [
    ["/Users/me/Documents/Codex/2026-07-18/task-a", new Date(2026, 6, 18, 9, 0).getTime()],
    ["/Users/me/Documents/Codex/2026-07-19/task-b", new Date(2026, 6, 19, 10, 32).getTime()],
    ["/Users/me/Documents/Codex/2026-07-19/task-c", new Date(2026, 6, 19, 16, 48).getTime()],
  ] as const;
  cases.forEach(([projectPath, timestamp], index) => {
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: `codex:duplicate-${index}`,
        rawId: `duplicate-${index}`,
        source: "codex-app",
        projectPath,
        originalTitle: "调研 OpenCode",
        timestamp,
      }),
      messages,
    );
  });

  expect(cases.map(([projectPath]) => projectByPath(store, projectPath).labelSuffix)).toEqual([
    "07-18",
    "07-19 10:32",
    "07-19 16:48",
  ]);
});
```

增加同一分钟最终回退：

```ts
it("uses the task directory basename when duplicate task labels still collide", () => {
  const store = createInMemoryStore();
  const timestamp = new Date(2026, 6, 19, 10, 32).getTime();
  for (const slug of ["task-a", "task-b"]) {
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: `codex:${slug}`,
        rawId: slug,
        source: "codex-app",
        projectPath: `/Users/me/Documents/Codex/2026-07-19/${slug}`,
        originalTitle: "同名任务",
        timestamp,
      }),
      messages,
    );
  }

  expect(projectByPath(store, "/Users/me/Documents/Codex/2026-07-19/task-a").labelSuffix).toBe("07-19 10:32 · task-a");
  expect(projectByPath(store, "/Users/me/Documents/Codex/2026-07-19/task-b").labelSuffix).toBe("07-19 10:32 · task-b");
});
```

增加同一路径跨环境的任务名称测试，确保环境后缀优先且不会触发日期消歧：

```ts
it("keeps environment suffixes ahead of task-title collision handling", () => {
  const store = createInMemoryStore();
  store.upsertEnvironment({
    id: "ssh-devbox",
    kind: "ssh",
    label: "devbox",
    hostAlias: "devbox",
    host: "devbox.example.com",
    user: null,
    port: null,
    authMode: "none",
    identityFile: null,
    enabled: true,
  });
  const projectPath = "/Users/me/Documents/Codex/2026-07-19/shared-task";
  store.upsertIndexedSession(sampleSession({ sessionKey: "codex:local-task", rawId: "local-task", source: "codex-app", projectPath, originalTitle: "共享任务" }), messages);
  store.upsertIndexedSession(
    sampleSession({
      sessionKey: "ssh:ssh-devbox:codex-app:remote-task",
      rawId: "remote-task",
      source: "codex-app",
      projectPath,
      originalTitle: "共享任务",
      environmentId: "ssh-devbox",
      environmentKind: "ssh",
      environmentLabel: "devbox",
    }),
    messages,
  );

  expect(store.listProjects().map(({ environmentId, labelSuffix }) => ({ environmentId, labelSuffix }))).toEqual([
    { environmentId: "local", labelSuffix: "Local" },
    { environmentId: "ssh-devbox", labelSuffix: "devbox" },
  ]);
});
```

- [ ] **Step 2: 运行测试并确认重复标题尚未消歧**

Run:

```bash
npx vitest run src/core/session-store.test.ts
```

Expected: 新测试 FAIL；三个 `labelSuffix` 仍为 `null`。

- [ ] **Step 3: 实现确定性消歧**

在 `src/core/store/sessions.ts` 增加：

```ts
function normalizedProjectTitle(value: string): string {
  return value.trim().toLowerCase();
}

function formatMonthDay(taskDate: string): string {
  return taskDate.slice(5);
}

function formatClock(timestamp: number): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function disambiguateTaskLabels(summaries: ProjectSummaryDraft[]): ProjectSummaryDraft[] {
  const titleGroups = new Map<string, ProjectSummaryDraft[]>();
  for (const summary of summaries) {
    if (summary.labelKind !== "codex-task-title") continue;
    const key = `${summary.environmentId}\0${normalizedProjectTitle(summary.label)}`;
    const group = titleGroups.get(key) ?? [];
    group.push(summary);
    titleGroups.set(key, group);
  }

  const withTimeSuffixes = summaries.map((summary) => ({ ...summary }));
  const byIdentity = new Map(withTimeSuffixes.map((summary) => [`${summary.environmentId}\0${summary.path}`, summary]));
  for (const group of titleGroups.values()) {
    if (group.length < 2) continue;
    const dateCounts = new Map<string, number>();
    for (const summary of group) {
      const date = summary.taskWorkspaceDate || "";
      dateCounts.set(date, (dateCounts.get(date) || 0) + 1);
    }
    for (const summary of group) {
      const target = byIdentity.get(`${summary.environmentId}\0${summary.path}`)!;
      const date = summary.taskWorkspaceDate;
      const clock = formatClock(summary.rootCreatedAt);
      const suffix = date
        ? (dateCounts.get(date) || 0) > 1 && clock
          ? `${formatMonthDay(date)} ${clock}`
          : formatMonthDay(date)
        : projectBasename(summary.path);
      target.labelSuffix = appendLabelSuffix(target.labelSuffix, suffix);
    }
  }

  const finalGroups = new Map<string, ProjectSummaryDraft[]>();
  for (const summary of withTimeSuffixes) {
    if (!summary.labelKind.startsWith("codex-task")) continue;
    const rendered = `${normalizedProjectTitle(summary.label)}\0${summary.labelSuffix || ""}`;
    const key = `${summary.environmentId}\0${rendered}`;
    const group = finalGroups.get(key) ?? [];
    group.push(summary);
    finalGroups.set(key, group);
  }
  for (const group of finalGroups.values()) {
    if (group.length < 2) continue;
    for (const summary of group) {
      summary.labelSuffix = appendLabelSuffix(summary.labelSuffix, projectBasename(summary.path));
    }
  }
  return withTimeSuffixes;
}
```

在 `listProjects()` 中先应用现有路径/环境消歧，再调用 `disambiguateTaskLabels()`，最后 `.map(publicProjectSummary)` 和排序。环境后缀不得加入同一环境标题的分组 key。

- [ ] **Step 4: 运行项目聚合测试**

Run:

```bash
npx vitest run src/core/session-store.test.ts src/core/store/sessions.test.ts
npm run typecheck
```

Expected: 日期、时间、basename、普通路径和跨环境项目测试全部 PASS。

- [ ] **Step 5: 提交重名消歧**

```bash
git add src/core/store/sessions.ts src/core/session-store.test.ts
git commit -m "feat: disambiguate duplicate Codex task labels"
```

---

### Task 4: 重命名后立即刷新项目树

**Files:**
- Modify: `src/renderer/src/App.tsx:1274-1298`
- Modify: `src/renderer/src/app-loading.test.ts:1-90`

**Interfaces:**
- Consumes: 现有 `refreshAfterAction({ metadata?: boolean; stats?: boolean })`。
- Produces: 成功设置或清空根会话 `customTitle` 后，同一操作刷新 `listProjects()`。

- [ ] **Step 1: 写重命名刷新失败测试**

在 `src/renderer/src/app-loading.test.ts` 增加：

```ts
it("refreshes sidebar metadata after a session title changes", () => {
  const submitDialogBlock = sourceBlock("async function submitDialog", [
    "async function removeTag",
  ]);
  expect(submitDialogBlock).toContain('dialogKind === "rename" || (dialogKind === "tag" && Boolean(value))');
  expect(submitDialogBlock).toContain("refreshAfterAction({ metadata:");
});
```

- [ ] **Step 2: 运行测试并确认 rename 尚未刷新 metadata**

Run:

```bash
npx vitest run src/renderer/src/app-loading.test.ts
```

Expected: FAIL；当前条件只在新增 tag 时传入 `metadata: true`。

- [ ] **Step 3: 扩展现有提交逻辑**

在 `src/renderer/src/App.tsx` 保持写入成功后再关闭对话框，并把刷新条件改为：

```ts
setDialog(null);
await refreshAfterAction({
  metadata: dialogKind === "rename" || (dialogKind === "tag" && Boolean(value)),
});
```

不新增单独的项目重命名处理器。清空输入时 `setCustomTitle(..., null)` 成功后同样进入 metadata 刷新。

- [ ] **Step 4: 运行渲染器相关测试**

Run:

```bash
npx vitest run src/renderer/src/app-loading.test.ts src/renderer/src/session-ui.test.ts src/core/session-title-sync.test.ts
npm run typecheck
```

Expected: 全部 PASS；终端标题同步测试继续通过。

- [ ] **Step 5: 提交即时刷新**

```bash
git add src/renderer/src/App.tsx src/renderer/src/app-loading.test.ts
git commit -m "fix: refresh project labels after session rename"
```

---

### Task 5: 发布说明与完整验证

**Files:**
- Create: `.release-notes/codex-task-workspace-labels.md`
- Verify: all files changed since `main`

**Interfaces:**
- Produces: 唯一一份面向用户的 Bug 修复发布说明。
- Produces: 可提交审查的完整功能分支。

- [ ] **Step 1: 添加发布说明**

创建 `.release-notes/codex-task-workspace-labels.md`：

```markdown
# Codex App 任务名称更易读

## Bug 修复

- Codex App 自动创建的任务工作区现在显示可读的会话名称，查找和切换历史任务更加直观。
```

- [ ] **Step 2: 校验发布说明范围和产品文案**

Run:

```bash
node scripts/release-notes.mjs check-file .release-notes/codex-task-workspace-labels.md
npm run release-note:check
```

Expected:

```text
.release-notes/codex-task-workspace-labels.md: 0 feature(s), 1 fix(es)
```

`release-note:check` 识别从 `origin/main` 到当前分支恰好一份新增发布说明并退出 0。

- [ ] **Step 3: 运行针对性测试和静态检查**

Run:

```bash
npx vitest run src/core/session-store.test.ts src/core/store/sessions.test.ts src/renderer/src/session-ui.test.ts src/renderer/src/app-loading.test.ts src/core/session-title-sync.test.ts
npm run typecheck
git diff --check main...HEAD
```

Expected: 所有测试 PASS，TypeScript 和 diff whitespace 检查退出 0。

- [ ] **Step 4: 构建 MCP bundle 并运行完整测试**

Run:

```bash
npm run build:mcp
npm test
```

Expected: Vitest 与 `scripts/*.test.mjs` 全部 PASS。若沙箱禁止测试监听 `127.0.0.1`，按仓库批准流程在非沙箱环境原样重跑 `npm test`；不要修改测试来绕过权限。

- [ ] **Step 5: 检查最终范围并提交发布说明**

Run:

```bash
git status --short
git diff --stat main...HEAD
git diff main...HEAD -- .release-notes/codex-task-workspace-labels.md
```

Expected: 只包含本计划列出的源码、测试、设计、计划和唯一发布说明；`node_modules/` 与 `out/` 不被跟踪。

```bash
git add .release-notes/codex-task-workspace-labels.md
git commit -m "docs: add Codex task label release note"
```

---

## Final Acceptance Checklist

- [ ] 真实目录路径和 Codex JSONL 从未被写入或移动。
- [ ] URL、代码片段和短文本 slug 的合成任务目录显示唯一根会话标题。
- [ ] 手动名称优先，清空后回退到 Codex 原生标题或首条有效问题。
- [ ] subagent 不参与命名；没有唯一根会话时回退路径名称。
- [ ] 普通项目、其他来源、路径筛选、Resume 与跨环境行为无回归。
- [ ] 重复标题按日期、时间、basename 稳定消歧。
- [ ] 中文与英文未命名占位符在项目树、筛选标签和搜索提示中一致。
- [ ] `npm run build:mcp`、`npm run typecheck`、`npm test`、`npm run release-note:check` 全部退出 0。
- [ ] 分支相对 `main` 恰好新增一份用户可见发布说明。
