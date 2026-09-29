# Renderer development

Read the [architecture spec](../../../../docs/spec/architecture.md) and inherit ancestor instructions.

- Use the typed preload API for privileged operations. A module under core is not automatically browser-safe; inspect its imports before reusing it.
- Keep request generations and page activity checks when updating asynchronous lists. Ignoring a stale result is different from cancelling its underlying main-process operation.
- Display partial success, conflicts, cancellation and unknown remote outcomes distinctly. Keep failed items retryable without automatically replaying already-published items.
- Reuse session Turn reading components for team excerpts. Preserve original turn identity and ordering independently of selection, virtualization and display truncation.
- For UI changes, verify the actual component with synthetic data and inspect visible interaction. A successful build alone does not prove loading, keyboard, selection or error behavior.
