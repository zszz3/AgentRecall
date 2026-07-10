# Search Match Context Design

## Goal

Explain why each session matched a search by showing structured message hits with role, time, highlighted terms, and a clickable context view in the session detail.

## Scope

For non-empty searches:

- attach message-level hit metadata to each returned session;
- show up to two message hits in each result row;
- display the matching role, timestamp, snippet, and total message-hit count;
- highlight search terms in result snippets;
- open a selected hit as a three-message context window in the detail panel;
- highlight the same terms in the detail context;
- distinguish metadata-only matches from conversation matches.

This version does not add previous/next hit navigation, message-level FTS, a database migration, or changes to full-conversation pagination.

## Data Model

Add:

```ts
export interface SessionMatchHit {
  messageIndex: number;
  role: SessionMessage["role"];
  timestamp: string;
  snippet: string;
  matchedTerms: string[];
}
```

Extend `SessionSearchResult` with:

```ts
matchHits: SessionMatchHit[];
messageMatchCount: number;
metadataMatch: "title" | "project" | "summary" | null;
```

Keep the existing `matchSnippet` field during the transition for compatibility with remote and older callers, but the main result UI prefers `matchHits`.

## Query Strategy

Keep the current one-row-per-session FTS index for candidate selection and ranking. After the final result page is selected, run one batched query against `messages` for only those session keys.

The batch query:

- filters by `session_key IN (...)`;
- matches any normalized positive search term with case-insensitive substring semantics;
- uses a window function to compute total hits per session and keep the first two ordered message hits;
- never performs one SQL query per result;
- returns no message hits for an empty or AND-only query.

For explicit `AND`, the session still requires all terms through the existing FTS query. Individual hit rows may contain any matching term because different terms can appear in different messages in the same session.

Build snippets in TypeScript around the earliest matching term, normalize whitespace, and cap display length. Preserve `messageIndex`, role, and timestamp separately.

## Metadata-Only Matches

If a session matches but has no matching message row, determine the visible reason in this order:

1. title or first question;
2. project path;
3. AI summary or other FTS content.

Represent the last case as `summary`. The UI shows a compact localized label such as `Matched session title / 命中会话标题` rather than presenting an invented conversation excerpt.

## Result UI

Each matching result row shows:

- `N message matches / N 条消息命中`;
- up to two hit buttons;
- localized role and formatted message time;
- a one-line or two-line snippet with every positive term highlighted using `<mark>`.

Clicking a hit stops the row click event and calls a dedicated `onOpenMatch(session, hit)` handler. Normal row selection and double-click behavior remain unchanged.

Highlight rendering uses React text nodes and `<mark>` elements, never HTML injection.

## Detail Context

Opening a hit uses the existing `session:messages` IPC to fetch:

```text
max(0, messageIndex - 1), limit 3
```

The App loads this context separately from the existing latest-message page. It passes `matchedContextMessages`, `matchedMessageIndex`, and the executed query to `DetailPanel`.

The detail panel:

- renders the context above the full conversation;
- labels it `Matched Context / 命中上下文`;
- visually distinguishes the exact hit message;
- highlights positive terms in all three context messages;
- does not alter the full conversation's offset or older-message pagination.

Closing the detail or opening a normal session clears the matched context.

## Search Terms and Highlighting

Create a small shared renderer helper that:

- removes standalone case-insensitive `AND`;
- returns unique positive terms;
- splits text safely for case-insensitive highlighting;
- preserves original text and whitespace;
- treats regex metacharacters as literal text.

The core message-hit query uses equivalent normalized terms so backend matching and frontend highlighting remain consistent.

## Performance

- Query message hits only after pagination selects the displayed sessions.
- Use one batch query, not N+1 queries.
- Return at most two snippets per session.
- Keep total counts in the same windowed query.
- Reuse the existing `(session_key, message_index)` primary key for scoped message scanning.
- Cap the result-page size using the existing search limit.

## Error Handling

- If hit extraction fails, return the session results with empty `matchHits`; search itself must still succeed.
- If a clicked context window cannot be loaded, open the normal detail and show no matched-context block.
- Missing timestamps render without a time label.
- Empty and metadata-only searches never fabricate message hits.

## Testing

### Store tests

- returns role, timestamp, message index, snippet, terms, and total count;
- limits displayed hits to two while preserving the total count;
- batches hits across multiple sessions;
- supports explicit AND terms spread across separate messages;
- identifies title/project/summary-only matches;
- empty queries have no structured hits.

### Renderer helper tests

- removes standalone AND but preserves `android`;
- escapes regex metacharacters;
- highlights all case-insensitive occurrences while preserving original text;
- returns plain text when no term matches.

### UI contract tests

- result rows render hit count, role, time, and highlight marks;
- clicking a hit uses the dedicated handler without selecting the row first;
- App fetches a three-message window around the hit;
- normal detail opening clears matched context;
- detail identifies and highlights the exact hit message.

## Compatibility

No SQLite schema change, index rebuild, settings change, or remote payload migration is required. Existing callers that only use `matchSnippet` continue to work.
