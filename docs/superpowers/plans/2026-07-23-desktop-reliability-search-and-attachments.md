# Desktop Reliability, Quick Search, and Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver reliable Codex quota display, visible staged updates, macOS quick search and Dock control, local attachment viewing, default remote attachment sync, and direct README mirror guidance in the existing MR.

**Architecture:** Keep each lifecycle boundary in a focused service: `QuotaService`, staged updater, `QuickSearchWindowController`, and `AttachmentService`. Shared Zod IPC contracts expose safe IDs and state objects; renderer code never receives credentials, arbitrary filesystem paths, npm commands, or storage keys. The existing Cursor Remote classification remains intact, and all work continues on `codex/fix-cursor-remote-environments`.

**Tech Stack:** Electron 42, TypeScript 5.7, React 19, electron-vite, node:sqlite, electron-store, Vitest, Node test runner, Supabase REST/Storage APIs.

## Global Constraints

- Do not create another development branch or another release-note file.
- Keep exactly one release note at `.release-notes/fix-cursor-remote-environments.md`.
- Node low-version compatibility is out of scope.
- `showInDock` defaults to `true`; the setting is visible only on macOS.
- `syncSessionAttachments` defaults to `true` and applies only when remote session sync is enabled.
- Only explicit, safely resolved attachment blocks may be read or uploaded; message text and tool paths are never attachment authority.
- Limit attachments to 25 MiB each and 100 MiB per session.
- Use temporary HOME, npm prefix, database, session fixtures, and Supabase fixtures for all tests.
- Validate macOS and Windows paths; do not leave child processes, update locks, archives, databases, or Electron windows behind.
- Update downloads show real byte progress; npm staging and Electron validation show honest phase progress, never fabricated percentages.

---

## File Structure

### Quota

- Create `src/main/services/quota-service.ts`: retry, cache, auth identity watching, status publication.
- Create `src/main/services/quota-service.test.ts`: deterministic service tests with fake clock, loader, watcher, and cache.
- Create `src/shared/ipc/quota.ts`: typed request/event channel contract.
- Create `src/preload/quota.ts`: renderer quota API.
- Create `src/main/ipc/quota.ts`: quota handler registration.
- Create `src/main/quota-ipc.test.ts`: IPC and preload contract tests.
- Modify `src/core/types.ts`: quota freshness and failure metadata.
- Modify `src/core/quota.ts`: normalized error classification and injectable request timeout.
- Modify `src/core/quota.test.ts`: transient/auth error classification.
- Modify `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, and `src/renderer/src/styles.css`: service lifecycle and stale UI.

### Updates

- Modify `src/core/app-update-types.ts`: update phase/progress types.
- Modify `bin/update-client.cjs`: streaming download, staged npm install, validation, safe progress callbacks.
- Modify `bin/apply-update.cjs`: final package swap and rollback from a validated stage.
- Modify `src/main/services/app-update-service.ts`: progress state machine and staged installer lifecycle.
- Modify `src/shared/ipc/app-update.ts`, `src/preload/app-update.ts`, and `src/main/ipc/app-update.ts`: progress event contract.
- Create `src/renderer/src/features/settings/update-progress.tsx`: dedicated update progress content.
- Modify `src/renderer/src/features/settings/settings-dialog.tsx`, `src/renderer/src/App.tsx`, and `src/renderer/src/styles.css`: update window presentation.
- Modify `scripts/update-client.test.mjs`, `scripts/apply-update.test.mjs`, `src/main/services/app-update-service.test.ts`, `src/main/app-update-ipc.test.ts`, and `src/renderer/src/app-update-ui.test.ts`.

### macOS quick search and Dock

- Create `src/main/services/quick-search-window.ts`: window creation, positioning, reuse, and result handoff.
- Create `src/main/services/quick-search-window.test.ts`: controller lifecycle tests.
- Create `src/shared/ipc/quick-search.ts`: open-session IPC contract.
- Create `src/preload/quick-search.ts`: quick-search renderer API.
- Create `src/renderer/quick-search.html`: independent renderer entry.
- Create `src/renderer/src/quick-search-main.tsx`: entry bootstrap.
- Create `src/renderer/src/quick-search.tsx`: eight-result keyboard search UI.
- Create `src/renderer/src/quick-search.css`: compact window styles.
- Create `src/renderer/src/quick-search.test.tsx`: model and contract tests without launching Electron.
- Modify `electron.vite.config.ts`, `src/core/platform.ts`, `src/core/platform.test.ts`, `src/main/index.ts`, `src/preload/index.ts`, and `src/renderer/src/features/settings/settings-dialog.tsx`.

### Attachments

- Create `src/core/session-attachments.ts`: explicit attachment parsing, MIME classification, limits, safe-source policy.
- Create `src/core/session-attachments.test.ts`: inline, file, unsafe path, symlink, and limit tests.
- Create `src/core/store/attachments.ts`: attachment metadata persistence.
- Create `src/core/store/attachments.test.ts`: storage CRUD and reference tests.
- Create `src/main/services/attachment-service.ts`: managed content cache, preview/open, remote lazy download.
- Create `src/main/services/attachment-service.test.ts`: cache and path authorization tests.
- Create `src/shared/ipc/attachments.ts`, `src/preload/attachments.ts`, `src/main/ipc/attachments.ts`, and `src/main/attachments-ipc.test.ts`.
- Create `src/renderer/src/features/session-detail/session-attachments.tsx`: cards and preview dialog.
- Create `src/renderer/src/session-attachments-ui.test.ts`: attachment UI contract tests.
- Modify `src/core/types.ts`, `src/core/format-adapters.ts`, `src/core/format-adapters.test.ts`, `src/core/session-loader.ts`, loader tests, `src/core/indexer.ts`, `src/core/session-store.ts`, `src/core/store/schema.ts`, `src/core/store/schema.test.ts`, and `src/core/store/sessions.ts`.
- Modify `src/core/remote-session-sync.ts`, `src/core/remote-session-sync.test.ts`, `src/main/services/remote-session-service.ts`, its tests, and the remote IPC/preload files.
- Modify `src/renderer/src/features/session-detail/detail-panel.tsx`, `src/renderer/src/App.tsx`, and `src/renderer/src/styles.css`.

### Documentation and release

- Modify `README.md`: direct mirror command and precise scope note.
- Modify `.release-notes/fix-cursor-remote-environments.md`: one user-facing note covering all delivered behavior.

---

### Task 1: Normalize quota errors and define quota state

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/quota.ts`
- Test: `src/core/quota.test.ts`

**Interfaces:**
- Produces: `UsageQuotaSnapshot.freshness`, `UsageQuotaSnapshot.lastSuccessfulAt`, `UsageQuotaSnapshot.error`.
- Produces: `UsageQuotaCard.errorKind`.
- Produces: `classifyCodexQuotaError(error): "transient" | "auth" | "rate_limit" | "permanent"`.
- Consumes: existing `loadUsageQuotaSnapshot()` and `loadCodexQuotaCard()`.

- [ ] **Step 1: Write failing quota classification tests**

```ts
it.each([
  [new Error("URLError: <urlopen error timed out>"), "transient"],
  [new Error("socket hang up"), "transient"],
  [new CodexHttpError(401, "HTTP 401"), "auth"],
  [new CodexHttpError(403, "HTTP 403"), "auth"],
  [new CodexHttpError(429, "HTTP 429"), "rate_limit"],
  [new CodexHttpError(500, "HTTP 500"), "permanent"],
])("classifies %s as %s", (error, expected) => {
  expect(classifyCodexQuotaError(error)).toBe(expected);
});

it("turns Python timeout output into user-facing copy", async () => {
  const card = await loadCodexQuotaCard({
    homeDir,
    codexFetcher: async () => {
      throw new Error("URLError: <urlopen error timed out>");
    },
  });
  expect(card.detail).toBe("Codex 额度请求超时，请检查网络后重试。");
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx vitest run src/core/quota.test.ts`

Expected: FAIL because `classifyCodexQuotaError` and the normalized Chinese timeout message do not exist.

- [ ] **Step 3: Add exact shared quota state**

```ts
export type UsageQuotaFreshness = "fresh" | "stale" | "auth-required" | "unavailable";
export type UsageQuotaFailureKind = "transient" | "auth" | "rate_limit" | "permanent";

export interface UsageQuotaCard {
  // existing fields
  errorKind?: UsageQuotaFailureKind;
}

export interface UsageQuotaSnapshot {
  generatedAt: string;
  providers: UsageQuotaCard[];
  hiddenProviders?: UsageQuotaProvider[];
  freshness?: UsageQuotaFreshness;
  lastSuccessfulAt?: string;
  error?: string;
}
```

- [ ] **Step 4: Implement deterministic error classification**

```ts
export function classifyCodexQuotaError(
  error: unknown,
): "transient" | "auth" | "rate_limit" | "permanent" {
  if (error instanceof CodexHttpError) {
    if (error.statusCode === 401 || error.statusCode === 403) return "auth";
    if (error.statusCode === 429) return "rate_limit";
    return "permanent";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? out|timeout|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Temporary failure/i.test(message)) {
    return "transient";
  }
  return "permanent";
}
```

Update `loadCodexQuotaCard` to set `errorKind: classifyCodexQuotaError(error)` and make `sanitizeCodexError` return bounded Chinese copy for transient, auth, and rate-limit errors while retaining token redaction.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/core/quota.test.ts`

Expected: PASS.

```bash
git add src/core/types.ts src/core/quota.ts src/core/quota.test.ts
git commit -m "Harden Codex quota error reporting"
```

### Task 2: Add retrying, cached, login-aware QuotaService

**Files:**
- Create: `src/main/services/quota-service.ts`
- Create: `src/main/services/quota-service.test.ts`
- Create: `src/shared/ipc/quota.ts`
- Create: `src/preload/quota.ts`
- Create: `src/main/ipc/quota.ts`
- Create: `src/main/quota-ipc.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `classifyCodexQuotaError`, `loadUsageQuotaSnapshot`, `AppSettings`.
- Produces: `QuotaService.getSnapshot(force?: boolean): Promise<UsageQuotaSnapshot>`.
- Produces: `QuotaService.start(): void`, `QuotaService.stop(): void`.
- Produces: `QUOTA_EVENTS.updated` and preload `onQuotaUpdated(callback)`.

- [ ] **Step 1: Write failing service tests**

```ts
it("retries transient failures twice and publishes the successful snapshot", async () => {
  const load = vi.fn()
    .mockRejectedValueOnce(new Error("timed out"))
    .mockRejectedValueOnce(new Error("ECONNRESET"))
    .mockResolvedValue(snapshot("fresh"));
  const service = createService({ load });
  await expect(service.getSnapshot(true)).resolves.toMatchObject({ freshness: "fresh" });
  expect(load).toHaveBeenCalledTimes(3);
});

it("returns same-account cache when all transient attempts fail", async () => {
  const service = createService({
    cached: cachedSnapshot({ identity: "account-a", savedAt: now - 60_000 }),
    identity: "account-a",
    load: vi.fn(async () => { throw new Error("timed out"); }),
  });
  await expect(service.getSnapshot(true)).resolves.toMatchObject({
    freshness: "stale",
    lastSuccessfulAt: expect.any(String),
  });
});

it("does not expose another account cache", async () => {
  const service = createService({
    cached: cachedSnapshot({ identity: "account-a", savedAt: now - 60_000 }),
    identity: "account-b",
    load: vi.fn(async () => { throw new Error("timed out"); }),
  });
  await expect(service.getSnapshot(true)).resolves.toMatchObject({ freshness: "unavailable" });
});
```

- [ ] **Step 2: Verify service tests fail**

Run: `npx vitest run src/main/services/quota-service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement service dependencies and cache record**

```ts
export interface QuotaServiceDependencies {
  load(options: { hideCodexQuota: boolean; hideClaudeQuota: boolean }): Promise<UsageQuotaSnapshot>;
  getSettings(): Pick<AppSettings, "hideCodexQuota" | "hideClaudeQuota">;
  authPath(): string | null;
  identity(path: string | null): Promise<string | null>;
  readCache(): Promise<QuotaCacheRecord | null>;
  writeCache(record: QuotaCacheRecord): Promise<void>;
  publish(snapshot: UsageQuotaSnapshot): void;
  delay(ms: number): Promise<void>;
  now(): number;
  watch(path: string, callback: () => void): () => void;
}

interface QuotaCacheRecord {
  schemaVersion: 1;
  identity: string;
  savedAt: number;
  snapshot: UsageQuotaSnapshot;
}
```

Use SHA-256 of stable account ID when present, otherwise the OAuth JWT subject; never write the access token or raw account ID.

- [ ] **Step 4: Implement retry and auth watch**

```ts
const RETRY_DELAYS_MS = [0, 300, 900] as const;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async getSnapshot(force = false): Promise<UsageQuotaSnapshot> {
  if (!force && this.active) return this.active;
  this.active = this.loadWithFallback().finally(() => { this.active = null; });
  return this.active;
}

private async loadWithFallback(): Promise<UsageQuotaSnapshot> {
  const identity = await this.dependencies.identity(this.dependencies.authPath());
  let lastError: { kind: UsageQuotaFailureKind; message: string } | null = null;
  for (const delayMs of RETRY_DELAYS_MS) {
    if (delayMs) await this.dependencies.delay(delayMs);
    const fresh = await this.dependencies.load(this.dependencies.getSettings());
    const codexFailure = fresh.providers.find(
      (card) => card.provider === "codex" && card.status === "error",
    );
    if (!codexFailure) {
      const next = { ...fresh, freshness: "fresh" as const, lastSuccessfulAt: fresh.generatedAt };
      if (identity) await this.dependencies.writeCache({ schemaVersion: 1, identity, savedAt: this.dependencies.now(), snapshot: next });
      this.dependencies.publish(next);
      return next;
    }
    lastError = {
      kind: codexFailure.errorKind ?? "permanent",
      message: codexFailure.detail ?? "Codex quota is unavailable.",
    };
    if (lastError.kind !== "transient") break;
  }
  return this.cachedOrError(identity, lastError);
}
```

Debounce auth-file changes by 500 ms and perform one delayed retry when JSON parsing observes a partial write.

- [ ] **Step 5: Add typed IPC and preload tests**

```ts
export const QUOTA_IPC = {
  get: defineIpcRequest("quota:get", z.union([z.tuple([]), z.tuple([z.boolean().optional()])])
    .transform((input): [boolean] => [input[0] ?? false])),
} as const;

export const QUOTA_EVENTS = { updated: "quota:updated" } as const;
```

Test malformed inputs, handler disposal, callback delivery, and unsubscribe.

- [ ] **Step 6: Wire service lifecycle and renderer behavior**

Replace raw `ipcMain.handle("quota:get")` with `registerQuotaIpc`. Start the watcher after `app.whenReady()`, stop it during `before-quit`, and publish to the main window.

In `App.tsx`, subscribe to `onQuotaUpdated`, retain stale data, and render:

```tsx
{snapshot.freshness === "stale" ? (
  <div className="quota-stale-notice">
    {t(`Showing data from ${formatRelativeTime(Date.parse(snapshot.lastSuccessfulAt ?? ""))}. Refresh failed.`,
       `正在显示 ${formatRelativeTime(Date.parse(snapshot.lastSuccessfulAt ?? ""))} 的数据，刷新失败。`)}
  </div>
) : null}
```

- [ ] **Step 7: Run quota suite and commit**

Run:

```bash
npx vitest run src/core/quota.test.ts src/main/services/quota-service.test.ts src/main/quota-ipc.test.ts src/renderer/src/session-ui.test.ts
npm run typecheck
```

Expected: PASS.

```bash
git add src/core/types.ts src/main/services/quota-service.ts src/main/services/quota-service.test.ts src/shared/ipc/quota.ts src/preload/quota.ts src/main/ipc/quota.ts src/main/quota-ipc.test.ts src/main/index.ts src/preload/index.ts src/renderer/src/App.tsx src/renderer/src/styles.css
git commit -m "Keep Codex quota visible through transient failures"
```

### Task 3: Stream update downloads and stage a complete package

**Files:**
- Modify: `src/core/app-update-types.ts`
- Modify: `bin/update-client.cjs`
- Modify: `bin/apply-update.cjs`
- Modify: `scripts/update-client.test.mjs`
- Modify: `scripts/apply-update.test.mjs`

**Interfaces:**
- Produces: `AppUpdateProgress`.
- Produces: `stageUpdate(manifest, options): Promise<StagedUpdate>`.
- Produces: `applyStagedUpdate(staged, options): Promise<void>`.
- Consumes: current manifest verification, lock, stable Node, global package path, launch helpers.

- [ ] **Step 1: Define progress types and failing streaming tests**

```ts
export type AppUpdatePhase =
  | "checking" | "downloading" | "verifying" | "staging"
  | "validating" | "restarting" | "completed" | "error";

export interface AppUpdateProgress {
  phase: AppUpdatePhase;
  version: string;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  bytesPerSecond?: number;
  message?: string;
  error?: string;
}
```

Node test:

```js
test("streams package bytes and reports monotonic progress", async () => {
  const progress = [];
  const staged = await stageUpdate(manifestFor(bytes), {
    fetchImpl: async () => chunkedResponse([bytes.subarray(0, 5), bytes.subarray(5)], bytes.length),
    stageRoot,
    npmInstallImpl: fakeNpmInstall,
    validateImpl: fakeValidate,
    onProgress: (event) => progress.push(event),
  });
  assert.equal(await readFile(staged.archivePath), bytes);
  assert.deepEqual(progress.filter((event) => event.phase === "downloading").map((event) => event.percent), [50, 100]);
});
```

- [ ] **Step 2: Run script test and confirm RED**

Run: `node --test scripts/update-client.test.mjs scripts/apply-update.test.mjs`

Expected: FAIL because staged update APIs and progress do not exist.

- [ ] **Step 3: Implement streaming download**

```js
async function downloadUpdatePackage(manifest, archivePath, options = {}) {
  const response = await fetchWithTimeout(
    options.fetchImpl || globalThis.fetch,
    manifest.package.url,
    { headers: { "User-Agent": "agent-recall-updater" } },
    options.timeoutMs ?? 120_000,
  );
  if (!response.ok || !response.body) throw new Error(`Update package download failed (${response.status}).`);
  const totalBytes = Number(response.headers.get("content-length")) || undefined;
  const reader = response.body.getReader();
  const output = await fsp.open(archivePath, "w");
  const hash = createHash("sha256");
  let downloadedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      await output.write(chunk);
      hash.update(chunk);
      downloadedBytes += chunk.length;
      options.onProgress?.(downloadProgress(manifest.version, downloadedBytes, totalBytes));
    }
  } finally {
    await output.close();
  }
  if (hash.digest("hex") !== manifest.package.sha256) throw new Error("Update package checksum mismatch.");
}
```

- [ ] **Step 4: Implement isolated npm staging**

Install into `stageRoot` without touching the live package:

```js
await execFileImpl(npmCommand, [
  "install", "--prefix", stageRoot, archivePath,
  "--registry", registry, "--no-audit", "--no-fund",
  "--fetch-retries", "2", "--fetch-timeout", "30000",
], {
  env: { ...installEnvironment, AGENT_RECALL_STAGING_INSTALL: "1" },
  timeout: installTimeoutMs,
  maxBuffer: 16 * 1024 * 1024,
});
```

Return `{ version, stageRoot, stagedPackagePath, archivePath, livePackagePath, backupPath, statusPath }` only after validating CLI entry, main bundle, package version, and Electron runtime.

- [ ] **Step 5: Convert finalizer to validated directory swap**

```js
async function applyStagedUpdate(staged, options = {}) {
  await waitForProcessExit(options.waitPid, 30_000);
  await fsp.rm(staged.backupPath, { recursive: true, force: true });
  await fsp.rename(staged.livePackagePath, staged.backupPath);
  try {
    await moveDirectory(staged.stagedPackagePath, staged.livePackagePath);
    await writeInstallStatus({ status: "installed", version: staged.version, updatedAt: Date.now(), error: null });
    launchInstalledApp();
  } catch (error) {
    await fsp.rm(staged.livePackagePath, { recursive: true, force: true });
    await fsp.rename(staged.backupPath, staged.livePackagePath);
    throw error;
  }
}
```

On Windows, wait for the Electron process before renaming. Keep stage and backup on the same filesystem; fallback copy must verify package hash before deleting its source.

- [ ] **Step 6: Run script tests and commit**

Run: `node --test scripts/update-client.test.mjs scripts/apply-update.test.mjs`

Expected: PASS, including rollback, unknown content length, checksum failure, Windows path, and cleanup cases.

```bash
git add src/core/app-update-types.ts bin/update-client.cjs bin/apply-update.cjs scripts/update-client.test.mjs scripts/apply-update.test.mjs
git commit -m "Stage updates with visible download progress"
```

### Task 4: Publish update progress to App and CLI

**Files:**
- Modify: `src/main/services/app-update-service.ts`
- Modify: `src/main/services/app-update-service.test.ts`
- Modify: `src/shared/ipc/app-update.ts`
- Modify: `src/preload/app-update.ts`
- Modify: `src/main/ipc/app-update.ts`
- Modify: `src/main/app-update-ipc.test.ts`
- Create: `src/main/services/update-progress-window.ts`
- Create: `src/main/services/update-progress-window.test.ts`
- Create: `src/renderer/update.html`
- Create: `src/renderer/src/update-main.tsx`
- Create: `src/renderer/src/update-progress-app.tsx`
- Create: `src/renderer/src/update-progress.css`
- Modify: `electron.vite.config.ts`
- Modify: `src/renderer/src/features/settings/settings-dialog.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/app-update-ui.test.ts`

**Interfaces:**
- Consumes: `stageUpdate`, `AppUpdateProgress`.
- Produces: `AppUpdateService.install(): Promise<AppUpdateInstallResult>` that stays alive through staging.
- Produces: `APP_UPDATE_EVENTS.progress` and `onAppUpdateProgress`.
- Produces: `UpdateProgressWindow.show(version)`, `.publish(progress)`, `.close()`.

- [ ] **Step 1: Write failing service and IPC tests**

```ts
it("publishes every staged progress event before requesting restart", async () => {
  const harness = createHarness({
    stageInstaller: async (_manifest, onProgress) => {
      onProgress(progress("downloading", 25));
      onProgress(progress("staging"));
      onProgress(progress("validating"));
      return stagedUpdate();
    },
  });
  await harness.service.install();
  expect(harness.publishedProgress.map((event) => event.phase)).toEqual(["downloading", "staging", "validating", "restarting"]);
  expect(harness.requestQuit).toHaveBeenCalledOnce();
});
```

Preload test must assert listener registration and removal for `APP_UPDATE_EVENTS.progress`. Window tests must prove one reusable window is shown before staging and kept alive after staging errors.

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run src/main/services/app-update-service.test.ts src/main/services/update-progress-window.test.ts src/main/app-update-ipc.test.ts src/renderer/src/app-update-ui.test.ts`

Expected: FAIL because progress publication, the independent window, and its renderer are missing.

- [ ] **Step 3: Extend service dependencies**

```ts
stageInstaller(
  manifest: AppUpdateManifest,
  onProgress: (progress: AppUpdateProgress) => void,
): Promise<StagedUpdate>;
launchFinalizer(staged: StagedUpdate): Promise<void>;
publishProgress(progress: AppUpdateProgress): void;
```

`install()` shows the progress window, stages first, publishes `restarting`, launches finalizer, then requests quit. Before `restarting`, errors keep the current App and progress window running and publish an error with retry/manual-install actions.

- [ ] **Step 4: Add progress IPC and renderer**

```ts
export const APP_UPDATE_EVENTS = {
  status: "app-update:status",
  progress: "app-update:progress",
} as const;
```

`UpdateProgressWindow` is a small non-modal BrowserWindow that loads `update.html`, sends progress events after `did-finish-load`, and closes only when the new version starts or the user dismisses an error. The renderer exposes retry and manual-command actions through the existing update IPC; it does not receive npm paths.

Configure an update renderer entry alongside the main entry:

```ts
input: {
  main: resolve(__dirname, "src/renderer/index.html"),
  update: resolve(__dirname, "src/renderer/update.html"),
},
```

`UpdateProgressApp` renders a determinate bar only when `percent` is finite:

```tsx
<div className="update-progress" aria-live="polite">
  <div className="update-progress-title">{phaseLabel(progress.phase, language)}</div>
  <div className={`update-progress-track ${progress.percent == null ? "indeterminate" : ""}`}>
    <div className="update-progress-fill" style={progress.percent == null ? undefined : { width: `${progress.percent}%` }} />
  </div>
  {progress.totalBytes ? <span>{formatBytes(progress.downloadedBytes ?? 0)} / {formatBytes(progress.totalBytes)}</span> : null}
</div>
```

- [ ] **Step 5: Preserve CLI text progress**

Use the same `onProgress` callback in the CLI:

```js
function renderCliProgress(event) {
  if (event.phase === "downloading" && Number.isFinite(event.percent)) {
    process.stdout.write(`\r下载更新 ${String(Math.round(event.percent)).padStart(3)}%`);
    return;
  }
  process.stdout.write(`\n${progressMessage(event)}\n`);
}
```

- [ ] **Step 6: Run update suite and commit**

Run:

```bash
npx vitest run src/main/services/app-update-service.test.ts src/main/services/update-progress-window.test.ts src/main/app-update-ipc.test.ts src/renderer/src/app-update-ui.test.ts
node --test scripts/update-client.test.mjs scripts/apply-update.test.mjs
npm run typecheck
```

Expected: PASS.

```bash
git add src/main/services/app-update-service.ts src/main/services/app-update-service.test.ts src/main/services/update-progress-window.ts src/main/services/update-progress-window.test.ts src/shared/ipc/app-update.ts src/preload/app-update.ts src/main/ipc/app-update.ts src/main/app-update-ipc.test.ts src/renderer/update.html src/renderer/src/update-main.tsx src/renderer/src/update-progress-app.tsx src/renderer/src/update-progress.css electron.vite.config.ts src/renderer/src/features/settings/settings-dialog.tsx src/renderer/src/App.tsx src/renderer/src/styles.css src/renderer/src/app-update-ui.test.ts
git commit -m "Show update progress through validation and restart"
```

### Task 5: Add Dock preference and lightweight quick search

**Files:**
- Modify: `src/core/platform.ts`
- Modify: `src/core/platform.test.ts`
- Create: `src/main/services/quick-search-window.ts`
- Create: `src/main/services/quick-search-window.test.ts`
- Create: `src/shared/ipc/quick-search.ts`
- Create: `src/preload/quick-search.ts`
- Create: `src/renderer/quick-search.html`
- Create: `src/renderer/src/quick-search-main.tsx`
- Create: `src/renderer/src/quick-search.tsx`
- Create: `src/renderer/src/quick-search.css`
- Create: `src/renderer/src/quick-search.test.tsx`
- Modify: `electron.vite.config.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/features/settings/settings-dialog.tsx`

**Interfaces:**
- Produces: `AppSettings.showInDock: boolean`.
- Produces: `QuickSearchWindowController.show(): void`, `.hide(): void`, `.dispose(): void`.
- Produces: preload `openQuickSearchResult(sessionKey): Promise<void>`.
- Consumes: existing `search:sessions` IPC and `showWindow()`.

- [ ] **Step 1: Write failing settings and controller tests**

```ts
it("defaults to keeping the macOS Dock icon", () => {
  expect(defaultSettings.showInDock).toBe(true);
  expect(mergeAppSettings(defaultSettings, {}).showInDock).toBe(true);
});

it("reuses one quick-search window and hides it on blur", () => {
  const harness = createQuickSearchHarness();
  harness.controller.show();
  harness.controller.show();
  expect(harness.createWindow).toHaveBeenCalledOnce();
  harness.events.emit("blur");
  expect(harness.window.hide).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run src/core/platform.test.ts src/main/services/quick-search-window.test.ts src/renderer/src/quick-search.test.tsx`

Expected: FAIL because settings and controller do not exist.

- [ ] **Step 3: Add and apply Dock setting**

```ts
export interface AppSettings {
  // existing fields
  showInDock: boolean;
}

export const defaultSettings: AppSettings = {
  // existing defaults
  showInDock: true,
};
```

In main:

```ts
async function applyDockVisibility(show: boolean): Promise<void> {
  if (process.platform !== "darwin" || !app.dock) return;
  if (show) await app.dock.show();
  else app.dock.hide();
}
```

Apply once in `whenReady` and after `settings:set`. Render the switch only for `platform === "darwin"` in Appearance settings.

- [ ] **Step 4: Implement the quick-search controller**

```ts
export class QuickSearchWindowController {
  private window: BrowserWindow | null = null;

  show(): void {
    const window = this.window ?? this.create();
    this.position(window);
    window.show();
    window.focus();
    window.webContents.send(QUICK_SEARCH_EVENTS.focus);
  }

  hide(): void {
    this.window?.hide();
  }

  dispose(): void {
    this.window?.destroy();
    this.window = null;
  }
}
```

Use `alwaysOnTop`, `skipTaskbar`, `resizable: false`, `show: false`, and a compact fixed size. Load `quick-search.html`; hide on blur and Esc. Keep main-window behavior unchanged.

- [ ] **Step 5: Add tray command and safe result handoff**

Add “快速搜索会话…” above the existing Open action. Result selection invokes a validated session key:

```ts
openResult(sessionKey: string): void {
  if (!store.getSession(sessionKey)) throw new Error("Session not found.");
  quickSearchWindow.hide();
  showWindow();
  mainWindow?.webContents.send("open-session", sessionKey);
}
```

Do not pass full session records from quick renderer to main.

- [ ] **Step 6: Implement eight-result renderer**

```tsx
const results = await window.sessionSearch.searchSessions({ query, limit: 8, sortBy: "smart" });
setResults(results.slice(0, 8));
```

Debounce by 120 ms, ignore stale request IDs, support ArrowUp, ArrowDown, Enter, and Escape, and display title, source label, project basename, and relative time. Empty query shows recent sessions using the same `limit: 8`.

- [ ] **Step 7: Build both renderer entries**

Configure Rollup inputs:

```ts
import { resolve } from "node:path";

renderer: {
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/renderer/index.html"),
        update: resolve(__dirname, "src/renderer/update.html"),
        quickSearch: resolve(__dirname, "src/renderer/quick-search.html"),
      },
    },
  },
},
```

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
npx vitest run src/core/platform.test.ts src/main/services/quick-search-window.test.ts src/renderer/src/quick-search.test.tsx
npm run build
```

Expected: PASS and both HTML outputs exist.

```bash
git add src/core/platform.ts src/core/platform.test.ts src/main/services/quick-search-window.ts src/main/services/quick-search-window.test.ts src/shared/ipc/quick-search.ts src/preload/quick-search.ts src/renderer/quick-search.html src/renderer/src/quick-search-main.tsx src/renderer/src/quick-search.tsx src/renderer/src/quick-search.css src/renderer/src/quick-search.test.tsx electron.vite.config.ts src/main/index.ts src/preload/index.ts src/renderer/src/features/settings/settings-dialog.tsx
git commit -m "Add macOS quick search and Dock preference"
```

### Task 6: Persist explicit attachment metadata safely

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/core/session-attachments.ts`
- Create: `src/core/session-attachments.test.ts`
- Create: `src/core/store/attachments.ts`
- Create: `src/core/store/attachments.test.ts`
- Modify: `src/core/store/schema.ts`
- Modify: `src/core/store/schema.test.ts`
- Modify: `src/core/session-store.ts`
- Modify: `src/core/store/sessions.ts`

**Interfaces:**
- Produces: `SessionAttachment`, `ParsedAttachment`, `AttachmentAvailability`.
- Produces: `classifyAttachmentBlock(block, context): ParsedAttachment | null`.
- Produces: store `replaceSessionAttachments`, `listSessionAttachments`, `getSessionAttachment`.

- [ ] **Step 1: Write failing parser and schema tests**

```ts
it("extracts an explicit Codex input image without treating text paths as files", () => {
  expect(classifyAttachmentBlock({
    type: "input_image",
    image_url: `data:image/png;base64,${PNG_BASE64}`,
  }, context)).toMatchObject({ kind: "image", mimeType: "image/png", sourceKind: "inline" });

  expect(classifyAttachmentBlock({
    type: "input_text",
    text: "Please read /etc/passwd",
  }, context)).toBeNull();
});

it("creates the attachment table idempotently", () => {
  migrateSessionStore(db);
  migrateSessionStore(db);
  expect(tableColumns(db, "attachments")).toEqual(expect.arrayContaining([
    "id", "session_key", "message_index", "display_name", "mime_type",
    "byte_size", "sha256", "availability", "managed_object_key",
  ]));
});
```

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run src/core/session-attachments.test.ts src/core/store/schema.test.ts src/core/store/attachments.test.ts`

Expected: FAIL because attachment types, parser, table, and store do not exist.

- [ ] **Step 3: Define exact attachment types**

```ts
export type SessionAttachmentKind = "image" | "pdf" | "text" | "file";
export type AttachmentAvailability = "available" | "missing" | "unsafe" | "too_large" | "invalid";

export interface SessionAttachment {
  id: string;
  sessionKey: string;
  messageIndex: number;
  attachmentIndex: number;
  displayName: string;
  kind: SessionAttachmentKind;
  mimeType: string;
  byteSize: number;
  sha256: string;
  availability: AttachmentAvailability;
  detail?: string;
}
```

Node-only `ParsedAttachment` additionally carries `sourceKind`, `contentBase64` or `safeFilePath`; it must never cross IPC.

- [ ] **Step 4: Add attachment table and store**

```sql
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  attachment_index INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  availability TEXT NOT NULL,
  detail TEXT,
  managed_object_key TEXT,
  remote_object_key TEXT,
  UNIQUE(session_key, message_index, attachment_index),
  FOREIGN KEY(session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
);
```

`AttachmentStore` returns public metadata without object keys. Internal methods may return `StoredSessionAttachment`.

- [ ] **Step 5: Enforce safety and limits**

`classifyAttachmentBlock` accepts only:

```ts
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_SESSION_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const EXPLICIT_ATTACHMENT_TYPES = new Set(["input_image", "image", "attachment", "file"]);
```

Inline data must have valid canonical Base64 and allowed decoded size. File sources must be regular files under injected trusted roots, never symlinks; ordinary paths become `unsafe` metadata without reading bytes.

- [ ] **Step 6: Integrate SessionStore CRUD**

Extend `upsertIndexedSession` with a final `attachments: StoredSessionAttachmentInput[] = []` parameter and replace attachments in the same transaction as messages. Deleting a session relies on the foreign key and returns orphaned managed object keys for cache cleanup.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npx vitest run src/core/session-attachments.test.ts src/core/store/schema.test.ts src/core/store/attachments.test.ts src/core/session-store.test.ts
npm run typecheck
```

Expected: PASS.

```bash
git add src/core/types.ts src/core/session-attachments.ts src/core/session-attachments.test.ts src/core/store/attachments.ts src/core/store/attachments.test.ts src/core/store/schema.ts src/core/store/schema.test.ts src/core/session-store.ts src/core/store/sessions.ts src/core/session-store.test.ts
git commit -m "Add safe session attachment metadata"
```

### Task 7: Extract, cache, preview, and open local attachments

**Files:**
- Modify: `src/core/format-adapters.ts`
- Modify: `src/core/format-adapters.test.ts`
- Modify: `src/core/session-loader.ts`
- Modify: loader tests
- Modify: `src/core/indexer.ts`
- Modify: `src/core/indexer.test.ts`
- Create: `src/main/services/attachment-service.ts`
- Create: `src/main/services/attachment-service.test.ts`
- Create: `src/shared/ipc/attachments.ts`
- Create: `src/preload/attachments.ts`
- Create: `src/main/ipc/attachments.ts`
- Create: `src/main/attachments-ipc.test.ts`
- Create: `src/renderer/src/features/session-detail/session-attachments.tsx`
- Create: `src/renderer/src/session-attachments-ui.test.ts`
- Modify: `src/renderer/src/features/session-detail/detail-panel.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: Task 6 attachment types/store.
- Produces: loader `LoadedSession.attachments`.
- Produces: `AttachmentService.list(sessionKey)`, `.preview(id)`, `.open(id)`.
- Produces: preload `listSessionAttachments`, `getAttachmentPreview`, `openSessionAttachment`.

- [ ] **Step 1: Write failing adapter and cache tests**

```ts
it("keeps text and extracts an inline image from one user message", () => {
  expect(codexAdapter.parseLine(codexImageLine)).toMatchObject({
    message: { role: "user", content: "Check this screenshot" },
    attachments: [{ mimeType: "image/png", sourceKind: "inline" }],
  });
});

it("stores inline bytes by sha256 and reuses the same object", async () => {
  const service = createAttachmentService(tempUserData);
  const first = await service.ingest(inlineAttachment(PNG_BASE64));
  const second = await service.ingest(inlineAttachment(PNG_BASE64));
  expect(first.managedObjectKey).toBe(second.managedObjectKey);
  expect(await fileCount(service.objectRoot)).toBe(1);
});
```

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run src/core/format-adapters.test.ts src/main/services/attachment-service.test.ts`

Expected: FAIL because adapters return only text and the service does not exist.

- [ ] **Step 3: Return message plus attachments from adapters**

```ts
export interface ParsedLine {
  message: Omit<SessionMessage, "index"> | null;
  attachments: ParsedAttachment[];
}
```

Every adapter returns `{ message, attachments }`. Attachment-only user turns receive an empty content string but remain indexed when `attachments.length > 0`. Existing title selection ignores empty content.

- [ ] **Step 4: Carry attachments through loader and indexer**

```ts
export interface LoadedSession {
  session: IndexedSession;
  messages: SessionMessage[];
  attachments: ParsedSessionAttachment[];
  tokenEvents: TokenUsageEvent[];
  traceEvents: SessionTraceEvent[];
  executionEnvironmentHint?: SessionExecutionEnvironmentHint;
}
```

Assign `messageIndex` after message filtering. `syncLoadedSessionsInBatches` ingests attachment bytes into the managed cache before calling `store.upsertIndexedSession`.

- [ ] **Step 5: Implement AttachmentService authorization**

```ts
async preview(id: string): Promise<AttachmentPreview> {
  const attachment = this.dependencies.store.getStoredSessionAttachment(id);
  if (!attachment) throw new Error("Attachment not found.");
  const path = await this.resolveVerifiedObject(attachment);
  if (!PREVIEWABLE_KINDS.has(attachment.kind)) return { kind: "unsupported", attachment: publicAttachment(attachment) };
  return { kind: attachment.kind, attachment: publicAttachment(attachment), url: this.dependencies.protocolUrl(id) };
}

async open(id: string): Promise<void> {
  const attachment = this.dependencies.store.getStoredSessionAttachment(id);
  if (!attachment) throw new Error("Attachment not found.");
  const path = await this.resolveVerifiedObject(attachment);
  const result = await this.dependencies.openPath(path);
  if (result) throw new Error(result);
}
```

The custom protocol accepts attachment ID only, resolves through the store, verifies size/hash, sends `Content-Type`, and rejects navigation/range requests outside the object.

- [ ] **Step 6: Add typed IPC**

```ts
export const ATTACHMENT_IPC = {
  list: defineIpcRequest("attachment:list", z.tuple([sessionKey])),
  preview: defineIpcRequest("attachment:preview", z.tuple([attachmentId])),
  open: defineIpcRequest("attachment:open", z.tuple([attachmentId])),
} as const;
```

Test NUL, overlong IDs, unknown IDs, and ensure renderer cannot provide a path.

- [ ] **Step 7: Render attachment cards and preview**

`MessageBlock` receives the message’s attachment list. Render image thumbnail, PDF/text preview button, or generic file card. The preview dialog receives only `AttachmentPreview.url`; it never renders arbitrary HTML and text preview uses escaped `<pre>`.

- [ ] **Step 8: Run local attachment suite and commit**

Run:

```bash
npx vitest run src/core/format-adapters.test.ts src/core/session-loader.test.ts src/core/session-loader-extra-sources.test.ts src/core/indexer.test.ts src/main/services/attachment-service.test.ts src/main/attachments-ipc.test.ts src/renderer/src/session-attachments-ui.test.ts
npm run build
```

Expected: PASS.

```bash
git add src/core/format-adapters.ts src/core/format-adapters.test.ts src/core/session-loader.ts src/core/session-loader.test.ts src/core/session-loader-extra-sources.test.ts src/core/indexer.ts src/core/indexer.test.ts src/main/services/attachment-service.ts src/main/services/attachment-service.test.ts src/shared/ipc/attachments.ts src/preload/attachments.ts src/main/ipc/attachments.ts src/main/attachments-ipc.test.ts src/renderer/src/features/session-detail/session-attachments.tsx src/renderer/src/session-attachments-ui.test.ts src/renderer/src/features/session-detail/detail-panel.tsx src/renderer/src/App.tsx src/renderer/src/styles.css
git commit -m "Preview and open local session attachments"
```

### Task 8: Sync attachments with remote sessions by default

**Files:**
- Modify: `src/core/platform.ts`
- Modify: `src/core/platform.test.ts`
- Modify: `src/core/remote-session-sync.ts`
- Modify: `src/core/remote-session-sync.test.ts`
- Modify: `src/main/services/remote-session-service.ts`
- Modify: `src/main/services/remote-session-service.test.ts`
- Modify: `src/shared/ipc/remote-sessions.ts`
- Modify: `src/preload/remote-sessions.ts`
- Modify: `src/main/ipc/remote-sessions.ts`
- Modify: `src/main/remote-sessions-ipc.test.ts`
- Modify: `src/main/services/attachment-service.ts`
- Modify: `src/renderer/src/features/settings/settings-dialog.tsx`
- Modify: `src/renderer/src/features/session-detail/detail-panel.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/session-sync-settings.test.ts`
- Modify: `src/renderer/src/session-attachments-ui.test.ts`

**Interfaces:**
- Produces: `AppSettings.syncSessionAttachments: boolean`.
- Produces: snapshot schema 2 with `attachments: RemoteSessionAttachmentManifest[]`.
- Produces: remote client binary upload/download/delete methods.
- Consumes: stored attachment metadata and verified object paths from Task 7.

- [ ] **Step 1: Write failing default-setting and manifest tests**

```ts
it("enables remote attachment sync by default", () => {
  expect(defaultSettings.syncSessionAttachments).toBe(true);
});

it("builds schema 2 without leaking local paths", () => {
  const snapshot = buildRemoteSessionSnapshot(session, messages, traceEvents, attachments, 123);
  expect(snapshot).toMatchObject({ schemaVersion: 2, attachments: [{ displayName: "shot.png", sha256 }] });
  expect(JSON.stringify(snapshot)).not.toContain("/Users/test/private/shot.png");
});

it("parses schema 1 as an empty attachment list", () => {
  expect(parseDetailSnapshot(schema1Snapshot)).toMatchObject({ attachments: [] });
});
```

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run src/core/platform.test.ts src/core/remote-session-sync.test.ts src/main/services/remote-session-service.test.ts`

Expected: FAIL because the setting and schema 2 manifest do not exist.

- [ ] **Step 3: Define remote manifest**

```ts
export interface RemoteSessionAttachmentManifest {
  id: string;
  messageIndex: number;
  attachmentIndex: number;
  displayName: string;
  kind: SessionAttachmentKind;
  mimeType: string;
  byteSize: number;
  sha256: string;
  objectKey: string | null;
  availability: AttachmentAvailability;
  detail?: string;
}

export interface RemoteSessionDetailSnapshot {
  schemaVersion: 2;
  exportedAt: number;
  session: SessionSearchResult;
  messages: SessionMessage[];
  traceEvents: SessionTraceEvent[];
  attachments: RemoteSessionAttachmentManifest[];
}
```

Schema 1 parser returns schema 2 in memory with `attachments: []`.

- [ ] **Step 4: Add binary storage methods**

```ts
async uploadAttachmentObject(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
  const response = await this.storageRequest(key, {
    method: "POST",
    headers: { "Content-Type": mimeType, "Cache-Control": "private, max-age=31536000, immutable", "x-upsert": "true" },
    body: bytes,
  });
  if (!response.ok) throw new Error(supabaseErrorMessage(response.status, await readResponseBody(response)));
}

async downloadAttachmentObject(key: string): Promise<Uint8Array> {
  const response = await this.storageRequest(key, { method: "GET" });
  if (!response.ok) throw new Error(supabaseErrorMessage(response.status, await response.text()));
  return new Uint8Array(await response.arrayBuffer());
}
```

Object keys use `sessions/<remoteId>/<uploadId>/attachments/<attachmentIndex>-<sha256>`. Never include the original absolute path.

- [ ] **Step 5: Upload attachments transactionally**

`RemoteSessionService.upload` asks `AttachmentService` for verified upload objects only when `remoteSyncEnabled && syncSessionAttachments`. Upload objects first, then detail/portable JSON, then row. On any failure, delete every new object key. Preserve previous remote objects until the row succeeds.

- [ ] **Step 6: Expose the default-on remote attachment setting**

Render the switch only in the remote session sync section and disable it when remote sync itself is off:

```tsx
<label className="settings-field settings-toggle">
  <div className="settings-field-text">
    <span className="settings-field-title">{l("Sync session attachments", "同步会话附件")}</span>
    <span className="settings-field-sub">
      {l("Uploads safely recognized attachments with new or updated remote sessions.", "上传新的或更新的远程会话时，同时上传安全识别的附件。")}
    </span>
  </div>
  <input
    type="checkbox"
    className="switch"
    checked={Boolean(settings?.syncSessionAttachments)}
    disabled={!settings?.remoteSyncEnabled}
    onChange={(event) => onSettingsChange({ syncSessionAttachments: event.currentTarget.checked })}
  />
</label>
```

- [ ] **Step 7: Include attachment hashes in sync revision**

Extend `remoteSessionContentHash` with sorted `{ id, sha256, byteSize, availability }`. A changed attachment produces `local-newer`; disabled attachment sync excludes object data but retains manifest status so repeatedly uploading does not oscillate.

- [ ] **Step 8: Lazy-download remote attachments**

Add remote preload methods:

```ts
downloadRemoteSessionAttachment(remoteId: string, attachmentId: string): Promise<AttachmentPreview>
openRemoteSessionAttachment(remoteId: string, attachmentId: string): Promise<void>
```

Main resolves the manifest from the verified detail snapshot, downloads on click, enforces the 25 MiB limit before and after download, verifies SHA-256, stores in the managed cache, then reuses local preview/open.

Pass `remoteId` into the remote detail attachment cards so the same preview component calls the remote download/open methods without exposing `objectKey`.

- [ ] **Step 9: Delete version attachment objects**

When replacing or deleting a remote session, delete detail, portable, and every manifest object belonging to that remote revision. Batch deletion reports per-session failure without deleting unrelated session objects.

- [ ] **Step 10: Run remote suite and commit**

Run:

```bash
npx vitest run src/core/platform.test.ts src/core/remote-session-sync.test.ts src/main/services/remote-session-service.test.ts src/main/remote-sessions-ipc.test.ts src/main/services/attachment-service.test.ts src/renderer/src/session-sync-settings.test.ts src/renderer/src/session-attachments-ui.test.ts
npm run typecheck
```

Expected: PASS.

```bash
git add src/core/platform.ts src/core/platform.test.ts src/core/remote-session-sync.ts src/core/remote-session-sync.test.ts src/main/services/remote-session-service.ts src/main/services/remote-session-service.test.ts src/shared/ipc/remote-sessions.ts src/preload/remote-sessions.ts src/main/ipc/remote-sessions.ts src/main/remote-sessions-ipc.test.ts src/main/services/attachment-service.ts src/renderer/src/features/settings/settings-dialog.tsx src/renderer/src/features/session-detail/detail-panel.tsx src/renderer/src/App.tsx src/renderer/src/session-sync-settings.test.ts src/renderer/src/session-attachments-ui.test.ts
git commit -m "Sync remote session attachments by default"
```

### Task 9: README, release note, integration verification, and MR update

**Files:**
- Modify: `README.md`
- Modify: `.release-notes/fix-cursor-remote-environments.md`
- Verify: all changed files

**Interfaces:**
- Consumes: all prior tasks.
- Produces: final user-facing installation and release copy.

- [ ] **Step 1: Add the direct mirror command**

Immediately after the default README install command:

````md
国内网络可以仅为本次安装使用 npm 与 Electron 镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz \
  --registry=https://registry.npmmirror.com
```

Release 安装包仍从 GitHub 下载；npm 依赖和 Electron Runtime 使用镜像。该命令不会修改全局 npm 配置。
````

- [ ] **Step 2: Update the existing release note only**

Use one title and user-visible bullets:

```md
# 会话查找、同步与桌面体验升级

## 新增功能

- macOS 菜单栏新增轻量会话搜索，可快速定位并打开最近或匹配的会话；也可选择是否在程序坞中保留应用图标。
- 本地会话附件支持预览和使用系统应用打开；开启远程会话同步后，安全识别的附件会默认随会话同步，并在需要查看时下载。
- 应用与终端更新会显示下载和安装阶段，更新失败时继续保留可用旧版本。
- README 直接提供国内 npm 与 Electron 镜像安装命令。

## Bug 修复

- Cursor Remote SSH 会话会按实际远程环境归类，空的 Cursor 会话记录不再出现在列表中。
- Codex 额度在登录或切换账号后会自动刷新；偶发网络超时时保留上次成功数据并明确提示更新时间。
```

- [ ] **Step 3: Run formatting and release-note checks**

Run:

```bash
git diff --check
npm run release-note:check
```

Expected: PASS; release-note checker reports exactly one branch note.

- [ ] **Step 4: Run full unit and script tests**

Run: `npm test`

Expected: all Vitest and Node script tests PASS with no real HOME, npm prefix, session, or Supabase mutations.

- [ ] **Step 5: Run typecheck and production build**

Run: `npm run build`

Expected: typecheck, MCP bundle, main, preload, main renderer, and quick-search renderer all build successfully.

- [ ] **Step 6: Run package smoke test**

Run: `npm run package:smoke`

Expected: generated tarball installs into a temporary prefix, packaged CLI launches, and all temporary processes/files are cleaned.

- [ ] **Step 7: Inspect final branch and commit documentation**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline --decorate -12
```

Expected: only intended commits and one release note.

```bash
git add README.md .release-notes/fix-cursor-remote-environments.md
git commit -m "Document desktop and session sync improvements"
```

- [ ] **Step 8: Push the existing branch and update MR #147**

Run:

```bash
git push origin codex/fix-cursor-remote-environments
gh pr edit 147 --title "Improve Cursor sessions, desktop reliability, and attachments" --body-file /tmp/agent-recall-pr-147-body.md
gh pr checks 147 --watch
```

Expected: push succeeds, MR remains based on `main`, and all required checks pass. Do not create a new PR or merge until checks are green and the user’s requested merge condition is satisfied.
