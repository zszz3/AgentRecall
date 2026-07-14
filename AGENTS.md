# Repository instructions

## Tooling

- Before searching local files or text, check whether `rg` is available. Prefer `rg` and `rg --files` over `grep` or slower alternatives.

## Development branches and release notes

- Every independent development branch must add exactly one user-facing release note before opening an MR.
- Add the note at `.release-notes/<branch-slug>.md`; keep it updated as the branch changes.
- The note must have one `#` title and at least one bullet under `## 新增功能` or `## Bug 修复`.
- Release notes are product copy for end users, not engineering change logs. Include only user-visible new capabilities and user-visible bugs that were fixed.
- Describe the outcome in plain language. Do not mention MRs/PRs, branches, `main`, CI, GitHub Actions, commits, version-bump logic, build or release pipelines, refactors, test counts, internal service names, database details, file paths, or implementation mechanics unless that detail is itself an intentional user-facing feature.
- Remove internal-only changes entirely. If a useful outcome contains private or sensitive context, rewrite it at the product-behavior level and omit identifiers, hosts, paths, table names, credentials, and organizational details.
- Do not use vague text such as “优化代码”, “修复一些问题”, or “新增若干功能”. A reader should understand what became possible or what stopped going wrong.
- A small number of appropriate emoji is allowed when it improves scanning, but clarity comes first.
- The release-note text is published verbatim in GitHub Release notes and is shown in the terminal and the App update UI. Treat it as final product copy.
- Run `npm run release-note:check` before opening an MR. Do not open or merge an MR while this check fails.

## Merge and release

- MRs target `main`. Direct feature pushes to `main` are not part of the development workflow.
- Every MR merged into `main` automatically publishes a GitHub Release after all release checks pass.
- A release containing any `新增功能` entry bumps the minor version; a release containing only `Bug 修复` entries bumps the patch version.
- Do not manually create an application tag or GitHub Release unless recovering a failed automated release.
