# Recent Search and Explicit AND Design

## Goal

Add a small local recent-search experience and accept an explicit `AND` operator without expanding the search feature into a full query language.

## Scope

This change adds:

- up to 10 recent non-empty searches stored locally;
- a recent-search dropdown when the empty search input receives focus;
- click-to-fill, per-item deletion, and clear-all actions;
- explicit Enter-to-search behavior that records the submitted query;
- case-insensitive standalone `AND` as an alias for the existing implicit AND behavior.

It does not add quoted phrases, exclusion operators, role search, cloud synchronization, or a general query parser.

## Search History Model

Create a focused renderer module at `src/renderer/src/search-history.ts` with pure helpers for reading, recording, deleting, and clearing recent searches.

Use a version-independent JSON string array under the localStorage key:

```text
agent-session-search-recent-searches
```

Rules:

- trim leading and trailing whitespace before recording;
- ignore empty values;
- deduplicate exact trimmed strings;
- move a repeated search to the front;
- keep the 10 most recent entries;
- treat malformed, non-array, or non-string stored values as an empty history;
- never upload or write history to SQLite.

History matching remains case-sensitive for display fidelity: `Codex` and `codex` may coexist because the user typed distinct searches.

## Search Box Interaction

`SearchBox` continues to own its typed value so keystrokes do not rerender the full application.

When the input is focused and its value is empty, show a dropdown containing recent searches. Each item provides:

  - a main button that fills the input without running the selected search;
- a delete button that removes only that item without running it.

A `Clear recent searches / 清空最近搜索` action removes all entries. The dropdown closes when the input loses focus, Escape is pressed, a history item is chosen, or the user begins typing a non-empty value. Pointer interactions inside the dropdown must complete before blur closes it.

No dropdown is shown when history is empty.

## Search and Record Behavior

Search runs only when the user explicitly presses Enter.

- Typing updates only SearchBox-local state and does not query SQLite or rerender the result list.
- Plain Enter sends the current input to the App, runs the search, and records a non-empty trimmed query.
- Plain Enter no longer opens the selected session.
- Choosing a recent search only fills the input; the user presses Enter to run it.
- Empty Enter clears the active search but does not add a history entry.
- Existing double-click, Space, and modified keyboard actions continue to open or resume sessions.

## Explicit AND Semantics

The core search module normalizes standalone case-insensitive `AND` tokens to whitespace before building the FTS query and performing fallback text matching.

These are equivalent:

```text
login expired
login AND expired
login and expired
```

Existing FTS token joining already supplies implicit AND semantics, so no new SQL operator construction is needed. Only standalone tokens are removed. Substrings such as `android`, `candy`, and `R&D` remain normal search text.

A query containing only `AND` normalizes to an empty query and behaves like an empty search rather than raising an FTS error.

## Data Flow

1. Typing updates only local SearchBox state.
2. Enter records the trimmed non-empty query and sends the original display query to the App.
3. The renderer sends that query in `SearchOptions`.
4. `SessionStore.searchSessionPage` normalizes standalone `AND` before FTS and fallback matching.
5. Results render through the existing list and selection flow.

## Error Handling

- localStorage read, parse, or write failures do not block searching; history falls back to memory for the current SearchBox lifetime.
- Invalid stored history is discarded logically without throwing.
- Removing or clearing history is idempotent.
- Explicit `AND` normalization cannot generate raw FTS syntax and therefore does not expose SQLite query syntax.

## Testing

### Search history unit tests

- malformed storage becomes an empty list;
- empty strings are ignored;
- repeated searches move to the front;
- only 10 entries are retained;
- deleting one entry and clearing all entries persist correctly;
- storage write failures do not throw.

### Search store tests

- explicit uppercase and lowercase `AND` equal implicit AND;
- sessions missing either term are excluded;
- `android` and other embedded substrings are preserved;
- an AND-only query is handled as empty search.

### Renderer contract tests

- the dropdown renders history items, deletion, and clear-all controls;
- typing does not call the App search callback;
- Enter runs and records a non-empty search;
- empty Enter clears results without recording history;
- selecting history fills the input without running or recording it.

## Compatibility

Existing searches without explicit `AND` behave unchanged. No database migration, IPC shape change, or remote-session change is required.
