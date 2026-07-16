# Sync Setup Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinguish Electron development builds from installed releases, give first-time and repair-time Supabase guidance with direct SQL Editor access, and make session/Skills sync controls use the available dialog space cleanly.

**Architecture:** Add pure Supabase setup helpers in core, expose copy/open actions through main/preload IPC, and reuse a small renderer setup-guide component in Settings and both sync dialogs. Keep packaged update behavior unchanged while returning a development-only update status from Electron dev mode. Use CSS grid/flex contracts for a single desktop toolbar row and viewport-bound dialog height.

**Tech Stack:** TypeScript, Electron IPC, React 19, Vitest, CSS, Supabase Postgres/Storage setup SQL.

## Global Constraints

- Do not access or mutate the developer's real Supabase project, Skills, sessions, npm prefix, or Electron installation.
- Setup SQL must remain idempotent and include explicit grants plus RLS policies.
- Only packaged Electron builds may check or install GitHub Releases; the CLI updater remains unchanged.
- Existing branch release notes remain the single user-facing release-note source and must be updated rather than adding a second note.
- Desktop toolbars stay on one row where space permits; narrow windows wrap whole controls without compressing labels.

---

### Task 1: Supabase Setup Helpers and IPC

**Files:**
- Create: `src/core/supabase-setup.ts`
- Create: `src/core/supabase-setup.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/skill-sync-ipc.test.ts`

**Interfaces:**
- Produces: `buildCombinedSupabaseSetupSql(): string`
- Produces: `supabaseSqlEditorUrl(projectUrl?: string): string`
- Produces renderer API: `copyCombinedSyncSetupSql(): Promise<void>` and `openSupabaseSqlEditor(target: "sessions" | "skills"): Promise<void>`

- [ ] **Step 1: Write failing pure helper tests**

```ts
expect(buildCombinedSupabaseSetupSql()).toContain("agent_session_remote_sessions");
expect(buildCombinedSupabaseSetupSql()).toContain("agent_recall_skills");
expect(supabaseSqlEditorUrl("https://abc.supabase.co")).toBe(
  "https://supabase.com/dashboard/project/abc/sql/new",
);
expect(supabaseSqlEditorUrl("invalid")).toBe("https://supabase.com/dashboard/projects");
```

- [ ] **Step 2: Run `npx vitest run src/core/supabase-setup.test.ts` and verify it fails because the module does not exist**

- [ ] **Step 3: Implement the pure helpers**

```ts
export function buildCombinedSupabaseSetupSql(): string {
  return [
    "-- AgentRecall remote sessions",
    buildRemoteSessionSetupSql(),
    "-- AgentRecall Skills",
    buildSkillSyncSetupSql(),
  ].join("\n\n");
}

export function supabaseSqlEditorUrl(projectUrl = ""): string {
  try {
    const parsed = new URL(projectUrl.trim());
    const match = /^([a-z0-9-]+)\.supabase\.co$/i.exec(parsed.hostname);
    return parsed.protocol === "https:" && match
      ? `https://supabase.com/dashboard/project/${match[1]}/sql/new`
      : "https://supabase.com/dashboard/projects";
  } catch {
    return "https://supabase.com/dashboard/projects";
  }
}
```

- [ ] **Step 4: Run the helper tests and verify they pass**

- [ ] **Step 5: Add failing IPC contract assertions for `supabase:copy-combined-setup-sql` and `supabase:open-sql-editor`**

- [ ] **Step 6: Run `npx vitest run src/main/skill-sync-ipc.test.ts` and verify the new assertions fail**

- [ ] **Step 7: Register IPC handlers and preload methods**

```ts
ipcMain.handle("supabase:copy-combined-setup-sql", () => {
  clipboard.writeText(buildCombinedSupabaseSetupSql());
});
ipcMain.handle("supabase:open-sql-editor", (_event, target: "sessions" | "skills") => {
  const settings = getSettings();
  const projectUrl = target === "skills" ? settings.skillSyncSupabaseUrl : settings.remoteSyncSupabaseUrl;
  return shell.openExternal(supabaseSqlEditorUrl(projectUrl));
});
```

- [ ] **Step 8: Run helper and IPC tests and verify they pass**

### Task 2: Development Build Update State

**Files:**
- Modify: `src/core/app-update-types.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/app-update-ipc.test.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/app-update-ui.test.ts`

**Interfaces:**
- Extends `AppUpdateStatus` with `developmentBuild: boolean`.
- `getAppUpdateStatus()` returns a local development status when `app.isPackaged === false`.

- [ ] **Step 1: Add failing source-contract tests**

```ts
expect(mainSource).toContain("if (!app.isPackaged) return developmentAppUpdateStatus()");
expect(mainSource).toContain('throw new Error("Application updates are unavailable in development builds.")');
expect(appSource).toContain("appUpdateStatus?.developmentBuild");
expect(appSource).toContain('l("Development build", "开发版本")');
```

- [ ] **Step 2: Run update IPC/UI tests and verify the assertions fail**

- [ ] **Step 3: Implement development status and guards**

```ts
function developmentAppUpdateStatus(): AppUpdateStatus {
  return {
    currentVersion: loadUpdateClient().currentVersion(),
    developmentBuild: true,
    checkedAt: 0,
    fromCache: false,
    updateAvailable: false,
    manifest: null,
    error: null,
  };
}
```

Packaged checks add `developmentBuild: false`; dev mode skips startup checks and install attempts.

- [ ] **Step 4: Render a compact development state on About and hide check/install/automatic-check controls**

- [ ] **Step 5: Run update IPC/UI tests and typecheck**

### Task 3: Shared Setup Guidance

**Files:**
- Create: `src/renderer/src/components/supabase-setup-guide.tsx`
- Create: `src/renderer/src/supabase-setup-guide.test.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/skills-dialog.tsx`
- Modify: `src/renderer/src/components/remote-sessions-dialog.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Produces `SupabaseSetupGuide` with localized copy and callbacks for copy, open, and optional refresh.
- Skills dialog accepts `onOpenSqlEditor: () => void`.
- Settings uses combined SQL copy and the feature-appropriate project link.

- [ ] **Step 1: Write failing renderer contract tests**

```ts
expect(guideSource).toContain("Copy latest SQL");
expect(guideSource).toContain("Open SQL Editor");
expect(guideSource).toContain("Run the SQL, then refresh");
expect(appSource).toContain("copyCombinedSyncSetupSql");
expect(appSource).toContain("openSupabaseSqlEditor");
```

- [ ] **Step 2: Run the guide test and verify it fails because the component/actions do not exist**

- [ ] **Step 3: Implement `SupabaseSetupGuide`**

```tsx
<div className={`supabase-setup-guide ${tone}`}>
  <div className="supabase-setup-copy">
    <strong>{title}</strong>
    <span>{message}</span>
    {detail ? <code>{detail}</code> : null}
  </div>
  <div className="supabase-setup-actions">
    <button onClick={onCopySql}><Copy size={14} />{l("Copy latest SQL", "复制最新 SQL")}</button>
    <button onClick={onOpenSqlEditor}><ExternalLink size={14} />{l("Open SQL Editor", "打开 SQL Editor")}</button>
    {onRefresh ? <button onClick={onRefresh}><RefreshCw size={14} />{l("Refresh", "刷新")}</button> : null}
  </div>
</div>
```

- [ ] **Step 4: Replace raw dialog errors with the shared guide and keep technical errors secondary**

- [ ] **Step 5: Add first-time combined setup guides to Remote sync and Skills settings**

- [ ] **Step 6: Run guide tests and typecheck**

### Task 4: Toolbar and Dialog Layout

**Files:**
- Modify: `src/renderer/src/components/skills-dialog.tsx`
- Modify: `src/renderer/src/components/remote-sessions-dialog.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/style-contract.test.ts`

**Interfaces:**
- Session toolbar contains search, source filter, selection, upload, delete, refresh in one DOM container.
- Skills toolbar pins refresh as the final action.

- [ ] **Step 1: Add failing style/structure assertions**

```ts
expect(remoteDialogSource).not.toContain('className="remote-selection-bar"');
expect(remoteDialogSource).toContain('className="remote-select-visible"');
expect(remoteDialog).toMatch(/height:\s*min\(88vh,/);
expect(remoteList).toMatch(/flex:\s*1/);
expect(skillsToolbar).toMatch(/flex-wrap:\s*nowrap/);
```

- [ ] **Step 2: Run style tests and verify the layout assertions fail**

- [ ] **Step 3: Move session selection/actions into the top toolbar and place refresh last**

- [ ] **Step 4: Give the session dialog `height: min(88vh, 860px)`, a viewport cap, and a flexing scrollable list**

- [ ] **Step 5: Keep Skills toolbar on one row at desktop widths and add grouped narrow-window wrapping**

- [ ] **Step 6: Run style, renderer, and typecheck tests**

### Task 5: Release Copy and Full Verification

**Files:**
- Modify: `.release-notes/stabilize-sync-experience.md`
- Modify if user instructions changed: `README.md`, `docs/README.en.md`

**Interfaces:**
- Keeps exactly one release note for this branch.

- [ ] **Step 1: Update the existing release note with the visible setup guidance and layout outcome**

```md
- 🧭 首次配置或同步结构需要更新时，可直接复制最新配置并打开对应的设置页面执行，完成后原地刷新即可继续。
```

- [ ] **Step 2: Run `npm run release-note:check`**

- [ ] **Step 3: Run `npm test`**

- [ ] **Step 4: Run `npm run typecheck`**

- [ ] **Step 5: Run `npm run build`**

- [ ] **Step 6: Confirm no Electron process, generated archive, temporary HOME, update lock, or test fixture remains**
