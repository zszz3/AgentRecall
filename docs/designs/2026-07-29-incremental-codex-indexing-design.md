# Incremental Codex Session Indexing Design

## Goal

AgentRecall V1 and V2 must index large, append-only Codex JSONL sessions without loading the whole source file into one JavaScript string. Resuming an already indexed Codex session must process only newly appended complete JSONL records.

V1 and V2 remain independent applications. They share the same product behavior, while V1 persists to SQLite and V2 persists to PostgreSQL through their existing stores.

## Current Problem

Both applications currently read each changed Codex JSONL file with `readFileSync(filePath, "utf-8")`. When a file grows beyond Node.js's maximum string size, the read fails and the loader returns an empty result. The indexer then has no session to expose in the Session page.

For files that can still be read, any size or modification-time change causes the entire file to be parsed again. The stores replace the previously derived messages, token events, traces, turns, and search data instead of appending only new records.

## Indexing Model

Each indexed Codex source records the byte offset immediately after the last complete JSONL line committed to the database. The existing `content_indexed_size` field represents this committed offset.

Indexing has three paths:

1. **New or legacy session:** stream forward from byte zero. Parse complete lines in bounded chunks and build the initial index.
2. **Append-only update:** begin at `content_indexed_size`, parse only newly appended complete lines, and append their derived records.
3. **Rebuild:** stream forward from byte zero when the file is smaller than the committed offset, its identity cannot be trusted, or existing indexed state cannot safely accept an append.

Reading backwards is not the primary indexing strategy. It can find recent activity quickly, but it cannot preserve complete chronological search data. The append cursor gives the same performance benefit for resumed sessions without omitting older records.

## Complete-Line Boundary

The reader processes fixed-size byte chunks and carries an incomplete trailing line into the next chunk. It commits only through the final newline observed in a scan.

If Codex is still writing the last JSON object, that incomplete byte range is left beyond `content_indexed_size`. The next refresh starts at the same committed offset and retries it after more bytes arrive.

A JSON line may be larger than one chunk. The reader must combine as many chunks as required for that single line without treating the chunk boundary as a parse failure.

Malformed complete JSON lines are skipped consistently with current JSONL behavior. File open/read failures are not converted into an empty session; they are reported as indexing failures while previously indexed data remains intact.

## Initial Streaming Parse

The first scan must not retain the raw file or all parsed JSON rows. Each parsed row is immediately reduced into the existing index-facing data:

- session metadata;
- searchable user and assistant messages;
- token usage events;
- trace/tool events;
- attachment metadata.

The resulting derived records may be buffered in bounded batches. Initial persistence replaces any previous derived state in one logical rebuild. A failed rebuild must not delete the last valid index.

This design preserves full searchable history. It does not use a head/tail-only approximation.

## Incremental Persistence

V1 adds an SQLite store operation for appending a Codex index delta. V2 adds the equivalent PostgreSQL store operation. Each operation runs transactionally and:

- verifies that the stored committed offset still equals the delta's starting offset;
- appends messages and events with indices continuing from existing counts;
- updates token totals and session counts;
- updates derived turn/search data affected by the appended records;
- advances `content_indexed_size` only after all delta records are committed;
- updates source file size and modification metadata.

If the offset check fails, the indexer abandons the delta and schedules a streamed rebuild rather than risking duplicate or missing rows.

Incremental indexing must preserve existing tags, favorites, custom titles, summaries, visibility, and other user-managed session metadata.

## Turn Boundary

An append can continue the final existing turn. The incremental writer therefore loads the minimal persisted tail required by the existing timeline rules and combines it with the new derived events before replacing only the affected final turn and appending later turns.

It must not rebuild every historical turn for each resume.

## Compatibility and Recovery

Existing installations already store full file sizes in `content_indexed_size`. Such rows do not prove that an incremental cursor was produced by the new reader. The first changed scan after upgrading treats them as legacy state and performs one streamed rebuild. After that successful rebuild, subsequent appends use the cursor path.

A small index-format version marker distinguishes cursor-safe state from legacy state. It is stored independently in each application's database.

When a source is truncated, rewritten, or replaced, the indexer performs a streamed rebuild. Previously indexed data stays visible until the rebuild transaction succeeds.

## Open Session Visibility

Live Codex process detection remains independent from content indexing. The existing `codex resume <sessionId>` parser continues to identify running sessions.

The Session catalog should merge indexed open sessions with the normal first page before applying client-side open-first ordering. This prevents an older resumed session from being hidden merely because it was outside the initial 30 database results.

An unindexed source still requires at least its streamed metadata and first meaningful message to be committed before it can appear as a normal searchable Session.

## Error Reporting

Index status reports the number of failed session files and preserves the last valid indexed content. Diagnostic errors identify the source file and failure category without exposing message contents.

The UI continues indexing other sessions when one file fails.

## Validation

V1 and V2 each require automated coverage for:

- a synthetic JSONL file whose total size exceeds a deliberately small test threshold, proving chunked reading without a whole-file read;
- a JSON record spanning multiple chunks;
- an incomplete final line that is deferred and indexed on the next append;
- append-only refresh reading from the committed offset;
- file truncation causing a streamed rebuild;
- an injected read failure preserving the previous index and surfacing an indexing error;
- message, token, trace, and turn indices continuing without duplicates;
- an old indexed Codex Resume session appearing alongside the normal first Session page;
- SQLite behavior in V1 and PostgreSQL behavior in V2;
- path handling on macOS and Windows-style fixtures.

Tests use temporary homes, temporary databases, and synthetic session files only.
