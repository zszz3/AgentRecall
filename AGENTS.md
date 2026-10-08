# Repository instructions

AgentRecall is a local Electron application that indexes, displays, and resumes coding-agent sessions. The repository ships two independently installed Electron applications: V1 is the stable product and V2 is the preview product with the upgraded session experience, PostgreSQL storage, Runtime, Agents, Workflow, Eval, MCP, Memory, and a managed Skill library. Read [README.md](README.md) for the product surface and [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor workflow.

## Repository map

```text
apps/main-1.0/   Stable Electron app; SQLite and mostly synchronous stores
apps/main-2.0/   Preview Electron app; PostgreSQL and asynchronous stores
  src/main/        Electron main process, services, IPC handlers, OS integration
  src/preload/     Narrow typed bridge exposed to renderer windows
  src/renderer/    React UI; browser-safe code only
  src/core/        Domain logic, loaders, persistence, and shared application types
  src/automation/  V2 Agent, Workflow, Eval, and runtime engine
scripts/         Repository setup, release-note, packaging, and release checks
apps/cli/        Standalone CLI source preview; local project and team configuration
packages/workspace-core/ Shared headless configuration and Git project resolution
docs/            User guides, troubleshooting, and durable design documents
.release-notes/ User-facing release-note fragments consumed by the release workflow
assets/          Repository-level images and distributable assets
```

Keep changes in the lowest owning area. Do not place V2-only behavior in shared V1 code, renderer presentation in persistence modules, or OS/filesystem operations in React components.

## Reading and validation

Commands and risk-based validation are maintained in [CONTRIBUTING.md](CONTRIBUTING.md). Read the applicable module instructions before editing: [apps](apps/AGENTS.md), [V2](apps/main-2.0/AGENTS.md), [workspace-core](packages/workspace-core/AGENTS.md), and [docs](docs/AGENTS.md).

Current behavior belongs in [docs/spec](docs/spec/README.md); important architectural decisions belong in [docs/adr](docs/adr/README.md). Read the relevant spec before changing a covered module. Observable behavior or contract changes update that spec; changes to process boundaries, data ownership, durable compatibility or team conflict policy also update the relevant ADR. Behavior-preserving refactors do not require a new ADR or spec rewrite.

## Working method

- Before searching local files or text, verify that `rg` is available. Prefer `rg` and `rg --files` over `grep`, `find`, or slower recursive tools.
- Inspect the current implementation, its tests, and the relevant app boundary before editing. Do not infer a contract from a component name or one call site.
- Never commit or log API keys, tokens, credentials, private session contents, or populated `.env` files.
- Preserve unrelated working-tree changes. Restrict formatting, generated output, and cleanup to files owned by the task.
- Prefer changing the existing function or component directly when logic has one caller. Create a helper only when it is reused or isolates a meaningful domain, lifecycle, safety, concurrency, transaction, or resource-management decision.
- Do not add pass-through wrappers, single-use aliases, speculative options, compatibility paths without a current consumer, or exports created only to expose an implementation detail to tests.
- Prefer maintained dependencies when they materially remove owned implementation and tests. Do not add a dependency for a trivial operation already clear in local code.
- Do not manually edit `out/`, `dist/`, generated bundles, package archives, or lock-derived artifacts. Run the owning generator or build command when those outputs intentionally need refresh.

## Dual-app development

- For every session-related bug fix or feature, inspect the relevant behavior in both `apps/main-1.0` and `apps/main-2.0` before changing code.
- When the behavior applies to both products, implement and test it in both directories. Do not mechanically copy code: V1 uses SQLite and mostly synchronous store APIs, while V2 uses PostgreSQL and asynchronous store APIs.
- If session behavior intentionally differs between V1 and V2, document the user-visible reason and cover the intended divergence with tests.
- Changes unrelated to sessions may target only the affected application. V2-only Runtime, Agent, Workflow, Eval, Memory, and managed-Skill features do not require placeholder V1 changes.
- V1 and V2 use separate commands, app data, databases, MCP identifiers, and update caches. Do not introduce implicit cross-version reads, writes, migration, or cleanup.

## Session and durable-data rules

Follow the [session data and indexing contract](docs/spec/session-indexing.md), including source fidelity, read-only source defaults, format compatibility and complete-value limits. Team operations additionally follow the [team asset contract](docs/spec/team-assets.md). Enforce permissions and destructive decisions in the operation that performs the action, not only in renderer controls.

## Lifecycle, concurrency, and failures

- Represent one asynchronous operation with one clear owner. Timers, listeners, subprocesses, database leases, watchers, abort controllers, and temporary directories must have deterministic cleanup on success, failure, cancellation, reload, and window shutdown.
- Do not add detached background work unless the product explicitly owns its lifetime and exposes its state. A renderer unmount, closed window, or failed request must not orphan work silently.
- Make cancellation and retry semantics explicit. Do not report success before durable writes, link creation, process startup, or remote operations have actually completed.
- Misconfiguration fails loudly at load time when self-contained, otherwise at the earliest point where the missing value can be resolved. Do not silently skip a requested provider, source, install target, or migration step.
- Keep `try` blocks narrow. Every empty or best-effort `catch` names the exact expected failure and explains why ignoring it is safe; unexpected errors retain actionable context.
- Avoid comments that restate control flow. Comments and JSDoc preserve non-obvious behavior, failure, timing, ownership, compatibility, and safe-use obligations.

## Testing and packaging safety

- Test observable behavior through the owning function, service, IPC boundary, or component. Tests describe the behavior being preserved; when the product behavior changes intentionally, update the obsolete expectation instead of adding compatibility solely for the test.
- Keep regression coverage minimal. Prefer extending the owning test file, retain only tests that protect a distinct user-visible contract or failure boundary, and remove temporary scaffolding or redundant assertions before submission.
- Match evidence to risk: focused unit tests for pure logic, integration tests for persistence and IPC, renderer tests for interactions, builds for process-boundary/import changes, and package smokes for install/update surfaces.
- Tests that exercise installation, update, uninstall, hooks, MCP setup, Skills, session discovery, or agent configuration must use a temporary `HOME`, temporary npm prefix, and synthetic fixtures. Never read, upload, rewrite, or delete the developer's real Claude, Codex, Skills, Supabase, Electron, PostgreSQL, or session data.
- Do not run global install or uninstall tests against the active Node.js prefix. Build first, install the generated package into a temporary prefix, verify it there, and remove all temporary files and child processes.
- Validate macOS and Windows path behavior. Keep platform-specific assertions behind explicit branches; do not bake `/Users/...`, POSIX commands, symlink support, or path separators into cross-platform contracts.
- If a test starts Electron, PostgreSQL, OpenViking, a UI window, watcher, or subprocess, stop it before reporting completion. Do not leave update locks, ports, temporary runtimes, databases, or package archives behind.

## Type safety, UI, and documentation

- Both applications compile with TypeScript `strict`. V2 also rejects unused locals and parameters. Avoid `any`; when external input cannot be typed, keep `unknown` until the boundary parser narrows it.
- Closed discriminated unions use exhaustive handling. Extensible values require a documented fallback that preserves unknown data or produces an actionable error.
- UI actions must expose their real state: disable duplicate submission while running, retain retryable failures, distinguish partial success, and require explicit confirmation for destructive or force-overwrite behavior.
- User-facing text should name the outcome and next action. Do not expose internal table names, IPC channels, branch names, implementation vocabulary, or raw stack traces unless the detail is intentionally diagnostic.
- Durable documentation describes the current product, not commit history. Update the owning guide or README when a change alters setup, visible behavior, configuration, data handling, or limitations.
- Keep one authoritative home for each fact. Link to the owning document instead of copying long command lists, architecture explanations, or release rules into multiple files.

## Development branches and releases

- MRs target `main`; direct feature pushes to `main` are not part of the development workflow. Split independent changes into independent branches.
- Before opening or merging an MR, follow the [release-note rules](.release-notes/README.md) and run `npm run release-note:check`; do not proceed while it fails.
- Release routing, versioning and publication follow [CONTRIBUTING.md](CONTRIBUTING.md). A major version increase requires explicit user confirmation.

## Editing these instructions

Keep root `AGENTS.md` for standing orders needed in most development sessions. Move detailed subsystem contracts and step-by-step procedures to the owning guide, README, or design document and leave a concise link here. State each rule once, in current-state language, and remove obsolete instructions when the repository changes.
