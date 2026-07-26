# Privacy & Diagnostics Integration Interface

The independent entry point is `src/privacy/index.ts`. It deliberately has no
Electron, renderer, `SessionStore`, network, or global-home dependency. Parent
integration must pass every capability and every filesystem root explicitly.

## Core boundary

- Adapt the existing session discovery/loading functions to
  `UpstreamSessionReader`. Expose only the returned `upstreamSessions.list()` and
  `upstreamSessions.read()` methods across IPC. Do not pass `SessionStore` or a
  filesystem writer through this boundary. The facade returns detached, frozen
  values and has no delete, remove, unlink, rename, or write operation.
- Call `afterFirstWindowReady()` only after the first usable window exists. Pass
  the native updater check as `checkForUpdates`; the callback is unreachable
  when automatic checks are disabled. Pass summary backfill, remote sync, skill
  sync, quota polling, or similar optional work as `startAdvancedTasks`; the
  callback is unreachable when advanced tasks are disabled.
- Build the diagnostic input from already-known app state and small local
  probes. `collectDiagnostics()` itself never invokes a CLI or performs network
  I/O. Credential-like keys and inline tokens are always redacted. Set
  `pathMode` to `home` (default), `basename`, or an explicitly consented `full`.

## Legacy integration cleanup

The UI/IPC integration must keep these as three separate user actions:

1. `inspectLegacy({ homeDir })` reads known Claude, Codex, and CodeBuddy config
   locations beneath the supplied root. It reports AgentRecall MCP, hook, and
   status-line entries plus parse/read issues; it writes nothing.
2. `previewLegacyCleanup({ homeDir, backupRoot })` returns exact file actions,
   source hashes, a plan ID, and a confirmation token. Show every action and any
   issue to the user. Preview creates no directory or backup.
3. After explicit confirmation, pass that unchanged plan and exact token to
   `applyLegacyCleanup(plan, token)`. It rejects stale source hashes, writes
   versioned backups first, and removes only entries identified by exact
   AgentRecall MCP keys/sections or known AgentRecall command names. Foreign MCP
   servers, hooks, status lines, and settings remain.

The confirmation token prevents accidental application of a different preview;
it is not an authentication secret. Register `applyLegacyCleanup` only inside a
trusted main-process service. Do not expose the function or an unrestricted
filesystem-root argument directly to renderer code. If IPC is added, the main
process must retain the previewed plan, accept only its opaque plan ID plus user
confirmation from the renderer, and apply the retained plan itself.

Never call cleanup during startup, update, uninstall, diagnostics collection, or
legacy detection. Production should place `backupRoot` in an AgentRecall-owned
data directory. Tests must pass a temporary HOME and temporary backup root.

## Diagnostic payload

`PrivacyDiagnosticReport` includes:

- application version and report time;
- OS platform, architecture, and release;
- AgentRecall data-directory and database health;
- per-source and total session counts;
- CLI availability/version, selected terminal health;
- update preference/status/error state;
- legacy integration findings and inspection issues.

The production integration uses a narrow trusted main-process registration,
read-only IPC methods for diagnostics/inspection/preview, and a separately
confirmed mutating IPC method for cleanup. The renderer receives only redacted
reports, action summaries, and an opaque retained-plan ID.
