# Workspace core development

Read the [team asset spec](../../docs/spec/team-assets.md) and [ownership decision](../../docs/adr/0002-owned-team-asset-updates.md).

- This package is headless and shared by CLI and V2 main-process services. Do not import Electron, renderer state or native confirmation UI.
- Validate untrusted configuration, manifests, snapshots and subprocess results at their boundaries. Keep schema versions explicit; unknown formats must fail rather than lose fields silently.
- Preserve installation ownership, lock lifetime, backup and recovery semantics. Recheck team/directory context before committing writes; identical personal content does not confer management ownership.
- Treat paths, links and complete serialized-size limits as cross-platform contracts. Do not bypass conflict checks to make Pull succeed.
- Separate remote publication from local cache and file installation. Report uncertain remote results and post-publication failures distinctly; cancellation does not undo completed side effects.
- Owning shared-core tests currently live in [apps/cli/test](../../apps/cli/test). Extend those synthetic fixtures rather than creating a second test suite or using a real team repository.
