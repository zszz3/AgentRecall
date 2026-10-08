# Main-process development

Read the [desktop-lifecycle spec](../../../../docs/spec/desktop-lifecycle.md) and inherit ancestor instructions.

- Keep index.ts focused on wiring. Give each background operation a service owner; do not add an untracked timer or promise whose failure and shutdown behavior are undefined.
- For IPC changes, inspect the actual shared contract, registration, preload caller and renderer consumer. Existing raw IPC is not permission to bypass validation on new input.
- Window-owned team previews must check the initiating owner at the operation boundary and release timers/snapshots when discarded or closed. Service-owned background Eval work has a different lifetime.
- An update install request returning started is not installation completion. Preserve the distinction between staging failure, completed installation and relaunch failure.
- Choose service or IPC tests for these changes. Start native processes only in isolated fixtures and wait for their cleanup before finishing.
