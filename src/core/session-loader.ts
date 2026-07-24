import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanTitle } from "./format-adapters";
import {
  CODEWIZ_SHARE_DIR,
  QODER_DIR,
  TRAE_DIR_NAMES,
  loadCodeWizSessions,
  loadCursorAgentSessionsIterator,
  loadHermesSessions,
  loadOpenClawSessionsIterator,
  loadOpenCodeSessions,
  loadQoderSessionsIterator,
  loadTraeSessionsIterator,
  loadZcodeSessions,
} from "./session-loaders/alternative-sources";
export * from "./session-loaders/alternative-sources";
import {
  createIndexedSession,
  createTokenUsage,
  dedupeTraceEvents,
  extractMessages,
  firstQuestion,
  firstStringField,
  isRecord,
  joinNonEmpty,
  numberField,
  objectField,
  parseMaybeJson,
  parseTimestampMs,
  putTokenEvent,
  readJsonl,
  safeStat,
  shouldSkipFile,
  statusFromExit,
  stringifyDetail,
  stringField,
  titleWithSummary,
  tokenEvent,
  tokenUsageFromEvents,
  unknownField,
  walkJsonlFiles,
  type SessionLoadOptions,
  type TraceEventDraft,
  type VirtualSessionFileStat,
} from "./session-loaders/common";
export {
  parseJsonlText,
  type SessionLoadOptions,
  type VirtualSessionFileStat,
} from "./session-loaders/common";
import type {
  CodeBuddyConversationLine,
  ClaudeAppSessionFile,
  ClaudeConversationLine,
  ClaudeSessionIndexFile,
  CodexConversationLine,
  IndexedSession,
  LoadedSession,
  SessionFormat,
  SessionMessage,
  SessionSource,
  SessionTraceEvent,
  SessionTraceKind,
  TokenUsage,
  TokenUsageEvent,
} from "./types";

const CODEX_APP_ORIGINATORS = new Set(["Codex Desktop", "codex_work_desktop"]);
const CLAUDE_INTERNAL_DIR = ".claude-internal";
const CODEX_INTERNAL_DIR = ".codex-internal";
const TCLAUDE_DIR = ".tclaude";
const TCODEX_DIR = ".tcodex";
const CODEBUDDY_DIR = ".codebuddy";

export function parseCodexSessionMetaLine(parsed: unknown): {
  id: string;
  projectPath: string;
  ts: number;
  title?: string;
  gitBranch?: string;
  originator?: string;
  isSubagent: boolean;
  parentSessionId: string | null;
} | null {
  if (!parsed || typeof parsed !== "object") return null;

  const line = parsed as CodexConversationLine;
  if (line.type === "session_meta" && line.payload?.id) {
    const structuredSource =
      line.payload.source && typeof line.payload.source === "object" ? line.payload.source : null;
    const structuredParent = structuredSource?.subagent?.thread_spawn?.parent_thread_id;
    const legacyParent = line.payload.thread_source === "subagent" ? line.payload.parent_thread_id : undefined;
    const parentSessionId = structuredParent || legacyParent || null;
    return {
      id: line.payload.id,
      projectPath: line.payload.cwd || "",
      ts: line.timestamp ? new Date(line.timestamp).getTime() : 0,
      title: line.payload.title,
      gitBranch: line.payload.git?.branch,
      originator: line.payload.originator,
      isSubagent: parentSessionId !== null,
      parentSessionId,
    };
  }

  if (line.id && line.timestamp && !line.type) {
    return {
      id: line.id,
      projectPath: line.git?.cwd || "",
      ts: new Date(line.timestamp).getTime(),
      isSubagent: false,
      parentSessionId: null,
    };
  }

  return null;
}

function extractClaudeTraceEvents(rows: unknown[]): TraceEventDraft[] {
  const events: TraceEventDraft[] = [];

  for (const row of rows) {
    if (!isRecord(row) || (row.type !== "user" && row.type !== "assistant")) continue;
    const message = objectField(row, "message");
    const blocks = unknownField(message, "content");
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_use") {
        const input = unknownField(block, "input");
        const name = stringField(block, "name") || "tool";
        const summary = firstStringField(input, ["command", "cmd", "file_path", "path", "query", "url"]);
        events.push({
          kind: "tool_call",
          source: "claude",
          title: titleWithSummary(name, summary),
          detail: stringifyDetail(input),
          timestamp: stringField(row, "timestamp"),
          callId: stringField(block, "id") || null,
          eventType: null,
          status: "unknown",
        });
      } else if (block.type === "tool_result") {
        events.push({
          kind: "tool_result",
          source: "claude",
          title: "tool result",
          detail: stringifyDetail(unknownField(block, "content")),
          timestamp: stringField(row, "timestamp"),
          callId: stringField(block, "tool_use_id") || null,
          eventType: null,
          status: "unknown",
        });
      }
    }
  }

  return events;
}

function extractCodexResponseTrace(row: Record<string, unknown>): TraceEventDraft[] {
  if (row.type !== "response_item") return [];
  const payload = objectField(row, "payload");
  if (!payload) return [];
  const payloadType = stringField(payload, "type");

  if (payloadType === "function_call") {
    const args = parseMaybeJson(unknownField(payload, "arguments"));
    const name = stringField(payload, "name") || "tool";
    const summary = firstStringField(args, ["command", "cmd", "query", "path", "file_path", "url"]);
    return [
      {
        kind: "tool_call",
        source: "codex",
        title: titleWithSummary(name, summary),
        detail: stringifyDetail(args),
        timestamp: stringField(row, "timestamp"),
        callId: stringField(payload, "call_id") || null,
        eventType: null,
        status: "unknown",
      },
    ];
  }

  if (payloadType === "function_call_output") {
    return [
      {
        kind: "tool_result",
        source: "codex",
        title: "tool output",
        detail: stringifyDetail(unknownField(payload, "output")),
        timestamp: stringField(row, "timestamp"),
        callId: stringField(payload, "call_id") || null,
        eventType: null,
        status: "unknown",
      },
    ];
  }

  return [];
}

function extractCodexEventTrace(row: Record<string, unknown>): TraceEventDraft[] {
  if (row.type !== "event_msg") return [];
  const payload = objectField(row, "payload");
  const eventType = stringField(payload, "type");
  if (!payload || !eventType) return [];

  const common = {
    source: "codex" as const,
    timestamp: stringField(row, "timestamp"),
    callId: stringField(payload, "call_id") || null,
    eventType,
  };

  if (eventType === "exec_command_end") {
    const output = joinNonEmpty([
      stringField(payload, "stdout") ? `stdout:\n${stringField(payload, "stdout")}` : "",
      stringField(payload, "stderr") ? `stderr:\n${stringField(payload, "stderr")}` : "",
      stringField(payload, "aggregated_output") ? `output:\n${stringField(payload, "aggregated_output")}` : "",
      stringField(payload, "formatted_output") ? `formatted:\n${stringField(payload, "formatted_output")}` : "",
    ]);
    return [
      {
        ...common,
        kind: "event",
        title: titleWithSummary("shell", stringField(payload, "command") || firstStringField(unknownField(payload, "parsed_cmd"), ["cmd", "command"])),
        detail: joinNonEmpty([
          stringField(payload, "cwd") ? `cwd: ${stringField(payload, "cwd")}` : "",
          typeof unknownField(payload, "exit_code") === "number" ? `exit_code: ${unknownField(payload, "exit_code")}` : "",
          output,
        ]),
        status: statusFromExit(typeof unknownField(payload, "exit_code") === "number" ? numberField(payload, "exit_code") : undefined),
      },
    ];
  }

  if (eventType === "patch_apply_end") {
    return [
      {
        ...common,
        kind: "event",
        title: "apply_patch",
        detail: joinNonEmpty([
          stringField(payload, "stdout") ? `stdout:\n${stringField(payload, "stdout")}` : "",
          stringField(payload, "stderr") ? `stderr:\n${stringField(payload, "stderr")}` : "",
          unknownField(payload, "changes") ? `changes:\n${stringifyDetail(unknownField(payload, "changes"))}` : "",
        ]),
        status: statusFromExit(undefined, typeof unknownField(payload, "success") === "boolean" ? Boolean(unknownField(payload, "success")) : undefined),
      },
    ];
  }

  if (eventType === "mcp_tool_call_end") {
    const invocation = unknownField(payload, "invocation");
    const invocationName = firstStringField(invocation, ["name", "tool", "method"]);
    return [
      {
        ...common,
        kind: "event",
        title: titleWithSummary("mcp", invocationName || stringField(payload, "plugin_id")),
        detail: stringifyDetail(unknownField(payload, "result") || invocation),
        status: "unknown",
      },
    ];
  }

  if (eventType === "web_search_end") {
    return [
      {
        ...common,
        kind: "event",
        title: titleWithSummary("web_search", stringField(payload, "query")),
        detail: stringifyDetail(unknownField(payload, "action")),
        status: "unknown",
      },
    ];
  }

  if (eventType === "error") {
    return [
      {
        ...common,
        kind: "event",
        title: "error",
        detail: joinNonEmpty([stringField(payload, "message"), stringifyDetail(unknownField(payload, "codex_error_info"))]),
        status: "failure",
      },
    ];
  }

  if (eventType === "turn_aborted" || eventType === "context_compacted") {
    return [
      {
        ...common,
        kind: "event",
        title: eventType,
        detail: stringifyDetail(payload),
        status: "unknown",
      },
    ];
  }

  return [];
}

function extractCodexTraceEvents(rows: unknown[]): TraceEventDraft[] {
  const events: TraceEventDraft[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    events.push(...extractCodexResponseTrace(row), ...extractCodexEventTrace(row));
  }
  return events;
}

function extractTraceEvents(rows: unknown[], format: SessionFormat): SessionTraceEvent[] {
  if (format === "claude") return dedupeTraceEvents(extractClaudeTraceEvents(rows));
  if (format === "codex") return dedupeTraceEvents(extractCodexTraceEvents(rows));
  return [];
}

function subtractTokenUsage(current: TokenUsage, previous: TokenUsage | null): TokenUsage {
  if (!previous) return current;
  return createTokenUsage(
    Math.max(0, current.inputTokens - previous.inputTokens),
    Math.max(0, current.outputTokens - previous.outputTokens),
    Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    Math.max(0, current.reasoningOutputTokens - previous.reasoningOutputTokens),
  );
}

function cumulativeTokenDelta(current: TokenUsage, previousTotals: TokenUsage[]): TokenUsage {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < previousTotals.length; index += 1) {
    const previous = previousTotals[index];
    if (previous.totalTokens > current.totalTokens) continue;
    const distance = current.totalTokens - previous.totalTokens;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  if (bestIndex < 0) {
    previousTotals.push(current);
    return current;
  }
  const delta = subtractTokenUsage(current, previousTotals[bestIndex]);
  previousTotals[bestIndex] = current;
  return delta;
}

// Codex reports OpenAI-style usage where `input_tokens` already includes cached
// tokens and `output_tokens` already includes reasoning tokens. Split them into
// the distinct buckets createTokenUsage expects (input excludes cached, output
// excludes reasoning) so the summed total matches Codex's own accounting.
function normalizeCodexUsage(usage: Record<string, unknown>): {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
} {
  const cached = numberField(usage, "cached_input_tokens") + numberField(usage, "cache_read_input_tokens");
  const reasoning = numberField(usage, "reasoning_output_tokens");
  return {
    input: Math.max(0, numberField(usage, "input_tokens") - cached),
    output: Math.max(0, numberField(usage, "output_tokens") - reasoning),
    cached,
    reasoning,
  };
}

function extractCodexTokenEvents(rows: unknown[]): TokenUsageEvent[] {
  const entries = new Map<string, TokenUsageEvent>();
  const cumulativeEntries = new Map<string, TokenUsageEvent>();
  const previousTotals: TokenUsage[] = [];
  let currentModel = "";
  // Codex carries a running cumulative `total_token_usage` on every token_count
  // event. Convert those cumulative totals into per-event deltas so period stats
  // only count the tokens added inside that period while the full-session sum
  // still matches cumulative accounting. Some Codex logs interleave multiple
  // cumulative sequences in one session file, so match each total to the closest
  // prior sequence rather than assuming one monotonic counter. Fall back to
  // summing last_token_usage only when no cumulative total is present.

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const payload = objectField(row, "payload");
    if (row.type === "turn_context") {
      currentModel = stringField(payload, "model") || currentModel;
      continue;
    }
    if (row.type !== "event_msg" || stringField(payload, "type") !== "token_count") continue;
    const info = objectField(payload, "info");
    const model = stringField(info, "model") || currentModel;
    const timestamp = parseTimestampMs(row.timestamp);

    const totalUsage = objectField(info, "total_token_usage");
    if (totalUsage) {
      const t = normalizeCodexUsage(totalUsage);
      const current = createTokenUsage(t.input, t.output, t.cached, t.reasoning);
      const delta = cumulativeTokenDelta(current, previousTotals);
      if (delta.totalTokens > 0) {
        const key = [
          "codex-total",
          model,
          timestamp,
          current.inputTokens,
          current.outputTokens,
          current.cachedInputTokens,
          current.reasoningOutputTokens,
        ].join(":");
        putTokenEvent(
          cumulativeEntries,
          {
            ...delta,
            timestamp,
            dedupeKey: key,
          },
        );
      }
    }

    const lastUsage = objectField(info, "last_token_usage");
    if (lastUsage) {
      const l = normalizeCodexUsage(lastUsage);
      const totalInput = numberField(totalUsage, "input_tokens");
      const totalOutput = numberField(totalUsage, "output_tokens");
      const key = ["codex", model, l.input, l.output, l.cached, l.reasoning, totalInput, totalOutput].join(":");
      putTokenEvent(entries, tokenEvent(timestamp, key, l.input, l.output, l.cached, l.reasoning));
    }
  }

  return cumulativeEntries.size > 0 ? [...cumulativeEntries.values()] : [...entries.values()];
}

function extractClaudeTokenEvents(rows: unknown[]): TokenUsageEvent[] {
  const entries = new Map<string, TokenUsageEvent>();

  rows.forEach((row, index) => {
    if (!isRecord(row) || row.type !== "assistant") return;
    const message = objectField(row, "message");
    const usage = objectField(message, "usage");
    if (!usage) return;

    // Anthropic splits input across three billed buckets: fresh `input_tokens`,
    // `cache_creation_input_tokens` (written to cache, billed ~1.25x) and
    // `cache_read_input_tokens` (cache hit, billed ~0.1x). All three are really
    // processed, so the cache buckets belong in the cached total.
    const cached =
      numberField(usage, "cache_read_input_tokens") +
      numberField(usage, "cached_input_tokens") +
      numberField(usage, "cache_creation_input_tokens");
    const entry = createTokenUsage(
      numberField(usage, "input_tokens"),
      numberField(usage, "output_tokens"),
      cached,
      numberField(usage, "reasoning_output_tokens"),
    );
    const key = stringField(message, "id") || stringField(row, "uuid") || `${index}:${JSON.stringify(usage)}`;
    putTokenEvent(
      entries,
      {
        ...entry,
        timestamp: parseTimestampMs(row.timestamp),
        dedupeKey: key.startsWith("claude-code:") ? key : `claude-code:${key}`,
      },
    );
  });

  return [...entries.values()];
}

function extractCodeBuddyTokenEvents(rows: unknown[]): TokenUsageEvent[] {
  const entries = new Map<string, TokenUsageEvent>();

  rows.forEach((row, index) => {
    if (!isRecord(row)) return;
    // CodeBuddy attaches per-request usage to the record that carried the API
    // call. Assistant text turns keep it on the message; tool turns keep it on
    // each `function_call` record, and a single assistant turn can fan out into
    // several parallel tool calls that were each a separately billed request.
    // Scan both so the summed total reflects real consumption, and key each
    // function_call by its unique `callId` so parallel requests are not
    // collapsed into one.
    const isAssistantMessage = row.type === "message" && row.role === "assistant";
    const isFunctionCall = row.type === "function_call";
    if (!isAssistantMessage && !isFunctionCall) return;

    const providerData = objectField(row, "providerData");
    if (!providerData) return;

    const usage = readCodeBuddyUsage(providerData);
    if (!usage) return;

    const entry = createTokenUsage(usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.reasoningOutputTokens);
    const key = isFunctionCall
      ? stringField(row, "callId") || stringField(row, "id") || `${index}:${usage.inputTokens}:${usage.outputTokens}`
      : stringField(providerData, "messageId") || stringField(row, "id") || `${index}:${usage.inputTokens}:${usage.outputTokens}`;
    putTokenEvent(entries, {
      ...entry,
      timestamp: parseTimestampMs(row.timestamp),
      dedupeKey: key.startsWith("codebuddy:") ? key : `codebuddy:${key}`,
    });
  });

  return [...entries.values()];
}

// CodeBuddy reports OpenAI-style usage: the input/prompt total already includes
// cached tokens, and the output/completion total already includes reasoning
// tokens. Split them into the distinct buckets createTokenUsage expects (input
// excludes cached, output excludes reasoning) so the summed total matches
// CodeBuddy's own total. Prefer the camelCase `usage` object, falling back to
// the raw OpenAI `rawUsage` object.
function readCodeBuddyUsage(providerData: Record<string, unknown>): TokenUsage | null {
  let totalInput = 0;
  let totalOutput = 0;
  let cached = 0;
  let reasoning = 0;

  const usage = objectField(providerData, "usage");
  if (usage) {
    totalInput = numberField(usage, "inputTokens");
    totalOutput = numberField(usage, "outputTokens");
    cached = firstDetailNumber(usage.inputTokensDetails, "cached_tokens");
    reasoning = firstDetailNumber(usage.outputTokensDetails, "reasoning_tokens");
  }

  const rawUsage = objectField(providerData, "rawUsage");
  if (!totalInput && !totalOutput && rawUsage) {
    totalInput = numberField(rawUsage, "prompt_tokens");
    totalOutput = numberField(rawUsage, "completion_tokens");
    cached = numberField(objectField(rawUsage, "prompt_tokens_details"), "cached_tokens");
    reasoning = numberField(objectField(rawUsage, "completion_tokens_details"), "reasoning_tokens");
  }

  if (!totalInput && !totalOutput) return null;

  return createTokenUsage(Math.max(0, totalInput - cached), Math.max(0, totalOutput - reasoning), cached, reasoning);
}

// CodeBuddy stores token detail breakdowns as single-element arrays, e.g.
// `inputTokensDetails: [{ cached_tokens: 19567 }]`. Accept either an array
// (read the first entry) or a plain object.
function firstDetailNumber(value: unknown, key: string): number {
  if (Array.isArray(value)) return numberField(value[0], key);
  return numberField(value, key);
}

function firstClaudeGitBranch(rows: unknown[]): string | null {
  for (const row of rows) {
    if (!row || typeof row !== "object" || !("gitBranch" in row)) continue;
    const branch = (row as ClaudeConversationLine).gitBranch?.trim();
    if (branch) return branch;
  }
  return null;
}

function firstCodeBuddySessionMeta(rows: unknown[], fallbackRawId: string): { rawId: string; projectPath: string; timestamp: number } {
  let rawId = fallbackRawId;
  let projectPath = "";
  let timestamp = 0;

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const sessionId = stringField(row, "sessionId");
    const cwd = stringField(row, "cwd");
    const ts = parseTimestampMs(row.timestamp);
    if (sessionId && rawId === fallbackRawId) rawId = sessionId;
    if (cwd && !projectPath) projectPath = cwd;
    if (ts && !timestamp) timestamp = ts;
    if (rawId !== fallbackRawId && projectPath && timestamp) break;
  }

  return { rawId, projectPath, timestamp };
}

// Claude and CodeBuddy write their AI-generated session title as a dedicated
// `ai-title` row. The row is metadata and is not exposed as a visible message.
function firstAiTitle(rows: unknown[]): string {
  for (const row of rows) {
    if (!isRecord(row) || row.type !== "ai-title") continue;
    const title = stringField(row, "aiTitle").trim();
    if (title) return title;
  }
  return "";
}

export function loadCodexSessionRows(
  filePath: string,
  rows: unknown[],
  options: { title?: string; updatedAt?: string; sourceOverride?: SessionSource; stat?: VirtualSessionFileStat } = {},
): LoadedSession | null {
  if (rows.length === 0) return null;

  const meta = parseCodexSessionMetaLine(rows[0] as CodexConversationLine);
  if (!meta) return null;

  const messages = extractMessages(rows, "codex");
  const tokenEvents = extractCodexTokenEvents(rows);
  const traceEvents = extractTraceEvents(rows, "codex");
  const tokenUsage = tokenUsageFromEvents(tokenEvents);
  const question = firstQuestion(messages);
  const source: SessionSource = options.sourceOverride || (CODEX_APP_ORIGINATORS.has(meta.originator || "") ? "codex-app" : "codex-cli");
  const session = createIndexedSession({
    keyPrefix: source === "codex-internal" ? "codex-internal" : source === "tcodex-cli" ? "tcodex" : "codex",
    rawId: meta.id,
    source,
    projectPath: meta.projectPath,
    filePath,
    originalTitle: options.title || meta.title || cleanTitle(question) || "Untitled Session",
    firstQuestion: question ? cleanTitle(question) : "",
    timestamp: options.updatedAt ? new Date(options.updatedAt).getTime() : meta.ts,
    gitBranch: meta.gitBranch,
    tokenUsage,
    isSubagent: meta.isSubagent,
    parentSessionId: meta.parentSessionId,
    stat: options.stat,
  });

  return { session, messages, tokenEvents, traceEvents };
}

export function loadCodexSessionFile(filePath: string, title?: string, updatedAt?: string): LoadedSession | null {
  return loadCodexSessionRows(filePath, readJsonl(filePath), { title, updatedAt });
}

export function loadCodexSessions(codexDir = path.join(os.homedir(), ".codex"), sourceOverride?: SessionSource): LoadedSession[] {
  return [...loadCodexSessionsIterator(codexDir, sourceOverride)];
}

export function* loadCodexSessionsIterator(
  codexDir = path.join(os.homedir(), ".codex"),
  sourceOverride?: SessionSource,
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  const sessionsDir = path.join(codexDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return;

  const titleMap = new Map<string, { title: string; updatedAt: string }>();
  const indexPath = path.join(codexDir, "session_index.jsonl");
  const indexStat = fs.existsSync(indexPath) ? safeStat(indexPath) : { mtimeMs: 0, size: 0 };
  if (fs.existsSync(indexPath)) {
    for (const row of readJsonl(indexPath) as Array<{ id?: string; thread_name?: string; updated_at?: string }>) {
      if (row.id && row.thread_name) titleMap.set(row.id, { title: row.thread_name, updatedAt: row.updated_at || "" });
    }
  }

  for (const filePath of walkJsonlFiles(sessionsDir)) {
    const stat = safeStat(filePath);
    if (shouldSkipFile(options, filePath, stat, indexStat.mtimeMs)) continue;
    const rows = readJsonl(filePath);
    const meta = rows.length > 0 ? parseCodexSessionMetaLine(rows[0] as CodexConversationLine) : null;
    if (!meta) continue;
    const indexedTitle = titleMap.get(meta.id);
    const loaded = loadCodexSessionRows(filePath, rows, {
      title: indexedTitle?.title,
      updatedAt: indexedTitle?.updatedAt,
      sourceOverride,
      stat,
    });
    if (loaded) yield loaded;
  }
}

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

function loadClaudeMessages(filePath: string): SessionMessage[] {
  return extractMessages(readJsonl(filePath), "claude");
}

export function loadClaudeCliSessionRows(
  filePath: string,
  rows: unknown[],
  options: {
    rawId?: string;
    cwd?: string;
    startedAt?: number;
    source?: SessionSource;
    stat?: VirtualSessionFileStat;
    isSubagent?: boolean;
    parentSessionId?: string | null;
  } = {},
): LoadedSession | null {
  const rawId = options.rawId || path.basename(filePath, ".jsonl");
  const messages = extractMessages(rows, "claude");
  const tokenEvents = extractClaudeTokenEvents(rows);
  const traceEvents = extractTraceEvents(rows, "claude");
  const tokenUsage = tokenUsageFromEvents(tokenEvents);
  const question = firstQuestion(messages);
  const aiTitle = firstAiTitle(rows);
  const embeddedCwd = (rows.find((row) => row && typeof row === "object" && "cwd" in row) as ClaudeConversationLine | undefined)?.cwd;
  const gitBranch = firstClaudeGitBranch(rows);
  return {
    session: createIndexedSession({
      keyPrefix: options.source === "claude-internal" ? "claude-internal" : options.source === "tclaude-cli" ? "tclaude" : "claude",
      rawId,
      source: options.source ?? "claude-cli",
      projectPath: options.cwd || embeddedCwd || "",
      filePath,
      originalTitle: aiTitle || cleanTitle(question) || "Untitled Session",
      firstQuestion: cleanTitle(question),
      timestamp: options.startedAt || 0,
      gitBranch,
      tokenUsage,
      stat: options.stat,
      isSubagent: options.isSubagent,
      parentSessionId: options.parentSessionId,
    }),
    messages,
    tokenEvents,
    traceEvents,
  };
}

export function loadClaudeCliSessions(claudeDir = path.join(os.homedir(), ".claude"), source: SessionSource = "claude-cli"): LoadedSession[] {
  return [...loadClaudeCliSessionsIterator(claudeDir, source)];
}

export function* loadClaudeCliSessionsIterator(
  claudeDir = path.join(os.homedir(), ".claude"),
  source: SessionSource = "claude-cli",
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  const sessionsDir = path.join(claudeDir, "sessions");
  const projectsDir = path.join(claudeDir, "projects");
  if (!fs.existsSync(projectsDir)) return;

  const index = new Map<string, ClaudeSessionIndexFile>();
  const indexMtimeBySessionId = new Map<string, number>();
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const indexFilePath = path.join(sessionsDir, file);
        const parsed = JSON.parse(fs.readFileSync(indexFilePath, "utf-8")) as ClaudeSessionIndexFile;
        if (parsed.sessionId) {
          index.set(parsed.sessionId, parsed);
          indexMtimeBySessionId.set(parsed.sessionId, safeStat(indexFilePath).mtimeMs);
        }
      } catch {
        // Ignore malformed index files.
      }
    }
  }

  for (const projectDir of fs.readdirSync(projectsDir)) {
    const projectPath = path.join(projectsDir, projectDir);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) continue;
    for (const file of fs.readdirSync(projectPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const rawId = file.replace(/\.jsonl$/, "");
      const filePath = path.join(projectPath, file);
      const stat = safeStat(filePath);
      if (shouldSkipFile(options, filePath, stat, indexMtimeBySessionId.get(rawId) ?? 0)) continue;
      const loaded = loadClaudeCliSessionRows(filePath, readJsonl(filePath), {
        rawId,
        cwd: index.get(rawId)?.cwd,
        startedAt: index.get(rawId)?.startedAt,
        source,
        stat,
      });
      if (loaded) yield loaded;
    }

    for (const parentEntry of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (!parentEntry.isDirectory()) continue;
      const subagentsDir = path.join(projectPath, parentEntry.name, "subagents");
      if (!fs.existsSync(subagentsDir)) continue;
      for (const file of fs.readdirSync(subagentsDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(subagentsDir, file);
        const stat = safeStat(filePath);
        if (shouldSkipFile(options, filePath, stat)) continue;
        const rows = readJsonl(filePath);
        const relationRow = rows.find(
          (row): row is ClaudeConversationLine => Boolean(row && typeof row === "object" && ("sessionId" in row || "agentId" in row)),
        );
        const rawId = relationRow?.agentId || file.replace(/\.jsonl$/, "").replace(/^agent-?/, "");
        const parentSessionId = relationRow?.sessionId || parentEntry.name;
        const loaded = loadClaudeCliSessionRows(filePath, rows, {
          rawId,
          cwd: index.get(parentSessionId)?.cwd,
          source,
          stat,
          isSubagent: true,
          parentSessionId,
        });
        if (loaded) yield loaded;
      }
    }
  }
}

export function loadClaudeAppSessions(
  appSessionsDir = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
  claudeDir = path.join(os.homedir(), ".claude"),
): LoadedSession[] {
  return [...loadClaudeAppSessionsIterator(appSessionsDir, claudeDir)];
}

export function* loadClaudeAppSessionsIterator(
  appSessionsDir = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
  claudeDir = path.join(os.homedir(), ".claude"),
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  if (!fs.existsSync(appSessionsDir)) return;
  const projectsDir = path.join(claudeDir, "projects");
  const metaFiles: string[] = [];

  for (const userDir of fs.readdirSync(appSessionsDir)) {
    const userPath = path.join(appSessionsDir, userDir);
    if (!fs.existsSync(userPath) || !fs.statSync(userPath).isDirectory()) continue;
    for (const workspaceDir of fs.readdirSync(userPath)) {
      const workspacePath = path.join(userPath, workspaceDir);
      if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) continue;
      for (const entry of fs.readdirSync(workspacePath)) {
        if (entry.startsWith("local_") && entry.endsWith(".json")) metaFiles.push(path.join(workspacePath, entry));
      }
    }
  }

  for (const metaPath of metaFiles) {
    const metaStat = safeStat(metaPath);
    let appMeta: ClaudeAppSessionFile;
    try {
      appMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as ClaudeAppSessionFile;
    } catch {
      continue;
    }
    const rawId = appMeta.cliSessionId || appMeta.sessionId;
    const cwd = appMeta.cwd || appMeta.originCwd || "";
    const convoPath =
      rawId && cwd ? path.join(projectsDir, encodeClaudeProjectDir(cwd), `${rawId}.jsonl`) : metaPath;
    const stat = safeStat(convoPath);
    if (shouldSkipFile(options, convoPath, stat, metaStat.mtimeMs)) continue;
    const rows = fs.existsSync(convoPath) ? readJsonl(convoPath) : [];
    const messages = extractMessages(rows, "claude");
    const tokenEvents = extractClaudeTokenEvents(rows);
    const traceEvents = extractTraceEvents(rows, "claude");
    const tokenUsage = tokenUsageFromEvents(tokenEvents);
    const question = firstQuestion(messages);
    const title = appMeta.title && !/^Session\s+\d+$/i.test(appMeta.title) ? appMeta.title : cleanTitle(question);
    const gitBranch = firstClaudeGitBranch(rows);
    yield {
      session: createIndexedSession({
        keyPrefix: "claude",
        rawId,
        source: "claude-app",
        projectPath: cwd,
        filePath: convoPath,
        originalTitle: title || "Untitled Session",
        firstQuestion: cleanTitle(question),
        timestamp: appMeta.lastActivityAt || appMeta.createdAt || 0,
        prUrl: appMeta.prUrl || null,
        prNumber: appMeta.prNumber || null,
        gitBranch,
        tokenUsage,
        stat,
      }),
      messages,
      tokenEvents,
      traceEvents,
    };
  }
}

export function loadCodeBuddyCliSessions(codeBuddyDir = path.join(os.homedir(), CODEBUDDY_DIR)): LoadedSession[] {
  return [...loadCodeBuddyCliSessionsIterator(codeBuddyDir)];
}

export function loadCodeBuddyCliSessionRows(
  filePath: string,
  rows: unknown[],
  stat: VirtualSessionFileStat,
): LoadedSession | null {
  if (rows.length === 0) return null;

  const fallbackRawId = path.basename(filePath, ".jsonl");
  const meta = firstCodeBuddySessionMeta(rows, fallbackRawId);
  const messages = extractMessages(rows, "codebuddy");
  const tokenEvents = extractCodeBuddyTokenEvents(rows);
  const traceEvents = extractTraceEvents(rows, "codebuddy");
  const question = firstQuestion(messages);

  return {
    session: createIndexedSession({
      keyPrefix: "codebuddy",
      rawId: meta.rawId,
      source: "codebuddy-cli",
      projectPath: meta.projectPath,
      filePath,
      originalTitle: firstAiTitle(rows) || cleanTitle(question) || "Untitled Session",
      firstQuestion: cleanTitle(question),
      timestamp: meta.timestamp,
      tokenUsage: tokenUsageFromEvents(tokenEvents),
      stat,
    }),
    messages,
    tokenEvents,
    traceEvents,
  };
}

export function loadCodeBuddyCliSessionFile(filePath: string, stat = safeStat(filePath)): LoadedSession | null {
  return loadCodeBuddyCliSessionRows(filePath, readJsonl(filePath), stat);
}

export function* loadCodeBuddyCliSessionsIterator(
  codeBuddyDir = path.join(os.homedir(), CODEBUDDY_DIR),
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  const projectsDir = path.join(codeBuddyDir, "projects");
  if (!fs.existsSync(projectsDir)) return;

  for (const filePath of walkJsonlFiles(projectsDir)) {
    const stat = safeStat(filePath);
    if (shouldSkipFile(options, filePath, stat)) continue;
    const loaded = loadCodeBuddyCliSessionFile(filePath, stat);
    if (loaded) yield loaded;
  }
}

export function loadDefaultSessions(options: SessionLoadOptions = {}): LoadedSession[] {
  return [...loadDefaultSessionsIterator(options)];
}

export function* loadDefaultSessionsIterator(options: SessionLoadOptions = {}): Generator<LoadedSession> {
  const homeDir = options.homeDir ?? os.homedir();
  yield* loadClaudeCliSessionsIterator(path.join(homeDir, ".claude"), "claude-cli", options);
  yield* loadClaudeAppSessionsIterator(
    path.join(homeDir, "Library", "Application Support", "Claude", "claude-code-sessions"),
    path.join(homeDir, ".claude"),
    options,
  );
  yield* loadCodexSessionsIterator(path.join(homeDir, ".codex"), undefined, options);
  if (options.includeOpenClaw) {
    yield* loadOpenClawSessionsIterator(path.join(homeDir, ".openclaw"), options);
    yield* loadOpenClawSessionsIterator(path.join(homeDir, ".clawdbot"), options);
  }
  if (options.includeHermes) yield* loadHermesSessions();
  if (options.includeOpenCode) yield* loadOpenCodeSessions();
  if (options.includeZcode) yield* loadZcodeSessions(path.join(homeDir, ".zcode"));
  if (options.includeCodeWizCli) yield* loadCodeWizSessions(path.join(homeDir, CODEWIZ_SHARE_DIR));
  if (options.includeCursorAgent) yield* loadCursorAgentSessionsIterator(path.join(homeDir, ".cursor"), options);
  if (options.includeTrae) {
    for (const dirName of TRAE_DIR_NAMES) yield* loadTraeSessionsIterator(path.join(homeDir, dirName), options);
  }
  if (options.includeQoder) yield* loadQoderSessionsIterator(path.join(homeDir, QODER_DIR), options);
  if (options.includeClaudeInternal) yield* loadClaudeCliSessionsIterator(path.join(homeDir, CLAUDE_INTERNAL_DIR), "claude-internal", options);
  if (options.includeCodexInternal) yield* loadCodexSessionsIterator(path.join(homeDir, CODEX_INTERNAL_DIR), "codex-internal", options);
  if (options.includeTclaude) yield* loadClaudeCliSessionsIterator(path.join(homeDir, TCLAUDE_DIR), "tclaude-cli", options);
  if (options.includeTcodex) yield* loadCodexSessionsIterator(path.join(homeDir, TCODEX_DIR), "tcodex-cli", options);
  if (options.includeCodeBuddyCli) yield* loadCodeBuddyCliSessionsIterator(path.join(homeDir, CODEBUDDY_DIR), options);
}
