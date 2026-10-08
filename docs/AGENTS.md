# Documentation rules

These instructions apply to documentation under this directory. See the [documentation index](README.md) for reading paths.

- User guides explain operations, prerequisites, visible results and limitations. Specs describe the current checkout's behavior and contracts. ADRs explain decisions and consequences. Keep historical plans and handoffs in `project/archive/` with an explicit archival notice; they are not current product guarantees. Do not recreate `docs/superpowers/`.
- Before changing a spec, inspect its implementation and owning tests. Link to stable source files and tests rather than copying their code or claiming that a test passed because it exists.
- Each spec states its product scope, behavior, interfaces/ownership, failure and compatibility boundaries, and verification pointers. Explicitly identify unsupported behavior. Do not label an unmerged feature as released.
- Update the owning spec in the same change when observable behavior, an interface, durable format, or a failure boundary changes. A behavior-preserving refactor only needs a doc change when its source pointers become stale.
- Add or amend an ADR when changing process boundaries, data ownership, durable compatibility, or team conflict policy. Ordinary bug fixes and visual adjustments do not require a new ADR. Record status, context, decision, consequences and alternatives; a proposed ADR is not implementation evidence.
- Preserve superseded ADRs and link their replacement. Register every new ADR in the index. Avoid duplicating decision history in the current spec.
- Keep one authoritative home for each fact. Link detailed format tables and user instructions from specs instead of copying them. Keep existing guide URLs working when reorganizing content.
- Check relative links and source pointers after changes. Documentation-only work does not require application builds or full test suites; inspect the affected behavior if a factual claim is uncertain.
