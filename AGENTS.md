# Repository instructions

## Tooling

- Before searching local files or text, check whether `rg` is available. Prefer `rg` and `rg --files` over `grep` or slower alternatives.

## Code structure

- Prefer changing the existing function or component directly when logic has only one caller.
- Create a helper only when it is reused across independent call sites or isolates a meaningful domain, lifecycle, safety, concurrency, or resource-management boundary.
- Do not add trivial pass-through wrappers, single-use aliases, or functions exported only to make an implementation detail directly testable. Test observable behavior through the owning function or component instead.

## Development branches and release notes

- Every independent development branch must add exactly one user-facing release note before opening an MR.
- Add the note at `.release-notes/<branch-slug>.md`; keep it updated as the branch changes.
- The note must have one `#` title and at least one bullet under `## 新增功能` or `## Bug 修复`.
- Release notes are product copy for end users, not engineering change logs. Include only user-visible new capabilities and user-visible bugs that were fixed.
- Describe the outcome in plain language. Do not mention MRs/PRs, branches, `main`, CI, GitHub Actions, commits, version-bump logic, build or release pipelines, refactors, test counts, internal service names, database details, file paths, or implementation mechanics unless that detail is itself an intentional user-facing feature.
- Remove internal-only changes entirely. If a useful outcome contains private or sensitive context, rewrite it at the product-behavior level and omit identifiers, hosts, paths, table names, credentials, and organizational details.
- Do not use vague text such as “优化代码”, “修复一些问题”, or “新增若干功能”. A reader should understand what became possible or what stopped going wrong.
- A small number of appropriate emoji is allowed when it improves scanning, but clarity comes first.
- User-facing release-note bullets are aggregated verbatim in GitHub Release notes and are shown in the terminal and the App update UI. Treat them as final product copy.
- Run `npm run release-note:check` before opening an MR. Do not open or merge an MR while this check fails.

## Merge and release

- MRs target `main`. Direct feature pushes to `main` are not part of the development workflow.
- MRs merged into `main` accumulate release notes; they do not publish immediately.
- The release workflow publishes accumulated notes every day at 10:00 Beijing time (02:00 UTC), and can be triggered manually for an urgent release.
- A scheduled or manual run with no added release notes since the latest stable tag exits without publishing a release.
- Follow semantic versioning as `x.y.z`, and be conservative about version bumps.
- Prefer bumping `z` for routine releases, including Bug fixes and small user-facing functionality additions, removals, or changes.
- Bump `y` only when the release contains a reasonable new capability increase or a concentrated batch of major Bug fixes.
- Bump `x` only for very large releases or very large changes. Any change that increases `x` must be confirmed with the user before proceeding.
- In the current release-note workflow, any accumulated `新增功能` entry bumps `y`, while an accumulated release containing only `Bug 修复` entries bumps `z`; reserve `新增功能` for changes that intentionally warrant a `y` bump.
- Trigger the release workflow manually for urgent releases. Do not create an application tag or GitHub Release directly unless recovering a failed automated release.

## Safe test and packaging workflow

- Tests that exercise installation, update, uninstall, hooks, MCP setup, Skills, or session discovery must use a temporary `HOME`, temporary npm prefix, and synthetic fixtures. Never read, upload, rewrite, or delete the real user's Claude, Codex, Skills, Supabase, Electron, or session data.
- Do not run global install or uninstall tests against the developer's active Node.js prefix. Use a temporary prefix and remove it after the test.
- Validate behavior on both macOS and Windows paths. Keep platform-specific assertions behind explicit platform branches, and do not assume `/Users/...` paths or POSIX-only commands.
- Package smoke tests must build first, install the generated tarball into a temporary prefix, verify the packaged CLI, and clean all temporary files and child processes.
- If a UI or Electron process is started during testing, stop it before reporting completion. Do not leave update locks, temporary runtimes, test databases, or generated package archives behind.
