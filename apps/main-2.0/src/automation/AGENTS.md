# Automation development

Read the [Runtime spec](../../../../docs/spec/runtime.md) for Runtime and Agent work. These rules also guide Workflow/Eval integration with Runtime.

- Route backend execution through RuntimeRouter and registered drivers. Declare supported surfaces, execution modes and continuation policies; reject unsupported requests rather than silently switching backend or mode.
- Keep backend protocol handling, state codecs and resource cleanup in the owning driver. Extend owning tests when changing cancellation, continuation, event ordering or persisted invocation state.
- Agent and execution-config deletion checks run before changing hub state. Inspect all current consumers and persistence paths; renderer validation alone cannot enforce reference integrity.
- Preserve explicit Agent selection. Historical reference migration must not become an implicit runtime fallback.
- Stop, interrupt, detach and shutdown have different lifecycle meanings. Preserve cancellation/failure distinctions and ensure native process exit and durable invocation status agree before reporting completion.
- Use synthetic runtime state and fake drivers for targeted checks. Real provider credentials and personal session/configuration directories are not test fixtures.
