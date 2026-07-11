# Hide Tool Events in Session Detail

## Goal

Keep the session detail focused on the User and Assistant conversation by hiding Tool Call and Tool Output trace events by default, while preserving an immediate way to restore the complete timeline.

## Interaction

- Keep the existing `ALL / USER / Assistant` segmented role filter unchanged.
- Add a separate `Tools` toggle immediately to its right.
- Use a small horizontal gap between the role filter and `Tools`; do not add a vertical divider.
- Treat `Tools` as an independent boolean toggle, not another mutually exclusive role.
- Default `Tools` to off for users who have no stored preference.
- When off, hide both `tool_call` and `tool_result` timeline items.
- When on, insert both event types back into their original chronological positions.
- The toggle remains available with every role selection. For example, `USER + Tools` displays User messages and tool events while hiding Assistant messages.
- Use the existing active-button styling and `aria-pressed` semantics so the state is visible and keyboard-accessible.

## Persistence

Store the last `Tools` state as a renderer preference in `localStorage`, following the existing lightweight renderer preference pattern.

- Read the preference when the detail UI initializes.
- Persist every explicit toggle change.
- Reuse the preference across sessions and after application restart.
- Treat a missing, malformed, or unavailable stored value as off.

This is a global viewing preference, not session data. It must not be synced, exported, or included in remote session payloads.

## Data and Search Boundaries

This feature changes presentation only.

- Continue loading and retaining trace events exactly as today.
- Do not change indexing, search matching, session statistics, detail header counts, remote snapshots, copying, Markdown export, plain-text export, or migration.
- Keep the existing trace-event count in the detail header; do not add a count to the `Tools` toggle.
- Matched message context remains unchanged because it contains indexed User and Assistant messages rather than timeline trace cards.

## Component Changes

Keep the change local to the renderer:

1. Add a small preference helper that parses and stores the boolean `Tools` visibility value.
2. Let `DetailPanel` initialize and update the preference.
3. Filter trace timeline items only at the final visibility stage; preserve `conversationTimeline` as the source of chronological ordering.
4. Add adjacent layout styling for the independent toggle with a small gap and no divider.

No main-process IPC, database schema, or core session-loader changes are needed.

## Error Handling

- Wrap storage reads and writes so restricted or unavailable `localStorage` does not prevent the detail panel from rendering.
- Fall back to hidden tool events after a read failure.
- A write failure affects persistence only; the in-memory toggle should still work for the current application session.

## Testing

- Preference tests: missing or invalid storage defaults to off; valid values restore the last state.
- Timeline visibility tests: off removes both `tool_call` and `tool_result`; on restores both in chronological order.
- Combination tests: `ALL`, `USER`, and `Assistant` each compose correctly with the independent `Tools` state.
- Renderer contract tests: the `Tools` control is adjacent to but separate from the role filter, uses `aria-pressed`, and has no divider requirement.
- Run the full test suite and typecheck after implementation.

## Acceptance Criteria

- Opening a session detail for the first time shows no Tool Call or Tool Output cards.
- `Tools` appears just to the right of `ALL / USER / Assistant`, separated only by a small gap.
- Clicking `Tools` immediately shows or hides both tool-event types without changing the selected role filter.
- The last `Tools` state survives switching sessions and restarting the application.
- No underlying session content, export output, search result, or trace count changes.
