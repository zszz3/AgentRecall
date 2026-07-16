# Extended CLI Session Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TClaude, TCodex, Claude Code Internal, and Codex Internal first-class bidirectional local session-migration environments in the desktop UI and MCP tool, gated by the existing optional-source settings.

**Architecture:** Keep `MigrationAgent` as the three portable JSONL format families and add `MigrationTarget` for the seven concrete runtime environments. A renderer-safe target registry owns labels, family/source mappings, and Settings gates; writer, indexer, platform, UI, IPC, and MCP resolve all target-specific behavior through that registry while remote restore remains on the three base agents.

**Tech Stack:** TypeScript, Electron, React, Vitest, Node.js filesystem/process APIs, SQLite, MCP SDK/Zod

---

## File Structure

- Create `src/core/migration-targets.ts`: renderer-safe target registry, labels, family/source mapping, Settings gates.
- Create `src/core/migration-targets.test.ts`: registry and four-switch matrix tests.
- Modify `src/core/types.ts`: add `MigrationTarget`; use it in local migration progress/result/record types.
- Modify `src/core/session-migration.ts` and tests: enable TClaude/TCodex/Internal sources and concrete targets.
- Modify `src/core/session-migration-writers.ts` and tests: family-based serialization plus target-specific roots and round-trip sources.
- Modify `src/core/indexer.ts` and tests: incrementally index into the concrete target source namespace.
- Modify `src/core/platform.ts` and tests: target binaries, multi-line version checks, scoped `CODEX_HOME`, shell-safe resume commands.
- Modify `src/main/index.ts`, `src/preload/index.ts`, renderer UI and tests: Settings-gated buttons, IPC validation, consistent Internal labels.
- Modify `src/core/mcp-migration.ts`, `src/mcp/migration-entry.ts`, `bin/agent-recall-mcp.mjs`, and tests: seven MCP targets with backend Settings enforcement.
- Modify `README.md` and `docs/README.en.md`: document the enabled-target behavior and local-only boundary.

### Task 1: Target Registry And Settings Model

**Files:**
- Create: `src/core/migration-targets.ts`
- Create: `src/core/migration-targets.test.ts`
- Modify: `src/core/types.ts:60-117`
- Modify: `src/core/platform.ts:50-110`

- [ ] **Step 1: Write failing registry tests**

Create `src/core/migration-targets.test.ts` with the complete expected matrix:

```ts
import { describe, expect, it } from "vitest";
import {
  BASE_MIGRATION_TARGETS,
  MIGRATION_TARGETS,
  enabledMigrationTargets,
  migrationTargetDescriptor,
} from "./migration-targets";

describe("migration target registry", () => {
  it("defines seven unique targets in display order", () => {
    expect(MIGRATION_TARGETS.map((item) => item.id)).toEqual([
      "claude", "codex", "codebuddy", "tclaude", "tcodex",
      "claude-internal", "codex-internal",
    ]);
    expect(new Set(MIGRATION_TARGETS.map((item) => item.id)).size).toBe(7);
    expect(BASE_MIGRATION_TARGETS).toEqual(["claude", "codex", "codebuddy"]);
  });

  it.each([
    ["tclaude", "TClaude", "claude", "tclaude-cli", "includeTclaude"],
    ["tcodex", "TCodex", "codex", "tcodex-cli", "includeTcodex"],
    ["claude-internal", "Claude Code Internal", "claude", "claude-internal", "includeClaudeInternal"],
    ["codex-internal", "Codex Internal", "codex", "codex-internal", "includeCodexInternal"],
  ] as const)("maps %s", (id, label, family, source, gate) => {
    expect(migrationTargetDescriptor(id)).toMatchObject({ id, label, family, source, enabledSetting: gate });
  });

  it("enables each optional target only through its own setting", () => {
    const off = {
      includeTclaude: false,
      includeTcodex: false,
      includeClaudeInternal: false,
      includeCodexInternal: false,
    };
    expect(enabledMigrationTargets(off)).toEqual(BASE_MIGRATION_TARGETS);
    expect(enabledMigrationTargets({ ...off, includeTclaude: true })).toEqual([...BASE_MIGRATION_TARGETS, "tclaude"]);
    expect(enabledMigrationTargets({ ...off, includeTcodex: true })).toEqual([...BASE_MIGRATION_TARGETS, "tcodex"]);
    expect(enabledMigrationTargets({ ...off, includeClaudeInternal: true })).toEqual([...BASE_MIGRATION_TARGETS, "claude-internal"]);
    expect(enabledMigrationTargets({ ...off, includeCodexInternal: true })).toEqual([...BASE_MIGRATION_TARGETS, "codex-internal"]);
  });
});
```

- [ ] **Step 2: Run the registry test to verify RED**

Run:

```bash
npm test -- src/core/migration-targets.test.ts --run
```

Expected: FAIL because `migration-targets.ts` and `MigrationTarget` do not exist.

- [ ] **Step 3: Add the target type and registry**

Add to `src/core/types.ts`:

```ts
export type MigrationAgent = "claude" | "codex" | "codebuddy";
export type MigrationTarget =
  | MigrationAgent
  | "tclaude"
  | "tcodex"
  | "claude-internal"
  | "codex-internal";
```

Create `src/core/migration-targets.ts`:

```ts
import type { MigrationAgent, MigrationTarget, SessionSource } from "./types";

export type OptionalMigrationTargetSetting =
  | "includeTclaude"
  | "includeTcodex"
  | "includeClaudeInternal"
  | "includeCodexInternal";

export type MigrationTargetSettings = Record<OptionalMigrationTargetSetting, boolean>;

export interface MigrationTargetDescriptor {
  id: MigrationTarget;
  label: string;
  family: MigrationAgent;
  source: SessionSource;
  enabledSetting: OptionalMigrationTargetSetting | null;
}

export const MIGRATION_TARGETS = [
  { id: "claude", label: "Claude Code", family: "claude", source: "claude-cli", enabledSetting: null },
  { id: "codex", label: "Codex", family: "codex", source: "codex-cli", enabledSetting: null },
  { id: "codebuddy", label: "CodeBuddy", family: "codebuddy", source: "codebuddy-cli", enabledSetting: null },
  { id: "tclaude", label: "TClaude", family: "claude", source: "tclaude-cli", enabledSetting: "includeTclaude" },
  { id: "tcodex", label: "TCodex", family: "codex", source: "tcodex-cli", enabledSetting: "includeTcodex" },
  { id: "claude-internal", label: "Claude Code Internal", family: "claude", source: "claude-internal", enabledSetting: "includeClaudeInternal" },
  { id: "codex-internal", label: "Codex Internal", family: "codex", source: "codex-internal", enabledSetting: "includeCodexInternal" },
] as const satisfies readonly MigrationTargetDescriptor[];

export const MIGRATION_TARGET_IDS = [
  "claude", "codex", "codebuddy", "tclaude", "tcodex", "claude-internal", "codex-internal",
] as const satisfies readonly MigrationTarget[];
export const BASE_MIGRATION_TARGETS = ["claude", "codex", "codebuddy"] as const;

export function migrationTargetDescriptor(target: MigrationTarget): MigrationTargetDescriptor {
  const descriptor = MIGRATION_TARGETS.find((item) => item.id === target);
  if (!descriptor) throw new Error(`Unsupported migration target: ${target}`);
  return descriptor;
}

export function enabledMigrationTargets(settings: MigrationTargetSettings): MigrationTarget[] {
  return MIGRATION_TARGETS
    .filter((item) => item.enabledSetting === null || settings[item.enabledSetting])
    .map((item) => item.id);
}

export function assertMigrationTargetEnabled(target: MigrationTarget, settings: MigrationTargetSettings): void {
  const descriptor = migrationTargetDescriptor(target);
  if (descriptor.enabledSetting && !settings[descriptor.enabledSetting]) {
    throw new Error(`${descriptor.label} migration target is disabled in Settings.`);
  }
}
```

Add `claudeInternalBinary: string` to `AppSettings` and default it to `"claude-internal"`. Keep the existing four include flags unchanged.

- [ ] **Step 4: Run tests and typecheck to verify GREEN**

Run:

```bash
npm test -- src/core/migration-targets.test.ts --run
npm run typecheck
```

Expected: registry tests and typecheck pass. Task 1 adds the new type without changing existing local migration signatures.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/core/types.ts src/core/migration-targets.ts src/core/migration-targets.test.ts src/core/platform.ts
git commit -m "feat: define extended migration targets"
```

### Task 2: Migration Source Families And Generic Target Discovery

**Files:**
- Modify: `src/core/session-migration.ts:1-140`
- Modify: `src/core/session-migration.test.ts:150-220`

- [ ] **Step 1: Write failing source/target tests**

Extend `src/core/session-migration.test.ts`:

```ts
it.each([
  ["tclaude-cli", "claude"],
  ["tcodex-cli", "codex"],
] as const)("maps %s to %s", (source, expected) => {
  expect(migrationAgentForSource(source)).toBe(expected);
});

it.each([
  "claude-cli", "claude-app", "claude-internal", "tclaude-cli",
  "codex-cli", "codex-app", "codex-internal", "tcodex-cli", "codebuddy-cli",
] as const)("allows %s to migrate to every enabled concrete target", (source) => {
  expect(supportedMigrationTargets(source, [
    "claude", "codex", "codebuddy", "tclaude", "tcodex", "claude-internal", "codex-internal",
  ])).toHaveLength(7);
});

```

- [ ] **Step 2: Run the domain tests to verify RED**

Run:

```bash
npm test -- src/core/session-migration.test.ts --run
```

Expected: FAIL because TClaude/TCodex are unsupported sources and target discovery is fixed to the three base agents.

- [ ] **Step 3: Add source mappings and generic target discovery**

In `session-migration.ts`, keep orchestration target signatures on `MigrationAgent` until Task 6. Add the source mappings and make discovery generic so existing callers still infer the three-value type:

```ts
export function migrationAgentForSource(source: SessionSource): MigrationAgent | null {
  switch (source) {
    case "claude-cli":
    case "claude-app":
    case "claude-internal":
    case "tclaude-cli":
      return "claude";
    case "codex-cli":
    case "codex-app":
    case "codex-internal":
    case "tcodex-cli":
      return "codex";
    case "codebuddy-cli":
      return "codebuddy";
    default:
      return null;
  }
}

export function supportedMigrationTargets(source: SessionSource): MigrationAgent[];
export function supportedMigrationTargets<T extends MigrationTarget>(
  source: SessionSource,
  enabledTargets: readonly T[],
): T[];
export function supportedMigrationTargets(
  source: SessionSource,
  enabledTargets: readonly MigrationTarget[] = BASE_MIGRATION_TARGETS,
): MigrationTarget[] {
  return migrationAgentForSource(source) ? [...enabledTargets] : [];
}
```

- [ ] **Step 4: Run source-domain tests and typecheck**

Run:

```bash
npm test -- src/core/migration-targets.test.ts src/core/session-migration.test.ts --run
npm run typecheck
```

Expected: source-domain tests and typecheck pass; existing callers continue to infer `MigrationAgent[]` when they omit the second argument.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/core/session-migration.ts src/core/session-migration.test.ts
git commit -m "feat: support extended migration sources"
```

### Task 3: Target-Specific Writers And Round-Trip Validation

**Files:**
- Modify: `src/core/session-migration-writers.ts:1-460`
- Modify: `src/core/session-migration-writers.test.ts:1-430`

- [ ] **Step 1: Write failing seven-target path and round-trip tests**

Add this table to `session-migration-writers.test.ts`:

```ts
import {
  loadClaudeCliSessionRows,
  loadCodeBuddyCliSessionFile,
  loadCodexSessionRows,
  parseJsonlText,
} from "./session-loader";
import type { LoadedSession, MigrationTarget, SessionSource } from "./types";

function loadForExpectedSource(source: SessionSource, filePath: string): LoadedSession | null {
  const rows = parseJsonlText(fs.readFileSync(filePath, "utf8"));
  if (source === "codebuddy-cli") return loadCodeBuddyCliSessionFile(filePath);
  if (source === "codex-cli" || source === "tcodex-cli" || source === "codex-internal") {
    return loadCodexSessionRows(filePath, rows, { sourceOverride: source });
  }
  return loadClaudeCliSessionRows(filePath, rows, { source });
}

it.each([
  ["claude", ".claude", "claude-cli"],
  ["tclaude", ".tclaude", "tclaude-cli"],
  ["claude-internal", ".claude-internal", "claude-internal"],
  ["codex", ".codex", "codex-cli"],
  ["tcodex", ".tcodex", "tcodex-cli"],
  ["codex-internal", ".codex-internal", "codex-internal"],
  ["codebuddy", ".codebuddy", "codebuddy-cli"],
] as const)("writes %s under %s and validates as %s", async (target, root, source) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-${target}-`));
  const family = migrationTargetDescriptor(target).family;
  try {
    const written = await writeMigratedSession({
      target,
      session: portable(),
      homeDir,
      now: NOW,
      idFactory: idFactory(family === "codex" ? [SESSION_ID] : [SESSION_ID, ...MESSAGE_IDS]),
    });
    expect(path.relative(homeDir, written.filePath).split(path.sep)[0]).toBe(root);
    expect(loadForExpectedSource(source, written.filePath)?.session).toMatchObject({
      source,
      rawId: written.sessionId,
      originalTitle: "迁移标题 🚀",
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
```

Change `expectRoundTrip`'s target parameter from `MigrationAgent` to `MigrationTarget`, route it through `loadForExpectedSource`, and add the four new targets to the existing mode/cleanup tables that exercise `beforeValidate`.

- [ ] **Step 2: Run writer tests to verify RED**

Run:

```bash
npm test -- src/core/session-migration-writers.test.ts --run
```

Expected: FAIL because `targetFilePath`, serialization, structure validation, and Loader validation only understand three targets.

- [ ] **Step 3: Resolve family and source through the registry**

Update writer signatures to `MigrationTarget`. Use:

```ts
const descriptor = migrationTargetDescriptor(target);
const family = descriptor.family;
```

Dispatch serializer and native structure validation by `family`, not target id. Implement roots:

```ts
const CLAUDE_ROOT: Record<"claude" | "tclaude" | "claude-internal", string> = {
  claude: ".claude",
  tclaude: ".tclaude",
  "claude-internal": ".claude-internal",
};
const CODEX_ROOT: Record<"codex" | "tcodex" | "codex-internal", string> = {
  codex: ".codex",
  tcodex: ".tcodex",
  "codex-internal": ".codex-internal",
};
```

`loadWrittenSession` must pass `descriptor.source` to the Claude/Codex Loader APIs so the returned session key/source match the concrete environment. Keep the existing title, timestamp, parent-chain, `0600`, fsync, atomic rename, and failure cleanup behavior unchanged.

- [ ] **Step 4: Run writer and loader tests**

Run:

```bash
npm test -- src/core/session-migration-writers.test.ts src/core/session-loader.test.ts --run
```

Expected: all writer/loader tests pass for seven targets.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/core/session-migration-writers.ts src/core/session-migration-writers.test.ts
git commit -m "feat: write sessions to extended cli targets"
```

### Task 4: Concrete-Source Incremental Indexing

**Files:**
- Modify: `src/core/indexer.ts:155-185`
- Modify: `src/core/indexer.test.ts:110-145`

- [ ] **Step 1: Expand the incremental-index test to seven targets**

Replace the three-value table with:

```ts
it.each([
  ["claude", "claude-cli"],
  ["tclaude", "tclaude-cli"],
  ["claude-internal", "claude-internal"],
  ["codex", "codex-cli"],
  ["tcodex", "tcodex-cli"],
  ["codex-internal", "codex-internal"],
  ["codebuddy", "codebuddy-cli"],
] as const)("indexes one migrated %s file as %s", async (target, source) => {
  const store = createInMemoryStore();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-recall-index-${target}-`));
  try {
    const written = await writeMigratedSession({
      target,
      homeDir,
      now: new Date("2026-06-23T06:07:08.901Z"),
      session: portableSession(),
    });
    const status = indexMigratedSessionFile(store, target, written.filePath);
    expect(status).toMatchObject({ indexed: 1, total: 1, error: null });
    expect(store.searchSessions({ source })).toEqual([expect.objectContaining({ source })]);
  } finally {
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the indexer test to verify RED**

Run:

```bash
npm test -- src/core/indexer.test.ts --run
```

Expected: FAIL because `loadMigratedSessionFile` treats every non-Codex/non-CodeBuddy target as ordinary Claude.

- [ ] **Step 3: Load via descriptor family/source**

Change target types to `MigrationTarget` and implement:

```ts
function loadMigratedSessionFile(target: MigrationTarget, filePath: string): LoadedSession | null {
  const descriptor = migrationTargetDescriptor(target);
  const rows = parseJsonlText(fs.readFileSync(filePath, "utf8"));
  if (descriptor.family === "codex") {
    return loadCodexSessionRows(filePath, rows, { sourceOverride: descriptor.source });
  }
  if (descriptor.family === "codebuddy") return loadCodeBuddyCliSessionFile(filePath);
  return loadClaudeCliSessionRows(filePath, rows, { source: descriptor.source });
}
```

- [ ] **Step 4: Run indexer tests to verify GREEN**

Run:

```bash
npm test -- src/core/indexer.test.ts src/core/session-migration-writers.test.ts --run
```

Expected: all migrated files are indexed under their concrete source.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/core/indexer.ts src/core/indexer.test.ts
git commit -m "feat: index extended migration targets"
```

### Task 5: Target CLI Preflight And Resume Commands

**Files:**
- Modify: `src/core/platform.ts:40-110,185-335,780-1010`
- Modify: `src/core/platform.test.ts:720-970`

- [ ] **Step 1: Write failing binary/process/version tests**

Add configured binaries and expected process specs:

```ts
const extendedSettings = {
  ...defaultSettings,
  tclaudeBinary: "/opt/TClaude/tclaude",
  tcodexBinary: "/opt/TCodex/tcodex",
  claudeInternalBinary: "/opt/Claude Internal/claude-internal",
  codexBinary: "/opt/Codex/codex",
};

expect(migrationBinary("tclaude", extendedSettings)).toBe("/opt/TClaude/tclaude");
expect(migrationBinary("tcodex", extendedSettings)).toBe("/opt/TCodex/tcodex");
expect(migrationBinary("claude-internal", extendedSettings)).toBe("/opt/Claude Internal/claude-internal");
expect(migrationBinary("codex-internal", extendedSettings)).toBe("/opt/Codex/codex");

expect(getMigrationResumeProcessSpec("codex-internal", "id-1", "/repo", extendedSettings, { homeDir: "/home/me" })).toMatchObject({
  command: "/opt/Codex/codex",
  args: ["resume", "id-1"],
  cwd: "/repo",
  env: { CODEX_HOME: "/home/me/.codex-internal" },
  displayCommand: "cd /repo && CODEX_HOME=/home/me/.codex-internal /opt/Codex/codex resume id-1",
});
```

Add wrapper version fixtures using the exact verified outputs and assert missing wrapper/upstream lines and low versions fail with target-specific messages.

- [ ] **Step 2: Run platform tests to verify RED**

Run:

```bash
npm test -- src/core/platform.test.ts --run
```

Expected: FAIL because binaries, resume specs, env, and wrapper version parsing support only three targets.

- [ ] **Step 3: Implement target-specific process specs**

Change platform migration APIs to `MigrationTarget`. Add `env?: Record<string, string>` to the process spec and an optional `{ homeDir?: string; platform?: NodeJS.Platform }` argument.

Map binaries/args as follows:

```ts
function migrationBinary(target: MigrationTarget, settings: AppSettings): string {
  if (target === "claude") return settings.claudeBinary;
  if (target === "tclaude") return settings.tclaudeBinary;
  if (target === "claude-internal") return settings.claudeInternalBinary;
  if (target === "codebuddy") return settings.codeBuddyBinary;
  if (target === "tcodex") return settings.tcodexBinary;
  return settings.codexBinary;
}

function migrationResumeArgs(target: MigrationTarget, sessionId: string): string[] {
  return migrationTargetDescriptor(target).family === "codex"
    ? ["resume", sessionId]
    : ["--resume", sessionId];
}
```

Only `codex-internal` receives `{ CODEX_HOME: path.join(homeDir, ".codex-internal") }`. Generate POSIX inline env assignment, PowerShell `try/finally` restoration, and cmd `setlocal`/`endlocal` from the same process spec. Do not leave a second fallback target switch in `src/main/index.ts` or `src/core/mcp-migration.ts`.

- [ ] **Step 4: Implement target-specific version rules**

Represent each target as required labelled version lines:

```ts
const TARGET_VERSION_RULES: Record<MigrationTarget, readonly VersionRule[]> = {
  claude: [{ label: "Claude Code", pattern: /(?:Claude Code\s+)?(\d+\.\d+(?:\.\d+)?)/i, minimum: "2.1.186" }],
  codex: [{ label: "Codex", pattern: /(?:codex(?:-cli)?\s+)?(\d+\.\d+(?:\.\d+)?)/i, minimum: "0.141.0" }],
  codebuddy: [{ label: "CodeBuddy", pattern: /(?:CodeBuddy\s+)?(\d+\.\d+(?:\.\d+)?)/i, minimum: "2.109.1" }],
  tclaude: [
    { label: "@tencent/tclaude", pattern: /@tencent\/tclaude\s+(\d+\.\d+\.\d+)/, minimum: "0.0.9" },
    { label: "@anthropic-ai/claude-code", pattern: /@anthropic-ai\/claude-code\s+(\d+\.\d+\.\d+)/, minimum: "2.1.154" },
  ],
  tcodex: [
    { label: "@tencent/tcodex", pattern: /@tencent\/tcodex\s+(\d+\.\d+\.\d+)/, minimum: "0.0.13" },
    { label: "@openai/codex", pattern: /@openai\/codex\s+(\d+\.\d+\.\d+)/, minimum: "0.142.4" },
  ],
  "claude-internal": [
    { label: "claude-internal", pattern: /claude-internal:\s*(\d+\.\d+\.\d+)/, minimum: "1.1.9" },
    { label: "claude", pattern: /^claude:\s*(\d+\.\d+\.\d+)/m, minimum: "2.1.154" },
  ],
  "codex-internal": [{ label: "Codex", pattern: /(?:codex-cli\s+)?(\d+\.\d+\.\d+)/i, minimum: "0.141.0" }],
};
```

Extend `CliVersionRunner` to accept an optional env and use scoped `CODEX_HOME` for the internal target. Preserve clear ENOENT, empty, unparseable, and too-old messages.

- [ ] **Step 5: Run platform tests and typecheck**

Run:

```bash
npm test -- src/core/platform.test.ts --run
npm run typecheck
```

Expected: target process/version tests and typecheck pass. Existing three-target callers remain valid because `MigrationAgent` is a subset of `MigrationTarget`.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/core/platform.ts src/core/platform.test.ts
git commit -m "feat: launch extended migration targets"
```

### Task 6: Desktop Settings, UI, IPC, And Labels

**Files:**
- Modify: `src/core/types.ts:60-117`
- Modify: `src/core/session-migration.ts:1-340`
- Modify: `src/core/session-migration.test.ts:250-780`
- Modify: `src/core/session-store.ts:150-165,1020-1070`
- Modify: `src/core/session-store.test.ts:570-700`
- Modify: `src/main/index.ts:1250-1300,1745-1790`
- Modify: `src/preload/index.ts:1-135`
- Modify: `src/renderer/src/session-ui.ts:1-85`
- Modify: `src/renderer/src/session-ui.test.ts:1-80`
- Modify: `src/renderer/src/components/session-migration-dialog.tsx:1-130`
- Modify: `src/renderer/src/App.tsx:1350-1410,2135-2150,2940-3030`
- Modify: `src/renderer/src/session-migration-ui.test.ts`
- Modify: `src/renderer/src/detail-panel-actions.test.ts`
- Modify: `src/core/format-session.ts:1-20`

- [ ] **Step 1: Write failing concrete-target orchestration and record tests**

Add to `session-migration.test.ts`:

```ts
it("orchestrates and records a concrete target", async () => {
  const fixture = createDependencies();
  const result = await migrateSession({
    source: session("tclaude-cli"),
    messages,
    target: "codex-internal",
    deps: fixture.deps,
  });
  expect(result.target).toBe("codex-internal");
  expect(fixture.seenRecords).toEqual([
    expect.objectContaining({ sourceAgent: "claude", targetAgent: "codex-internal" }),
  ]);
});
```

Add a `session-store.test.ts` round trip using `targetAgent: "tcodex"` and assert the same value is returned.

- [ ] **Step 2: Write failing UI availability and naming tests**

Extend `session-ui.test.ts`:

```ts
it("shows Internal names and Settings-gated migration targets", () => {
  expect(sourceFilters({
    ...defaultSettings,
    includeTclaude: true,
    includeTcodex: true,
    includeClaudeInternal: true,
    includeCodexInternal: true,
  }).map((item) => item.label)).toEqual(expect.arrayContaining([
    "TClaude", "TCodex", "Claude Code Internal", "Codex Internal",
  ]));

  expect(migrationTargetsForSource("tclaude-cli", defaultSettings)).toEqual(["claude", "codex", "codebuddy"]);
  expect(migrationTargetsForSource("tclaude-cli", { ...defaultSettings, includeTclaude: true })).toEqual([
    "claude", "codex", "codebuddy", "tclaude",
  ]);
});
```

Add source-contract assertions that the dialog receives `targets`, renders `targets.map`, and no longer hardcodes `(["claude", "codex", "codebuddy"] as const)`.

- [ ] **Step 3: Run domain/renderer tests to verify RED**

Run:

```bash
npm test -- src/core/session-migration.test.ts src/core/session-store.test.ts src/renderer/src/session-ui.test.ts src/renderer/src/session-migration-ui.test.ts src/renderer/src/detail-panel-actions.test.ts --run
```

Expected: FAIL because orchestration/result/record types still use `MigrationAgent`, labels are `Extra`, and the dialog hardcodes three buttons.

- [ ] **Step 4: Promote local migration flow to `MigrationTarget`**

Keep `PortableSession.sourceAgent: MigrationAgent`, but change progress, result, record target, orchestrator options/dependencies, and safe/fallback target parameters to `MigrationTarget`:

```ts
export interface SessionMigrationProgress {
  sessionKey: string;
  target: MigrationTarget;
  stage: SessionMigrationStage;
  percent?: number;
  compression?: MigrationCompressionEvent;
}
export interface SessionMigrationResult {
  target: MigrationTarget;
  targetSessionId: string;
  targetFilePath: string;
  strategy: SessionMigrationStrategy;
  resumeCommand: string;
  indexed: boolean;
  launched: boolean;
  warning?: string;
}
export interface SessionMigrationRecord {
  id: string;
  sourceSessionKey: string;
  sourceAgent: MigrationAgent;
  targetAgent: MigrationTarget;
  targetSessionId: string;
  targetFilePath: string;
  strategy: SessionMigrationStrategy;
  createdAt: number;
}
```

Replace the old `MIGRATION_AGENTS.includes(target)` validation with `migrationTargetDescriptor(target)`. SQLite remains `TEXT`; update its row types only.

- [ ] **Step 5: Drive UI targets from Settings and registry**

In `session-ui.ts`:

```ts
export function migrationTargetsForSource(source: SessionSource, settings: MigrationTargetSettings): MigrationTarget[] {
  return supportedMigrationTargets(source, enabledMigrationTargets(settings));
}

export function migrationAgentLabel(target: MigrationTarget): string {
  return migrationTargetDescriptor(target).label;
}
```

Rename every `Claude Extra` / `Codex Extra` label. Change `SessionMigrationDialog` to accept `targets: readonly MigrationTarget[]` and render only those values. In `App.tsx`, compute targets with the current settings and pass them into the dialog.

Update the four Settings subtitles to say the toggle indexes the source and enables the migration target. Do not add another toggle.

- [ ] **Step 6: Enforce Settings again in the main process**

Before `migrateSession` in `ipcMain.handle("session:migrate", ...)`, call:

```ts
assertMigrationTargetEnabled(target, getSettings());
```

Change IPC/preload types to `MigrationTarget`. Delete the local fallback binary/argument switch and use the platform helper that builds a safe target-specific display command from the shared process spec.

- [ ] **Step 7: Run desktop/domain tests and typecheck**

Run:

```bash
npm test -- src/core/session-migration.test.ts src/core/session-store.test.ts src/renderer/src/session-ui.test.ts src/renderer/src/session-migration-ui.test.ts src/renderer/src/detail-panel-actions.test.ts src/core/platform.test.ts --run
npm run typecheck
```

Expected: UI/IPC tests pass and no desktop migration type errors remain.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/core/types.ts src/core/session-migration.ts src/core/session-migration.test.ts src/core/session-store.ts src/core/session-store.test.ts src/main/index.ts src/preload/index.ts src/renderer/src/App.tsx src/renderer/src/session-ui.ts src/renderer/src/session-ui.test.ts src/renderer/src/components/session-migration-dialog.tsx src/renderer/src/session-migration-ui.test.ts src/renderer/src/detail-panel-actions.test.ts src/core/format-session.ts
git commit -m "feat: expose settings-gated migration targets"
```

### Task 7: MCP Seven-Target Support

**Files:**
- Modify: `src/core/mcp-migration.ts:1-230`
- Modify: `src/core/mcp-migration.test.ts:1-410`
- Modify: `src/mcp/migration-entry.ts:1-45`
- Modify: `bin/agent-recall-mcp.mjs:285-315,430-485`
- Modify: `src/core/mcp-server.test.ts:240-285`

- [ ] **Step 1: Write failing MCP target/gate tests**

Add to `mcp-migration.test.ts`:

```ts
it("migrates a TClaude source to enabled Codex Internal", async () => {
  const settings = { ...defaultSettings, includeCodexInternal: true };
  const store = createInMemoryStore();
  const { sessionKey, projectPath } = seedLocalSession(store, {
    source: "tclaude-cli",
    sessionKey: "tclaude:source-1",
  });
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-home-"));
  try {
    const result = await migrateSessionForMcp(
      { sessionKey, target: "codex-internal" },
      { store, settings, homeDir, inspectCli: noOpInspect },
    );
    expect(result).toMatchObject({ target: "codex-internal", launched: false });
    expect(store.getSession(`codex-internal:${result.targetSessionId}`)?.source).toBe("codex-internal");
  } finally {
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

it("rejects a disabled optional MCP target before CLI inspection", async () => {
  const store = createInMemoryStore();
  const { sessionKey, projectPath } = seedLocalSession(store);
  const inspectCli = vi.fn(noOpInspect);
  try {
    await expect(migrateSessionForMcp(
      { sessionKey, target: "tcodex" },
      { store, settings: defaultSettings, inspectCli },
    )).rejects.toThrow("TCodex migration target is disabled in Settings");
    expect(inspectCli).not.toHaveBeenCalled();
  } finally {
    store.close();
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
```

Update `mcp-server.test.ts` to accept `target: "tclaude"` and continue rejecting `"gemini"`.

- [ ] **Step 2: Run MCP tests to verify RED**

Run:

```bash
npm test -- src/core/mcp-migration.test.ts src/core/mcp-server.test.ts --run
```

Expected: FAIL because input types/schema only accept three targets and MCP does not enforce Settings.

- [ ] **Step 3: Use shared target/gate/platform helpers in MCP**

Change `McpMigrateSessionInput.target` and dependency callbacks to `MigrationTarget`. Immediately after loading settings, run:

```ts
assertMigrationTargetEnabled(input.target, settings);
```

Use `writeMigratedSession`, `indexMigratedSessionFile`, `inspectMigrationCli`, and the shared process-spec display command with the concrete target. Remove MCP's local `target === "claude" ? ...` fallback switch.

Export required registry/target helpers from `src/mcp/migration-entry.ts`. Update the server schema:

```ts
target: z.enum([
  "claude", "codex", "codebuddy", "tclaude", "tcodex",
  "claude-internal", "codex-internal",
])
```

Update the MCP description with the four optional targets and Settings requirement.

- [ ] **Step 4: Rebuild and run MCP tests**

Run:

```bash
npm run build:mcp
npm test -- src/core/mcp-migration.test.ts src/core/mcp-server.test.ts --run
npm run typecheck
```

Expected: MCP core/server/settings tests pass; the generated bundle loads seven-target code.

- [ ] **Step 5: Commit Task 7**

```bash
git add src/core/mcp-migration.ts src/core/mcp-migration.test.ts src/mcp/migration-entry.ts bin/agent-recall-mcp.mjs src/core/mcp-server.test.ts
git commit -m "feat: extend mcp session migration targets"
```

### Task 8: Documentation, Local Smoke Tests, And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/README.en.md`
- Modify: tests touched by any final compatibility correction

- [ ] **Step 1: Update user documentation**

Document:

```markdown
- Optional TClaude, TCodex, Claude Code Internal, and Codex Internal sources can also be migration sources and targets.
- Their migration buttons appear only when the matching Optional sources switch is enabled.
- Migration remains local-only; remote restore still targets Claude Code, Codex, or CodeBuddy.
```

Use the equivalent Chinese wording in `README.md` and English wording in `docs/README.en.md`.

- [ ] **Step 2: Run real read-only CLI preflight**

Run without starting sessions:

```bash
tclaude --version
tcodex --version
claude-internal --version
CODEX_HOME="$HOME/.codex-internal" codex --version
```

Expected: outputs match or exceed the target-specific baselines. Do not print config/auth file contents.

- [ ] **Step 3: Run temporary-home writer/indexer smoke tests**

Run the focused tests that write only under test-created temp homes:

```bash
npm test -- src/core/migration-targets.test.ts src/core/session-migration-writers.test.ts src/core/indexer.test.ts src/core/platform.test.ts src/core/mcp-migration.test.ts --run
```

Expected: all four new targets write, round-trip, and index without touching real CLI session directories.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm run typecheck
npm test -- --run
npm run build
git diff --check
```

Expected: typecheck, all tests, and production build pass; no whitespace errors.

- [ ] **Step 5: Verify scope and compatibility**

Run:

```bash
git diff --stat 0b8f52f..HEAD
git status -sb
```

Confirm remote restore still declares `RESTORE_TARGETS: MigrationAgent[] = ["claude", "codex", "codebuddy"]`, portable `sourceAgent` remains a three-value family, and no real `~/.tclaude` / `~/.tcodex` / Internal session file was created.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs/README.en.md
git commit -m "docs: document extended cli migration"
```

- [ ] **Step 7: Request code review**

Review the complete range from design commit `0b8f52f` to `HEAD`, fix every Critical/Important issue, rerun the focused tests plus complete verification, verify `git status -sb` is clean, then use `superpowers:finishing-a-development-branch` to choose merge/PR/keep behavior.
