# Repository instructions

AgentRecall is a local Electron application that indexes, displays, and resumes coding-agent sessions. The repository ships two applications from one npm workspace: V1 is the stable product and V2 is the preview product with the upgraded session experience, PostgreSQL storage, Runtime, Agents, Chat, Workflow, Eval, MCP, Memory, and a managed Skill library. Read [README.md](README.md) for the product surface and [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor workflow.

## Repository map

```text
apps/main-1.0/   Stable Electron app; SQLite and mostly synchronous stores
apps/main-2.0/   Preview Electron app; PostgreSQL and asynchronous stores
  src/main/        Electron main process, services, IPC handlers, OS integration
  src/preload/     Narrow typed bridge exposed to renderer windows
  src/renderer/    React UI; browser-safe code only
  src/core/        Domain logic, loaders, persistence, and shared application types
  src/automation/  V2 Agent, Chat, Workflow, Eval, and runtime engine
scripts/         Repository setup, release-note, packaging, and release checks
docs/            User guides, troubleshooting, and durable design documents
.release-notes/ User-facing release-note fragments consumed by the release workflow
assets/          Repository-level images and distributable assets
```

Keep changes in the lowest owning area. Do not place V2-only behavior in shared V1 code, renderer presentation in persistence modules, or OS/filesystem operations in React components.

## Commands

```sh
npm run setup:v1              # install the V1 workspace
npm run setup:v2              # install the V2 workspace
npm run dev:v1                # run V1 from source
npm run dev:v2                # run V2 from source
npm run test:v1               # V1 tests
npm run test:v2               # V2 tests
npm run typecheck             # typecheck both apps
npm run build                 # build both apps
npm run release-note:check    # validate release-note routing and format
npm run package:smoke         # isolated V1 package smoke test
npm run package:smoke:v2      # isolated V2 package smoke test
npm run release:preflight     # full release preflight; expensive
```

Run focused Vitest files from the affected app while iterating, for example `npm exec vitest run src/core/skill-manager.test.ts` with the working directory set to `apps/main-2.0`. Run the app-level test or typecheck only when the focused check passes. Do not default to the full repository suite or repeat a passing check merely before a commit; use the full suite for repository-wide changes, CI diagnosis, release preparation, or an explicit user request.

## Working method

- Before searching local files or text, verify that `rg` is available. Prefer `rg` and `rg --files` over `grep`, `find`, or slower recursive tools.
- Inspect the current implementation, its tests, and the relevant app boundary before editing. Do not infer a contract from a component name or one call site.
- Preserve unrelated working-tree changes. Restrict formatting, generated output, and cleanup to files owned by the task.
- Prefer changing the existing function or component directly when logic has one caller. Create a helper only when it is reused or isolates a meaningful domain, lifecycle, safety, concurrency, transaction, or resource-management decision.
- Do not add pass-through wrappers, single-use aliases, speculative options, compatibility paths without a current consumer, or exports created only to expose an implementation detail to tests.
- Prefer maintained dependencies when they materially remove owned implementation and tests. Do not add a dependency for a trivial operation already clear in local code.
- Do not manually edit `out/`, `dist/`, generated bundles, package archives, or lock-derived artifacts. Run the owning generator or build command when those outputs intentionally need refresh.

## Electron and application boundaries

- The main process owns filesystem access, databases, credentials, child processes, native dialogs, menus, and other privileged OS operations. The renderer requests those operations through the preload API.
- Keep the preload surface narrow and typed. An IPC change updates the shared channel contract, main handler, preload API, renderer-facing types, and boundary tests together.
- Renderer imports must be browser-safe. Do not pull a module importing `node:*`, Electron main APIs, database clients, or process-control code into a renderer bundle. Treat Vite browser-externalization warnings as a boundary problem, not harmless noise.
- Validate untrusted values at real boundaries: files, durable records, IPC, subprocess output, network responses, model/tool JSON, and user input. Trust TypeScript for typed same-process calls instead of duplicating runtime checks everywhere.
- Never commit or log API keys, tokens, credentials, private session contents, or populated `.env` files. Keep secrets in the owning main-process service and expose only the minimum renderer state needed for the UI.
- Enforce permissions and destructive decisions in the operation that performs the action. Hiding a renderer button or filtering a prompt is not enforcement when another caller can reach the executor.
- Publish renderer-visible state and notifications only after the owning operation commits. Derive caches and UI projections from one authoritative source instead of independently mutating parallel copies.

## Dual-app development

- For every session-related bug fix or feature, inspect the relevant behavior in both `apps/main-1.0` and `apps/main-2.0` before changing code.
- When the behavior applies to both products, implement and test it in both directories. Do not mechanically copy code: V1 uses SQLite and mostly synchronous store APIs, while V2 uses PostgreSQL and asynchronous store APIs.
- If session behavior intentionally differs between V1 and V2, document the user-visible reason and cover the intended divergence with tests.
- Changes unrelated to sessions may target only the affected application. V2-only Runtime, Agent, Chat, Workflow, Eval, Memory, and managed-Skill features do not require placeholder V1 changes.
- V1 and V2 use separate commands, app data, databases, MCP identifiers, and update caches. Do not introduce implicit cross-version reads, writes, migration, or cleanup.

## Session and durable-data rules

- Original coding-agent session files are read sources by default. Resume uses the owning agent; migration and restore create new copies. Any operation that edits or deletes original data must be explicit in the product contract and confirmation UI.
- Preserve source fidelity. Model-visible messages, tool events, attachments, usage, compaction markers, and parent/child relationships must remain reconstructable from the source or the durable indexed representation.
- Keep parsing separate from presentation. Loaders normalize source formats; renderer code decides labels, grouping, and visual density without rewriting stored meaning.
- Database and on-disk format changes require an explicit compatibility decision, migration or rejection behavior, and tests using synthetic old and new records. Never silently reinterpret existing durable data.
- Apply limits to the complete retained or emitted value, including wrappers and metadata. Test empty input, exact limits, oversized single items, multi-item overflow, and multibyte text where byte limits matter.

## Lifecycle, concurrency, and failures

- Represent one asynchronous operation with one clear owner. Timers, listeners, subprocesses, database leases, watchers, abort controllers, and temporary directories must have deterministic cleanup on success, failure, cancellation, reload, and window shutdown.
- Do not add detached background work unless the product explicitly owns its lifetime and exposes its state. A renderer unmount, closed window, or failed request must not orphan work silently.
- Make cancellation and retry semantics explicit. Do not report success before durable writes, link creation, process startup, or remote operations have actually completed.
- Misconfiguration fails loudly at load time when self-contained, otherwise at the earliest point where the missing value can be resolved. Do not silently skip a requested provider, source, install target, or migration step.
- Keep `try` blocks narrow. Every empty or best-effort `catch` names the exact expected failure and explains why ignoring it is safe; unexpected errors retain actionable context.
- Avoid comments that restate control flow. Comments and JSDoc preserve non-obvious behavior, failure, timing, ownership, compatibility, and safe-use obligations.

## Testing and packaging safety

- Test observable behavior through the owning function, service, IPC boundary, or component. Tests describe the behavior being preserved; when the product behavior changes intentionally, update the obsolete expectation instead of adding compatibility solely for the test.
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

## Development branches and release notes

- MRs target `main`; direct feature pushes to `main` are not part of the development workflow. Split independent changes into independent branches.
- Every development branch with user-visible changes adds exactly one `.release-notes/<branch-slug>.md` before opening an MR. A branch may omit the note only when every changed file is release infrastructure: `.github/**`, `AGENTS.md`, `.release-notes/README.md`, `scripts/release-notes.mjs`, or `scripts/release-notes.test.mjs`.
- Every new note must put exactly one of `<!-- release-target: v1 -->`, `<!-- release-target: v2 -->`, or `<!-- release-target: both -->` immediately after the note title. Use `both` only when the same user-visible outcome ships in both products.
- A note has one `#` title and at least one bullet under `## 新增功能` or `## Bug 修复`. It is final product copy consumed verbatim by GitHub Releases, the terminal, and the update UI.
- Release notes are product copy for end users, not engineering change logs. Describe concrete user outcomes and exclude PRs, branches, commits, CI, pipelines, refactors, tests, internal services, databases, paths, credentials, and implementation mechanics unless that detail is itself a user-facing feature. Do not use vague copy such as “优化代码” or “修复一些问题”.
- Remove internal-only changes entirely. If a useful outcome contains private or sensitive context, rewrite it at the product-behavior level and omit identifiers, hosts, paths, table names, credentials, and organizational details.
- Run `npm run release-note:check` before opening or merging an MR. Do not proceed while it fails.

## Merge and release

- MRs merged into `main` accumulate release notes; they do not publish immediately. The scheduled workflow publishes pending notes daily at 10:00 Beijing time and can be triggered manually for an urgent release.
- V1 and V2 are versioned and published independently. Scheduled and manual runs publish only products with matching pending notes; manually starting the workflow does not force both products to release. A run with no notes since the latest stable tag exits without a release.
- V1 `vX.Y.Z` releases own GitHub's repository-wide `Latest` marker and `releases/latest/download`. V2 uses immutable `v2-X.Y.Z` releases and the moving `v2-latest` install/update pointer.
- Use semantic versions conservatively. Routine fixes and small behavior changes bump `z`; a meaningful capability increase or concentrated major-fix batch bumps `y`; any `x` increase requires explicit user confirmation.
- The current workflow treats any `新增功能` entry as a `y` bump and a release containing only `Bug 修复` entries as a `z` bump. Reserve `新增功能` for changes intended to justify a minor release.
- Trigger the release workflow for urgent publication. Do not create an application tag or GitHub Release directly unless recovering the automated release process.

## Editing these instructions

Keep root `AGENTS.md` for standing orders needed in most development sessions. Move detailed subsystem contracts and step-by-step procedures to the owning guide, README, or design document and leave a concise link here. State each rule once, in current-state language, and remove obsolete instructions when the repository changes.
