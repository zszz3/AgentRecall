# Workflow development

Read the [workflow spec](../../../../../../../docs/spec/workflow.md) and inherit ancestor instructions.

- Keep authored graph revisions, resolved execution plans, node state and transaction state distinct. Do not reuse a confirmation for a changed revision.
- Resume only against compatible checkpoints and existing workspace evidence. Preserve accepted results and human overrides without silently rerunning side effects.
- Check transaction capabilities before execution. Missing isolation, ledger or recovery approval must not silently downgrade a strict/controlled request to direct mode.
- Revalidate conflicts at application time. Preview, Manager recommendation and user approval must refer to the same current recovery facts.
- Inspect the owning executor, scheduler, transaction and recovery tests for behavior changes. Validate with synthetic workspaces, never the developer checkout as a destructive fixture.
