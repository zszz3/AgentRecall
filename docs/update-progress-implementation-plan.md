# Background Update Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the old quit-first App update lifecycle while adding visible progress to `agent-recall --update` and a detached App updater window.

**Architecture:** The main App only validates the manifest, starts a detached Electron updater entry, and quits. The updater entry stages the package while rendering progress, then starts the existing pure Node apply process and exits so the apply process can atomically replace the live package. Terminal updates reuse the current Node apply path with a terminal renderer.

**Tech Stack:** Electron 42, electron-vite, React 19, TypeScript, Node.js CommonJS update scripts, Vitest, Node test runner.

## Global Constraints

- Direct `npm install -g agent-recall` and `npm update -g agent-recall` remain owned by npm and are not intercepted.
- Release archive download progress is based on actual bytes and `Content-Length`.
- npm installation progress is explicitly simulated, monotonic, and capped at 90% until npm exits.
- The live package is not replaced while an Electron process is using it.
- Existing checksum validation, Electron repair, backup rollback, native failure fallback, and automatic relaunch remain intact.
- Non-TTY output contains no cursor-control sequences.
- Installation tests use temporary HOME, npm prefix, npm cache, and synthetic fixtures.

---

### Task 1: Terminal update progress

**Files:**
- Create: `bin/update-progress.cjs`
- Create: `scripts/update-progress.test.mjs`
- Modify: `bin/update-client.cjs`
- Modify: `bin/apply-update.cjs`
- Modify: `scripts/update-client.test.mjs`

**Interfaces:**
- Consumes: `AppUpdateProgress`-shaped objects emitted by `installUpdate`.
- Produces: `createTerminalUpdateProgress({ stream, timers })` with `report(progress)`, `complete(version)`, and `dispose()` methods.

- [ ] **Step 1: Write failing terminal renderer tests**

Test a TTY stream for a byte-based download line, a simulated npm line that never exceeds 90%, a final 100% line, and a non-TTY stream without `\r` or ANSI clear-line sequences.

```js
const progress = createTerminalUpdateProgress({ stream, timers });
progress.report({ phase: "downloading", version: "0.32.0", percent: 25, bytesPerSecond: 1_048_576 });
assert.match(stream.output(), /25%/);
assert.match(stream.output(), /1\\.0 MB\\/s/);
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test scripts/update-progress.test.mjs`

Expected: FAIL because `bin/update-progress.cjs` does not exist.

- [ ] **Step 3: Implement the terminal renderer**

Create a stateful renderer that rewrites one line for TTY streams, emits one line per phase for non-TTY streams, starts an interval on `"staging"`, advances the displayed npm value with an asymptotic elapsed-time function capped at 90, and clears its timer on the next phase or disposal.

```js
function simulatedInstallPercent(elapsedMs) {
  return Math.min(90, 10 + Math.floor(80 * (1 - Math.exp(-elapsedMs / 30_000))));
}
```

- [ ] **Step 4: Emit install and validation phases from `installUpdate`**

Immediately before spawning npm:

```js
options.onProgress?.(updateProgress(parsed.version, "staging", {
  message: "正在通过 npm 安装…",
}));
```

Immediately before `ensureInstalledElectron`:

```js
options.onProgress?.(updateProgress(parsed.version, "validating", {
  message: "正在检查应用和 Electron 运行时…",
}));
```

- [ ] **Step 5: Wire terminal rendering into `apply-update.cjs`**

Create the renderer only for the `--manifest` path, pass `onProgress: renderer.report` into `installUpdate`, call `complete(version)` after install validation, and always call `dispose()` in `finally`.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
node --test scripts/update-progress.test.mjs scripts/update-client.test.mjs scripts/apply-update.test.mjs
```

Expected: all selected script tests pass.

- [ ] **Step 7: Commit**

```bash
git add bin/update-progress.cjs bin/update-client.cjs bin/apply-update.cjs scripts/update-progress.test.mjs scripts/update-client.test.mjs
git commit -m "add terminal update progress"
```

---

### Task 2: Restore quit-first App handoff

**Files:**
- Modify: `src/main/services/app-update-service.ts`
- Modify: `src/main/services/app-update-service.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/app-update.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/features/settings/settings-dialog.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: a validated `AppUpdateManifest`.
- Produces: `launchInstaller(manifest): Promise<void>` that resolves after the detached updater window has spawned.

- [ ] **Step 1: Replace current service tests with failing quit-first behavior**

Assert that `install()` awaits only `launchInstaller(manifest)`, schedules `requestQuit` after the launcher acknowledges spawn, and does not expose `stageInstaller` or `publishProgress` dependencies.

```ts
await expect(harness.service.install()).resolves.toEqual({ started: true, version: "0.2.0" });
expect(harness.launchInstaller).toHaveBeenCalledWith(availableManifest);
expect(harness.scheduled.at(-1)?.delayMs).toBe(100);
```

Also reject the launcher promise and assert that no quit is scheduled.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/main/services/app-update-service.test.ts`

Expected: FAIL because the service still stages inside the main App.

- [ ] **Step 3: Restore the service boundary**

Remove `activeInstall`, `stageInstaller`, and `publishProgress`. Make `install()` parse the manifest, await the detached updater launcher, schedule quit after 100ms, and return the acknowledgement.

- [ ] **Step 4: Remove the embedded Settings progress panel**

Remove `appUpdateProgress` state, subscription, props, phase label helper, panel markup, and `.update-progress-*` styles. Keep the existing busy button state until the main App exits or launcher startup fails.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run src/main/services/app-update-service.test.ts
npm run typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/app-update-service.ts src/main/services/app-update-service.test.ts src/main/index.ts src/preload/app-update.ts src/renderer/src/App.tsx src/renderer/src/features/settings/settings-dialog.tsx src/renderer/src/styles.css
git commit -m "restore quit first app updates"
```

---

### Task 3: Detached updater lifecycle

**Files:**
- Create: `src/main/services/detached-update-window.ts`
- Create: `src/main/services/detached-update-window.test.ts`
- Create: `src/main/update-window.ts`
- Modify: `electron.vite.config.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces: `launchDetachedUpdateWindow(manifest, options): Promise<void>`.
- Produces: `runDetachedUpdate(manifest, dependencies): Promise<void>` for staging and handoff.
- Consumes: `stageUpdate(manifest, { nodePath, onProgress })` and the existing `bin/apply-update.cjs --staged` contract.

- [ ] **Step 1: Write failing launcher and lifecycle tests**

The launcher test must assert that Electron is spawned detached with the standalone update entry, a temporary manifest, stable Node/apply paths in the environment, and `ELECTRON_RUN_AS_NODE` removed.

The lifecycle test must assert this order:

```text
window-ready -> wait-main-pid -> stage-update -> spawn-node-apply -> quit-updater
```

The apply arguments must include `--staged <path> --wait-pid <updater-pid>`. A stage failure must call the existing native fallback and relaunch the installed App without spawning the apply process.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run src/main/services/detached-update-window.test.ts
```

Expected: FAIL because the lifecycle module does not exist.

- [ ] **Step 3: Implement the detached launcher**

Write the manifest to a temporary control directory and spawn:

```ts
spawn(electronExecutable, [
  updateWindowEntry,
  "--manifest",
  manifestPath,
  "--wait-pid",
  String(mainProcessId),
], {
  detached: true,
  stdio: "ignore",
  env: {
    ...cleanEnvironment,
    AGENT_RECALL_NODE_PATH: stableNodePath,
    AGENT_RECALL_APPLY_UPDATE_PATH: applyUpdatePath,
  },
});
```

Resolve on the child `"spawn"` event and remove the control directory if spawning fails.

- [ ] **Step 4: Implement the standalone Electron entry**

Create a fixed-size non-closable `BrowserWindow`, load the updater renderer, wait for the main PID to exit, call `stageUpdate`, publish each progress event to the window, serialize the returned staged descriptor, and spawn the stable Node apply process. Quit the updater only after the apply process acknowledges spawn.

On failure, record the error through the existing install status, show `showNativeUpdateFailure`, attempt `launchInstalledApp`, clean the control directory, and exit non-zero.

- [ ] **Step 5: Build the second main entry**

Configure electron-vite main Rollup input with:

```ts
input: {
  index: resolve("src/main/index.ts"),
  "update-window": resolve("src/main/update-window.ts"),
}
```

Build `out/main/update-window.js`; packaged-asset assertions are added after the renderer and preload exist in Task 5.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npx vitest run src/main/services/detached-update-window.test.ts src/main/services/app-update-service.test.ts
npm run build
```

Expected: focused tests pass and both main entries build.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/detached-update-window.ts src/main/services/detached-update-window.test.ts src/main/update-window.ts src/main/index.ts electron.vite.config.ts
git commit -m "add detached app updater"
```

---

### Task 4: Updater window UI

**Files:**
- Create: `src/preload/update-progress.ts`
- Create: `src/renderer/update-progress.html`
- Create: `src/renderer/src/update-progress-main.tsx`
- Create: `src/renderer/src/update-progress.tsx`
- Create: `src/renderer/src/update-progress.css`
- Create: `src/renderer/src/update-progress.test.ts`
- Modify: `electron.vite.config.ts`
- Modify: `src/renderer/src/global.d.ts`

**Interfaces:**
- Consumes: `AppUpdateProgress` events from the standalone updater main process.
- Produces: `window.updateProgress.onProgress(callback)` and a fixed update progress view.

- [ ] **Step 1: Write failing progress-model tests**

Test labels and percentages for download, npm staging, validation, completed, and error. The npm model must remain monotonic and never exceed 90 before completion.

```ts
expect(updateProgressView({ phase: "staging", version: "0.32.0" }, 120_000).percent).toBe(90);
expect(updateProgressView({ phase: "completed", version: "0.32.0" }, 0).percent).toBe(100);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/renderer/src/update-progress.test.ts`

Expected: FAIL because the updater view model does not exist.

- [ ] **Step 3: Implement the preload and renderer**

Expose only the progress subscription through context isolation. Render product name, target version, current phase, progress bar, percent where meaningful, download speed, and the statement that AgentRecall will reopen automatically. Do not expose update controls or arbitrary IPC.

- [ ] **Step 4: Add renderer build input**

Add:

```ts
"update-progress": resolve("src/renderer/update-progress.html")
```

to the renderer Rollup inputs and load `update-progress.html` from the standalone main entry.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run src/renderer/src/update-progress.test.ts
npm run typecheck
npm run build
```

Expected: the view-model test, typecheck, and multi-entry build pass.

- [ ] **Step 6: Commit**

```bash
git add src/preload/update-progress.ts src/renderer/update-progress.html src/renderer/src/update-progress-main.tsx src/renderer/src/update-progress.tsx src/renderer/src/update-progress.css src/renderer/src/update-progress.test.ts src/renderer/src/global.d.ts electron.vite.config.ts
git commit -m "add app update progress window"
```

---

### Task 5: End-to-end safety and release verification

**Files:**
- Modify: `scripts/package-smoke.mjs`
- Modify: `.release-notes/restore-background-update-progress.md`

**Interfaces:**
- Verifies the complete packed updater contract without touching the active global installation.

- [ ] **Step 1: Extend isolated package smoke coverage**

Build the release tarball in a temporary root, install it under a temporary prefix and HOME, assert the CLI progress module, standalone main entry, preload, and renderer exist, and run the packaged CLI with a synthetic update fixture. Ensure all child processes exit and all temp roots are removed.

- [ ] **Step 2: Run all verification**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run package:smoke
npm run release-note:check
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 3: Inspect the final diff and release copy**

Confirm the diff contains exactly one branch release note, no generated archives, no update locks, and no temporary HOME/cache paths.

- [ ] **Step 4: Commit final integration adjustments**

```bash
git add scripts/package-smoke.mjs .release-notes/restore-background-update-progress.md
git commit -m "test background update progress"
```

- [ ] **Step 5: Push and open the MR**

```bash
git push -u origin codex/restore-background-update-progress
gh pr create --base main --head codex/restore-background-update-progress
```
