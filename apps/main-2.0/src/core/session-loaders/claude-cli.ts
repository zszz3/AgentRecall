import * as path from "node:path";

import { cleanTitle } from "../format-adapters";
import type { ClaudeConversationLine, LoadedSession, SessionSource, TokenUsageEvent } from "../types";
import {
  createIndexedSession,
  createTokenUsage,
  dedupeTraceEvents,
  extractMessages,
  firstQuestion,
  firstStringField,
  isRecord,
  numberField,
  objectField,
  parseTimestampMs,
  putTokenEvent,
  stringifyDetail,
  stringField,
  titleWithSummary,
  tokenUsageFromEvents,
  unknownField,
  type TraceEventDraft,
  type VirtualSessionFileStat,
} from "./common";

export function claudeVisibleConversationRows(rows: unknown[]): unknown[] {
  const conversationRows = rows.filter((row) => isRecord(row) && (row.type === "user" || row.type === "assistant"));
  if (conversationRows.length === 0) return rows;

  // Some transcripts (e.g. Qoder long-running task execution logs) do not chain
  // turns through `parentUuid` at all. With no links to walk there is no hidden
  // branch to filter, and collapsing to the last visible turn would discard the
  // whole conversation except its final message.
  const chained = conversationRows.some((row) => {
    const parentUuid = unknownField(row, "parentUuid");
    return parentUuid !== null && parentUuid !== undefined && parentUuid !== "";
  });
  if (!chained) return rows;

  const nodes = new Map<string, Record<string, unknown>>();
  for (const row of conversationRows) {
    if (!isRecord(row)) return rows;
    const uuid = stringField(row, "uuid");
    if (!uuid || nodes.has(uuid)) return rows;
    nodes.set(uuid, row);
  }

  const visibleUuids = new Set<string>();
  let current = conversationRows.at(-1) as Record<string, unknown>;
  while (current) {
    const uuid = stringField(current, "uuid");
    if (!uuid || visibleUuids.has(uuid)) return rows;
    visibleUuids.add(uuid);
    const parentUuid = unknownField(current, "parentUuid");
    if (parentUuid === null || parentUuid === undefined || parentUuid === "") break;
    if (typeof parentUuid !== "string") return rows;
    const parent = nodes.get(parentUuid);
    if (!parent) return rows;
    current = parent;
  }

  return rows.filter((row) => {
    if (!isRecord(row) || (row.type !== "user" && row.type !== "assistant")) return true;
    return visibleUuids.has(stringField(row, "uuid"));
  });
}

export function extractClaudeTraceEvents(rows: unknown[]): TraceEventDraft[] {
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
          status: "running",
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
          status: unknownField(block, "is_error") === true ? "failed" : "completed",
        });
      }
    }
  }

  return events;
}

export function extractClaudeTokenEvents(rows: unknown[]): TokenUsageEvent[] {
  const entries = new Map<string, TokenUsageEvent>();

  rows.forEach((row, index) => {
    if (!isRecord(row) || row.type !== "assistant") return;
    const message = objectField(row, "message");
    const usage = objectField(message, "usage");
    if (!usage) return;

    const cached =
      numberField(usage, "cache_read_input_tokens") +
      numberField(usage, "cached_input_tokens");
    const cacheCreation = numberField(usage, "cache_creation_input_tokens");
    const entry = createTokenUsage(
      numberField(usage, "input_tokens"),
      numberField(usage, "output_tokens"),
      cached,
      numberField(usage, "reasoning_output_tokens"),
      cacheCreation,
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

export function firstClaudeGitBranch(rows: unknown[]): string | null {
  for (const row of rows) {
    if (!row || typeof row !== "object" || !("gitBranch" in row)) continue;
    const branch = (row as ClaudeConversationLine).gitBranch?.trim();
    if (branch) return branch;
  }
  return null;
}

// Claude and CodeBuddy write their AI-generated session title as a dedicated
// `ai-title` row. The row is metadata and is not exposed as a visible message.
export function firstAiTitle(rows: unknown[]): string {
  for (const row of rows) {
    if (!isRecord(row) || row.type !== "ai-title") continue;
    const title = stringField(row, "aiTitle").trim();
    if (title) return title;
  }
  return "";
}

export function loadClaudeCliSessionRows(
  filePath: string,
  rows: unknown[],
  options: {
    rawId?: string;
    cwd?: string;
    startedAt?: number;
    source?: SessionSource;
    keyPrefix?: "claude" | "tclaude" | "stepcode-claude" | "qoder";
    stepcodeAgent?: "claude" | "codex";
    stat?: VirtualSessionFileStat;
    isSubagent?: boolean;
    parentSessionId?: string | null;
    includeTraceEvents?: boolean;
  } = {},
): LoadedSession | null {
  const rawId = options.rawId || path.basename(filePath, ".jsonl");
  const visibleRows = claudeVisibleConversationRows(rows);
  const messages = extractMessages(visibleRows, "claude");
  const tokenEvents = extractClaudeTokenEvents(rows);
  const traceEvents = options.includeTraceEvents === false ? [] : dedupeTraceEvents(extractClaudeTraceEvents(visibleRows));
  const tokenUsage = tokenUsageFromEvents(tokenEvents);
  const question = firstQuestion(messages);
  let customTitle = "";
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!isRecord(row) || row.type !== "custom-title") continue;
    customTitle = stringField(row, "customTitle").trim();
    if (customTitle) break;
  }
  const aiTitle = firstAiTitle(rows);
  const embeddedCwd = (rows.find((row) => row && typeof row === "object" && "cwd" in row) as ClaudeConversationLine | undefined)?.cwd;
  const gitBranch = firstClaudeGitBranch(rows);
  const source = options.source
    ?? (options.stepcodeAgent === "claude" ? "stepcode-claude" : "claude-cli");
  return {
    session: createIndexedSession({
      keyPrefix: options.keyPrefix
        ?? (source === "tclaude-cli"
          ? "tclaude"
          : source === "stepcode-claude"
            ? "stepcode-claude"
            : "claude"),
      rawId,
      source,
      projectPath: options.cwd || embeddedCwd || "",
      filePath,
      originalTitle: customTitle || aiTitle || cleanTitle(question) || "Untitled Session",
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
