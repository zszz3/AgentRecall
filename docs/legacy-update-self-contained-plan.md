# Legacy Update Self-Containment Implementation Plan

**Goal:** Keep one-click upgrades from legacy AgentRecall releases working while removing the bundled Electron bridge from published tarballs.

**Architecture:** During `stageUpdate`, npm installs the release archive under a temporary prefix. The package's postinstall detects that staging environment, copies hoisted production dependencies from the prefix into the staged `agent-recall/node_modules`, and skips all user configuration work. The legacy updater can then atomically move only the package directory without losing runtime dependencies.

**Tech Stack:** Node.js CommonJS lifecycle script, npm package lifecycle, Node test runner, Vitest, macOS/Windows CI.

## Global Constraints

- Legacy releases from v0.31.3 onward must be able to update directly to the latest release.
- Normal npm installs must keep their current Claude statusline behavior.
- Staging installs must not read or write the user's Claude configuration.
- Published archives must not bundle Electron; staging must validate self-contained runtime dependencies before reporting success.
- All installation tests use temporary HOME, npm prefix, cache, and fixtures.

### Task 1: Specify and test staged dependency materialization

**Files:**
- Create: `scripts/staged-package-dependencies.test.mjs`
- Modify: `package.json`

- [ ] Write a failing test that creates a synthetic staging `node_modules` with scoped and unscoped dependencies, invokes the lifecycle helper with `AGENT_RECALL_STAGING_INSTALL=1`, and asserts that runtime dependencies exist under `agent-recall/node_modules` while `agent-recall` itself and `.bin` are not recursively copied.
- [ ] Run `node --test scripts/staged-package-dependencies.test.mjs` and confirm it fails because the lifecycle helper does not exist.
- [ ] Add an assertion that `package.json` no longer declares bundled dependencies, so the test fails if the archive bridge is restored.

### Task 2: Implement staging-only self-containment

**Files:**
- Create: `bin/prepare-staged-package-dependencies.cjs`
- Modify: `bin/install-claude-statusline.cjs`
- Modify: `package.json`

- [ ] Implement `materializeStagedPackageDependencies({ stageRoot, packageRoot })` to copy all entries from `<stageRoot>/node_modules` into `<packageRoot>/node_modules`, excluding `.bin`, `.package-lock.json`, and `agent-recall`; recurse through scoped packages.
- [ ] In `postinstall`, detect `AGENT_RECALL_STAGING_INSTALL=1`, run the materialization helper with `AGENT_RECALL_STAGE_ROOT`, and return before statusline configuration.
- [ ] Remove `bundleDependencies` from the package manifest.
- [ ] Re-run the focused test until it passes.

### Task 3: Validate the updater boundary

**Files:**
- Modify: `bin/update-client.cjs`
- Modify: `scripts/update-client.test.mjs`
- Modify: `scripts/package-smoke.mjs`

- [ ] Write a failing `stageUpdate` test asserting that staged `electron-store` resolves from the staged package path before update success is returned.
- [ ] Add the corresponding runtime dependency validation in `stageUpdate`, using Node resolution from `stagedPackagePath` and a readable failure message.
- [ ] Extend package smoke validation to assert that a built archive does not contain a bundled Electron dependency, while standard isolated npm installation remains launchable.
- [ ] Run focused script tests and package smoke using only temporary installation paths.

### Task 4: Release and regression verification

**Files:**
- Create: `.release-notes/self-contained-legacy-update.md`

- [ ] Add a user-facing bug-fix note explaining that older installations can update without requiring a larger download package.
- [ ] Run `npm run typecheck`, `npm test`, `npm run package:smoke`, `npm run release-note:check`, and `git diff --check`.
- [ ] Commit the implementation only after all checks pass; if npm 12 blocks an existing unrelated test, record that exact failure separately from this change's focused checks.
