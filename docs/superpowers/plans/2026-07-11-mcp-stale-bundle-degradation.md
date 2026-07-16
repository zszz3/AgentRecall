# MCP Stale Bundle Degradation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the AgentRecall MCP server available when its optional migration bundle is stale, while omitting only `migrate_session` and reporting an actionable rebuild warning.

**Architecture:** The standalone MCP entry keeps its eight bundle-independent tools on the unconditional startup path. Migration bundle loading validates the runtime contract before caching it; startup catches only migration capability failures, logs one warning, and connects the stdio transport without registering `migrate_session`.

**Tech Stack:** Node.js 22 `node:sqlite`, MCP TypeScript SDK over stdio, Zod 4, Vitest, Electron/Vite build.

## Global Constraints

- Normal bundles must keep all existing nine tools and behavior unchanged.
- Missing, unloadable, or contract-incomplete migration bundles must not prevent MCP `initialize`.
- Degraded startup must keep eight non-migration tools and omit `migrate_session`.
- The warning must include the underlying reason and the exact recovery command `npm run build:mcp`.
- MCP startup must not build files or require development dependencies at runtime.
- Database absence remains fatal because no MCP tool can operate without it.
- Do not change migration targets, migration behavior, database schema, or MCP client configuration.

---

### Task 1: Stale Migration Bundle Soft Degradation

**Files:**
- Modify: `bin/agent-recall-mcp.mjs`
- Modify: `src/core/mcp-server.test.ts`

**Interfaces:**
- Consumes: `runServer()`'s existing database, `McpServer`, `StdioServerTransport`, and Zod initialization; the migration bundle exports `MIGRATION_TARGET_IDS`, `isMigrationTarget`, `SessionStore`, and `migrateSessionForMcp`.
- Produces: `validateMigrationBundle(bundle): void`, which throws an actionable contract error; startup behavior in which `migrate_session` is conditionally registered and all other tools remain unconditional.

- [ ] **Step 1: Write the failing child-process regression test**

Add Node child-process and URL imports to `src/core/mcp-server.test.ts`. Add a helper that creates a temporary package layout containing:

```text
<temp>/bin/agent-recall-mcp.mjs
<temp>/out/mcp/migration-entry.js
<temp>/node_modules -> <repo>/node_modules
<temp>/package.json  { "type": "module" }
<temp>/sessions.db
```

Copy the real MCP entry, write an old-style migration module that exports only `SessionStore`, create a file-backed `SessionStore`, then spawn Node with `AGENT_RECALL_DB=<temp>/sessions.db`. Send newline-delimited JSON-RPC messages in this order:

```ts
{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }
{ jsonrpc: "2.0", method: "notifications/initialized" }
{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
```

Parse stdout by response `id`, terminate the child after `id: 2`, and assert:

```ts
expect(initialize.result.serverInfo.name).toBe("agent-recall");
expect(toolNames).toEqual([
  "search_sessions",
  "get_session",
  "list_projects",
  "list_tags",
  "get_latest_sessions",
  "tag_session",
  "toggle_favorite",
  "set_visibility",
]);
expect(stderr).toContain("migration tools disabled");
expect(stderr).toContain("MIGRATION_TARGET_IDS");
expect(stderr).toContain("npm run build:mcp");
```

The helper must enforce a five-second timeout, report early child exit with captured stderr, close the seeded store before spawn, and remove the temporary directory in `finally`.

- [ ] **Step 2: Run the regression test and verify RED**

Run:

```bash
npm test -- --run src/core/mcp-server.test.ts
```

Expected: the new child-process test fails because the child exits before returning response `id: 1`, with stderr containing the current `Cannot convert undefined or null to object` startup failure.

- [ ] **Step 3: Add explicit migration bundle contract validation**

In `bin/agent-recall-mcp.mjs`, validate an imported candidate before assigning it to the module cache:

```js
function validateMigrationBundle(bundle) {
  if (!Array.isArray(bundle?.MIGRATION_TARGET_IDS) || bundle.MIGRATION_TARGET_IDS.length === 0) {
    throw new Error("migration bundle is missing MIGRATION_TARGET_IDS");
  }
  for (const name of ["isMigrationTarget", "SessionStore", "migrateSessionForMcp"]) {
    if (typeof bundle[name] !== "function") {
      throw new Error(`migration bundle is missing ${name}`);
    }
  }
}
```

Change `loadMigrationBundle()` so it imports into a local variable, validates it, and caches only a valid module. Preserve the existing candidate order and include the validation/import error in the final thrown message.

- [ ] **Step 4: Move migration registration behind a startup capability boundary**

Keep the existing eight non-migration `server.registerTool` calls unconditional. Replace eager schema initialization with a nullable capability:

```js
let migrateTargetSchema = null;
try {
  migrateTargetSchema = await migrationTargetSchema(z);
} catch (error) {
  process.stderr.write(
    `agent-recall MCP migration tools disabled: ${error instanceof Error ? error.message : String(error)}. ` +
      "Run `npm run build:mcp` in the AgentRecall install directory, then restart the MCP client.\n",
  );
}
```

Wrap only the existing `migrate_session` registration in `if (migrateTargetSchema)`. Do not catch database setup, SDK loading, transport connection, or base-tool registration errors.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
npm test -- --run src/core/mcp-server.test.ts
```

Expected: all tests in `src/core/mcp-server.test.ts` pass, including the child-process stale-bundle handshake test.

- [ ] **Step 6: Add a normal-bundle startup assertion**

Reuse the child-process JSON-RPC helper with the worktree's real `out/mcp/migration-entry.js`. Assert the returned tool names contain `migrate_session` and stderr does not contain `migration tools disabled`. This proves the soft-degradation branch does not change the normal nine-tool contract.

- [ ] **Step 7: Run focused tests again**

Run:

```bash
npm test -- --run src/core/mcp-server.test.ts
```

Expected: all focused tests pass with both degraded and normal startup paths covered.

- [ ] **Step 8: Commit the behavior and regression tests**

```bash
git add bin/agent-recall-mcp.mjs src/core/mcp-server.test.ts
git commit -m "fix: degrade MCP when migration bundle is stale"
```

### Task 2: Full Verification and Documentation Closeout

**Files:**
- Modify only if verification exposes a defect: `bin/agent-recall-mcp.mjs`, `src/core/mcp-server.test.ts`
- Existing design: `docs/superpowers/specs/2026-07-11-mcp-stale-bundle-degradation-design.md`

**Interfaces:**
- Consumes: Task 1's conditional `migrate_session` registration and regression harness.
- Produces: verified build artifacts and evidence that the full repository remains healthy.

- [ ] **Step 1: Run static and complete automated verification**

Run each command separately:

```bash
npm run typecheck
npm test -- --run
npm run build
git diff --check
```

Expected: TypeScript exits 0; all Vitest files and tests pass; `build:mcp` plus Electron/Vite build exits 0; `git diff --check` prints nothing.

- [ ] **Step 2: Run a fresh real stdio handshake probe**

Spawn `node bin/agent-recall-mcp.mjs` with the live database pointer, send `initialize`, `notifications/initialized`, and `tools/list`, and verify response `id: 1` names `agent-recall` and response `id: 2` contains all nine tools including `migrate_session`.

- [ ] **Step 3: Inspect final repository state**

Run:

```bash
git status --short --branch
git log -3 --oneline
```

Expected: only intentional plan or implementation changes are present; ignored `out/` build products do not appear; the branch contains the design commit and implementation commit.

- [ ] **Step 4: Record durable project memory**

Update `/Users/xjx/Documents/Obsidian Vault/Codex/projects/agent-recall.md` with a dated concise note covering the root cause, soft-degradation behavior, tests, branch, and commit. Do not store credentials or raw logs. Update `TODO.md` only if verification leaves an unresolved action.

- [ ] **Step 5: Commit any verification-driven source correction**

Only when Step 1 or Step 2 required a source correction:

```bash
git add bin/agent-recall-mcp.mjs src/core/mcp-server.test.ts
git commit -m "fix: complete MCP degradation verification"
```

If no correction was needed, do not create an empty commit.
