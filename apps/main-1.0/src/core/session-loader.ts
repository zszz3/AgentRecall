import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  cleanTitle,
  cursorTimestampFromRow,
  extractCursorUserQuery,
  getAdapter,
  isMeaningfulUserMessage,
  stripCodexInjectedNoise,
} from "./format-adapters";
import { scanCompleteJsonl, scanCompleteJsonlAsync } from "./codex-jsonl-stream";
import {
  CodexRolloutAccumulator,
  dedupeCodexTraceEvents,
  extractCodexExecToolNames,
  formatCodexToolDetail,
  sanitizeCodexTraceValue,
} from "./session-loaders/codex-rollout";
import { truncateTraceDetail } from "./trace-detail";
import {
  DEEPSEEK_HARNESS_DIR,
  DEEPSEEK_HARNESS_LOG_NAME,
  parseDeepSeekSessionLog,
  projectDeepSeekSession,
} from "./deepseek-harness";
import type {
  CodeBuddyConversationLine,
  ClaudeAppSessionFile,
  ClaudeConversationLine,
  ClaudeSessionIndexFile,
  CodexHistoryMode,
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

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => import("node:sqlite").DatabaseSync };

const CODEX_APP_ORIGINATORS = new Set(["Codex Desktop", "codex_work_desktop"]);
const CODEX_FUNCTION_OUTPUT_MARKER = Buffer.from('"type":"function_call_output"');
const CODEX_CUSTOM_TOOL_OUTPUT_MARKER = Buffer.from('"type":"custom_tool_call_output"');
const CODEX_INLINE_IMAGE_MARKER = Buffer.from('"image_url":"data:image/');
const TCLAUDE_DIR = ".tclaude";
const TCODEX_DIR = ".tcodex";
const CODEBUDDY_DIR = ".codebuddy";
const WORKBUDDY_DIR = ".workbuddy";
const CODEWIZ_SHARE_DIR = path.join(".local", "share", "codewiz");
const QODER_DIR = ".qoder";
const PI_SESSIONS_DIR = path.join(".pi", "agent", "sessions");
const KIMI_CODE_DIR = ".kimi-code";
const KIMI_LEGACY_DIR = ".kimi";
const TRAE_DIR_NAMES = [".trae", ".trae-cn"] as const;
const CODEX_WORKSPACE_PLACEHOLDER = /^<[^>]+>$/u;

function resolveKimiCodeRoot(homeDir: string, options: SessionLoadOptions): string {
  return options.homeDir === undefined
    ? process.env.KIMI_CODE_HOME?.trim() || path.join(homeDir, KIMI_CODE_DIR)
    : path.join(homeDir, KIMI_CODE_DIR);
}

export interface SessionLoadOptions {
  homeDir?: string;
  includePi?: boolean;
  includeKimiCli?: boolean;
  includeTclaude?: boolean;
  includeTcodex?: boolean;
  includeCodeBuddyCli?: boolean;
  includeWorkBuddy?: boolean;
  includeCodeWizCli?: boolean;
  includeOpenClaw?: boolean;
  includeHermes?: boolean;
  includeOpenCode?: boolean;
  includeZcode?: boolean;
  includeCursorAgent?: boolean;
  includeTrae?: boolean;
  includeQoder?: boolean;
  includeDeepSeekCli?: boolean;
  cursorStateDbPath?: string;
  cursorWorkspacePathMap?: ReadonlyMap<string, string>;
  shouldSkipFile?: (filePath: string, stat: VirtualSessionFileStat, dependencyMtimeMs?: number) => boolean;
  onSkippedFile?: (filePath: string, stat: VirtualSessionFileStat) => void;
  incrementalCodexSessions?: ReadonlyMap<string, { offset: number; loaded: LoadedSession }>;
  loadIncrementalCodexSession?: (
    filePath: string,
  ) => { offset: number; loaded: LoadedSession } | undefined;
}

export interface VirtualSessionFileStat {
  mtimeMs: number;
  size: number;
}

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

export function parseCodexSessionMetaLine(parsed: unknown): {
  id: string;
  projectPath: string;
  ts: number;
  title?: string;
  gitBranch?: string;
  originator?: string;
  isSubagent: boolean;
  parentSessionId: string | null;
  agentPath?: string | null;
  historyMode?: CodexHistoryMode;
} | null {
  if (!parsed || typeof parsed !== "object") return null;

  const line = parsed as CodexConversationLine;
  const payload = line.payload;
  const sessionId = payload?.id || payload?.session_id;
  if (line.type === "session_meta" && payload && sessionId) {
    const structuredSource =
      payload.source && typeof payload.source === "object" ? payload.source : null;
    const structuredParent = structuredSource?.subagent?.thread_spawn?.parent_thread_id;
    const legacyParent = payload.thread_source === "subagent" ? payload.parent_thread_id : undefined;
    const parentSessionId = structuredParent || legacyParent || null;
    const agentPath = payload.agent_path
      || structuredSource?.subagent?.thread_spawn?.agent_path
      || (parentSessionId === null ? "/root" : null);
    return {
      id: sessionId,
      projectPath: typeof payload.agent_recall_project_path === "string"
        ? payload.agent_recall_project_path
        : payload.cwd || "",
      ts: line.timestamp ? new Date(line.timestamp).getTime() : 0,
      title: payload.title,
      gitBranch: payload.git?.branch,
      originator: payload.originator,
      isSubagent: parentSessionId !== null,
      parentSessionId,
      agentPath,
      historyMode: (payload as { history_mode?: unknown }).history_mode === "paginated" ? "paginated" : "legacy",
    };
  }

  if (line.id && line.timestamp && !line.type) {
    return {
      id: line.id,
      projectPath: line.git?.cwd || "",
      ts: new Date(line.timestamp).getTime(),
      gitBranch: line.git?.branch,
      isSubagent: false,
      parentSessionId: null,
      agentPath: "/root",
      historyMode: "legacy",
    };
  }

  return null;
}

function findCodexSessionMeta(rows: unknown[]): NonNullable<ReturnType<typeof parseCodexSessionMetaLine>> | null {
  let result: NonNullable<ReturnType<typeof parseCodexSessionMetaLine>> | null = null;
  for (const row of rows) {
    const parsed = parseCodexSessionMetaLine(row);
    if (!parsed) continue;
    if (!result) {
      result = parsed;
      continue;
    }
    result = {
      ...result,
      projectPath: usableCodexProjectPath(result.projectPath) ? result.projectPath : parsed.projectPath || result.projectPath,
      ts: result.ts || parsed.ts,
      title: result.title || parsed.title,
      gitBranch: result.gitBranch || parsed.gitBranch,
      originator: result.originator || parsed.originator,
      isSubagent: result.isSubagent || parsed.isSubagent,
      parentSessionId: result.parentSessionId || parsed.parentSessionId,
      agentPath: result.agentPath || parsed.agentPath,
      historyMode: result.historyMode === "paginated" || parsed.historyMode === "paginated" ? "paginated" : "legacy",
    };
  }
  const turnContextProjectPath = rows
    .map(codexTurnContextProjectPath)
    .find((projectPath): projectPath is string => Boolean(projectPath));
  if (result && !usableCodexProjectPath(result.projectPath) && turnContextProjectPath) {
    result.projectPath = turnContextProjectPath;
  }
  return result;
}

function usableCodexProjectPath(value: string): boolean {
  const normalized = value.trim();
  return Boolean(normalized) && !CODEX_WORKSPACE_PLACEHOLDER.test(normalized);
}

function codexTurnContextProjectPath(value: unknown): string {
  if (!isRecord(value) || value.type !== "turn_context") return "";
  const payload = objectField(value, "payload");
  const cwd = stringField(payload, "cwd").trim();
  if (usableCodexProjectPath(cwd)) return cwd;
  const roots = payload?.workspace_roots;
  if (!Array.isArray(roots)) return "";
  return roots.find((root): root is string => typeof root === "string" && usableCodexProjectPath(root))?.trim() || "";
}

export function safeStat(filePath: string): VirtualSessionFileStat {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function shouldSkipFile(options: SessionLoadOptions, filePath: string, stat = safeStat(filePath), dependencyMtimeMs = 0): boolean {
  if (!options.shouldSkipFile?.(filePath, stat, dependencyMtimeMs)) return false;
  options.onSkippedFile?.(filePath, stat);
  return true;
}

export function parseJsonlText(content: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Keep parsing the rest of the JSONL text.
    }
  }
  return rows;
}

function readJsonl(filePath: string): unknown[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  return parseJsonlText(content);
}

function extractMessages(rows: unknown[], format: SessionFormat): SessionMessage[] {
  const adapter = getAdapter(format);
  const messages: SessionMessage[] = [];
  for (const raw of rows) {
    const parsed = adapter.parseLine(raw);
    if (!parsed) continue;
    if (parsed.role === "user" && !isMeaningfulUserMessage(parsed.content)) continue;
    messages.push({ ...parsed, index: messages.length });
  }
  return messages;
}

function codexVisibleConversationRows(rows: unknown[]): unknown[] {
  const adapter = getAdapter("codex");
  const rollout = new CodexRolloutAccumulator();
  const preamble: unknown[] = [];
  const turns: Array<{ rows: unknown[]; hasUserMessage: boolean }> = [];
  const seenUserRecords = new Set<string>();
  let currentTurn: (typeof turns)[number] | null = null;

  for (const row of rows) {
    const payload = objectField(row, "payload");
    if (isRecord(row) && row.type === "event_msg" && payload?.type === "thread_rolled_back") {
      const numTurns = payload.num_turns;
      if (!Number.isSafeInteger(numTurns) || (numTurns as number) <= 0 || (numTurns as number) > turns.length) return rows;
      turns.splice(turns.length - (numTurns as number), numTurns as number);
      currentTurn = turns.at(-1) ?? null;
      continue;
    }

    const result = rollout.consume(row);
    if (isRecord(row) && row.type === "event_msg" && payload?.type === "task_started") {
      const rowWithTurnId = result.sourceTurnId
        ? { ...row, payload: { ...payload, turn_id: result.sourceTurnId } }
        : row;
      currentTurn = { rows: [rowWithTurnId], hasUserMessage: false };
      turns.push(currentTurn);
      continue;
    }
    const completedMessage = result.completedMessage;
    const parsed = adapter.parseLine(row);
    const responseUser = rollout.historyMode === "legacy" && parsed?.role === "user";
    const completedUser = completedMessage?.role === "user"
      && !seenUserRecords.has(completedMessage.replacesSourceRecordId);
    const userContent = responseUser
      ? parsed.content
      : completedMessage?.role === "user"
        ? stripCodexInjectedNoise(completedMessage.content)
        : "";
    if ((responseUser || completedUser) && userContent && isMeaningfulUserMessage(userContent)) {
      if (currentTurn && !currentTurn.hasUserMessage) {
        currentTurn.rows.push(row);
        currentTurn.hasUserMessage = true;
      } else {
        currentTurn = { rows: [row], hasUserMessage: true };
        turns.push(currentTurn);
      }
      if (responseUser && result.message?.sourceRecordId) {
        seenUserRecords.add(result.message.sourceRecordId);
      }
    } else if (currentTurn) {
      currentTurn.rows.push(row);
    } else {
      preamble.push(row);
    }
  }

  return [...preamble, ...turns.flatMap((turn) => turn.rows)];
}

function claudeVisibleConversationRows(rows: unknown[]): unknown[] {
  const conversationRows = rows.filter((row) => isRecord(row) && (row.type === "user" || row.type === "assistant"));
  if (conversationRows.length === 0) return rows;

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

function firstQuestion(messages: SessionMessage[]): string {
  return messages.find((message) => message.role === "user" && isMeaningfulUserMessage(message.content))?.content || "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return isRecord(field) ? field : null;
}

function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function numberField(value: unknown, key: string): number {
  if (!isRecord(value)) return 0;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function unknownField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function stringifyDetail(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return truncateTraceDetail(value);
  try {
    return truncateTraceDetail(JSON.stringify(value, null, 2));
  } catch {
    return truncateTraceDetail(String(value));
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function firstStringField(value: unknown, keys: string[]): string {
  if (!isRecord(value)) return "";
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  return "";
}

function titleWithSummary(name: string, summary: string): string {
  return summary ? `${name} · ${summary}` : name;
}

function mcpResultStatus(result: unknown): SessionTraceEvent["status"] {
  if (!isRecord(result)) return "unknown";
  if ("Err" in result) return "failed";
  const ok = result.Ok;
  if (!isRecord(ok)) return "unknown";
  if (ok.isError === true) return "failed";
  if (ok.isError === false) return "completed";
  return "unknown";
}

function mcpDurationAttribute(duration: unknown): { durationMs?: number } {
  if (!isRecord(duration)) return {};
  const secs = typeof duration.secs === "number" && Number.isFinite(duration.secs) ? duration.secs : null;
  const nanos = typeof duration.nanos === "number" && Number.isFinite(duration.nanos) ? duration.nanos : null;
  if (secs === null && nanos === null) return {};
  const durationMs = Math.round((secs ?? 0) * 1_000 + (nanos ?? 0) / 1_000_000);
  return durationMs >= 0 ? { durationMs } : {};
}

function statusFromExit(exitCode: number | undefined, fallback?: boolean): "completed" | "failed" | "unknown" {
  if (typeof exitCode === "number") return exitCode === 0 ? "completed" : "failed";
  if (typeof fallback === "boolean") return fallback ? "completed" : "failed";
  return "unknown";
}

function joinNonEmpty(parts: string[]): string {
  return truncateTraceDetail(parts.filter((part) => part.trim()).join("\n\n"));
}

type TraceEventDraft = Omit<SessionTraceEvent, "index">;

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

function extractCodexResponseTrace(
  row: Record<string, unknown>,
  sourceTurnId: string | null = null,
): TraceEventDraft[] {
  if (row.type !== "response_item") return [];
  const payload = objectField(row, "payload");
  if (!payload) return [];
  const payloadType = stringField(payload, "type");
  const callId = stringField(payload, "call_id") || stringField(payload, "id") || null;
  const status = stringField(payload, "status");
  const normalizedStatus: SessionTraceEvent["status"] =
    status === "in_progress" ? "running"
      : status === "completed" ? "completed"
        : status === "failed" ? "failed"
          : "unknown";

  if (
    payloadType === "function_call"
    || payloadType === "custom_tool_call"
    || payloadType === "local_shell_call"
    || payloadType === "tool_search_call"
  ) {
    const args =
      payloadType === "custom_tool_call" ? unknownField(payload, "input")
        : payloadType === "local_shell_call" ? unknownField(payload, "action")
          : payloadType === "tool_search_call" ? unknownField(payload, "arguments")
            : parseMaybeJson(unknownField(payload, "arguments"));
    const namespace = stringField(payload, "namespace");
    const fallbackName =
      payloadType === "local_shell_call" ? "shell"
        : payloadType === "tool_search_call" ? stringField(payload, "execution") || "tool search"
          : "tool";
    const rawName = stringField(payload, "name") || fallbackName;
    const name = namespace ? `${namespace}.${rawName}` : rawName;
    const nestedTools = payloadType === "custom_tool_call" && rawName === "exec"
      ? extractCodexExecToolNames(args)
      : [];
    const summary = nestedTools.length > 0
      ? nestedTools.map((tool) => tool.replaceAll("__", ".")).join(", ")
      : firstStringField(args, ["command", "cmd", "query", "path", "file_path", "url"]);
    const eventType =
      payloadType === "function_call" ? "codex.function_call"
        : payloadType === "custom_tool_call" ? "codex.custom_tool"
          : payloadType === "local_shell_call" ? "codex.local_shell"
            : "codex.tool_search";
    const safeInput = sanitizeCodexTraceValue(args);
    return [
      {
        kind: payloadType === "local_shell_call"
          && normalizedStatus !== "unknown"
          && normalizedStatus !== "running"
          ? "tool_result"
          : "tool_call",
        source: "codex",
        title: titleWithSummary(name, summary),
        detail: formatCodexToolDetail(safeInput, null),
        timestamp: stringField(row, "timestamp"),
        callId,
        eventType,
        status: normalizedStatus,
        sourceTurnId,
        attributes: {
          input: safeInput,
          ...(nestedTools.length > 0 ? { nestedTools } : {}),
        },
      },
    ];
  }

  if (
    payloadType === "function_call_output"
    || payloadType === "custom_tool_call_output"
    || payloadType === "tool_search_output"
  ) {
    const output = payloadType === "tool_search_output"
      ? { status: unknownField(payload, "status"), tools: unknownField(payload, "tools") }
      : parseMaybeJson(unknownField(payload, "output"));
    const safeOutput = sanitizeCodexTraceValue(output);
    const eventType =
      payloadType === "function_call_output" ? "codex.function_call"
        : payloadType === "custom_tool_call_output" ? "codex.custom_tool"
          : "codex.tool_search";
    return [
      {
        kind: "tool_result",
        source: "codex",
        title: payloadType === "tool_search_output"
          ? stringField(payload, "execution") || "tool search"
          : "tool output",
        detail: formatCodexToolDetail(null, safeOutput),
        timestamp: stringField(row, "timestamp"),
        callId,
        eventType,
        status: normalizedStatus === "unknown" ? "completed" : normalizedStatus,
        sourceTurnId,
        attributes: { output: safeOutput },
      },
    ];
  }

  if (payloadType === "web_search_call" || payloadType === "image_generation_call") {
    const input = payloadType === "web_search_call"
      ? unknownField(payload, "action")
      : { revisedPrompt: unknownField(payload, "revised_prompt") };
    const safeInput = sanitizeCodexTraceValue(input);
    return [{
      kind: normalizedStatus === "running" ? "tool_call" : "tool_result",
      source: "codex",
      title: payloadType === "web_search_call" ? "web search" : "image generation",
      detail: formatCodexToolDetail(safeInput, null),
      timestamp: stringField(row, "timestamp"),
      callId,
      eventType: payloadType === "web_search_call" ? "codex.web_search" : "codex.image_generation",
      status: normalizedStatus,
      sourceTurnId,
      attributes: { input: safeInput },
    }];
  }

  return [];
}

function extractCodexEventTrace(
  row: Record<string, unknown>,
  sourceTurnId: string | null = null,
): TraceEventDraft[] {
  if (row.type !== "event_msg") return [];
  const payload = objectField(row, "payload");
  const eventType = stringField(payload, "type");
  if (!payload || !eventType) return [];

  const common = {
    source: "codex" as const,
    timestamp: stringField(row, "timestamp"),
    callId: stringField(payload, "call_id") || null,
    eventType,
    sourceTurnId,
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
        attributes: {
          input: sanitizeCodexTraceValue({
            command: unknownField(payload, "command"),
            cwd: unknownField(payload, "cwd"),
            parsedCommand: unknownField(payload, "parsed_cmd"),
          }),
          output: sanitizeCodexTraceValue({
            stdout: unknownField(payload, "stdout"),
            stderr: unknownField(payload, "stderr"),
            aggregatedOutput: unknownField(payload, "aggregated_output"),
            formattedOutput: unknownField(payload, "formatted_output"),
            exitCode: unknownField(payload, "exit_code"),
          }),
        },
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
        attributes: {
          input: sanitizeCodexTraceValue({ changes: unknownField(payload, "changes") }),
          output: sanitizeCodexTraceValue({
            stdout: unknownField(payload, "stdout"),
            stderr: unknownField(payload, "stderr"),
            success: unknownField(payload, "success"),
          }),
        },
      },
    ];
  }

  if (eventType === "mcp_tool_call_end") {
    const invocation = unknownField(payload, "invocation");
    const invocationName = firstStringField(invocation, ["name", "tool", "method"]);
    const result = unknownField(payload, "result");
    return [
      {
        ...common,
        kind: "event",
        title: titleWithSummary("mcp", invocationName || stringField(payload, "plugin_id")),
        detail: stringifyDetail(result || invocation),
        status: mcpResultStatus(result),
        attributes: {
          input: sanitizeCodexTraceValue(invocation),
          output: sanitizeCodexTraceValue(result),
          ...mcpDurationAttribute(unknownField(payload, "duration")),
        },
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
        attributes: {
          input: sanitizeCodexTraceValue({
            query: unknownField(payload, "query"),
            action: unknownField(payload, "action"),
          }),
        },
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
        status: "failed",
      },
    ];
  }

  return [];
}

function extractCodexTraceEvents(rows: unknown[]): TraceEventDraft[] {
  const rollout = new CodexRolloutAccumulator();
  const events: TraceEventDraft[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const result = rollout.consume(row);
    events.push(
      ...extractCodexResponseTrace(row, result.sourceTurnId),
      ...extractCodexEventTrace(row, result.sourceTurnId),
      ...result.traceEvents,
    );
  }
  return events;
}

function extractCodexMessages(rows: unknown[]): {
  messages: SessionMessage[];
  messageProvenance: Array<{ messageIndex: number; sourceRecordId: string | null }>;
  historyMode: CodexHistoryMode;
  activeTurnIds: string[];
  agentPath: string | null;
  pendingInterAgentCommunication: { triggerTurn: boolean } | null;
} {
  const adapter = getAdapter("codex");
  const rollout = new CodexRolloutAccumulator();
  const messages: SessionMessage[] = [];
  const messageProvenance: Array<{ messageIndex: number; sourceRecordId: string | null }> = [];
  const provenanceIndexes = new Map<string, number>();
  for (const row of rows) {
    const result = rollout.consume(row);
    const context = result.message;
    if (result.completedMessage) {
      const completed = result.completedMessage;
      const content = completed.role === "user"
        ? stripCodexInjectedNoise(completed.content)
        : completed.content;
      if (completed.role === "user" && !isMeaningfulUserMessage(content)) continue;
      const replacement = provenanceIndexes.get(completed.replacesSourceRecordId) ?? -1;
      const nextMessage: SessionMessage = {
        role: completed.role,
        content,
        timestamp: completed.timestamp,
        index: replacement >= 0 ? replacement : messages.length,
        sourceTurnId: completed.sourceTurnId,
        phase: completed.phase,
        ...(replacement >= 0 && messages[replacement].attachments
          ? { attachments: messages[replacement].attachments }
          : {}),
      };
      if (replacement >= 0) {
        messages[replacement] = nextMessage;
        messageProvenance[replacement] = {
          messageIndex: replacement,
          sourceRecordId: completed.sourceRecordId,
        };
        provenanceIndexes.delete(completed.replacesSourceRecordId);
        provenanceIndexes.set(completed.sourceRecordId, replacement);
      } else {
        messages.push(nextMessage);
        messageProvenance.push({
          messageIndex: nextMessage.index,
          sourceRecordId: completed.sourceRecordId,
        });
        provenanceIndexes.set(completed.sourceRecordId, nextMessage.index);
      }
      continue;
    }
    const parsed = adapter.parseLine(row);
    if (!parsed || (parsed.role === "user" && !isMeaningfulUserMessage(parsed.content))) continue;
    if (rollout.historyMode === "paginated" && parsed.role === "user") continue;
    const index = messages.length;
    messages.push({
      ...parsed,
      index,
      sourceTurnId: context?.sourceTurnId ?? null,
      phase: parsed.role === "assistant" ? context?.phase ?? null : null,
    });
    const sourceRecordId = context?.sourceRecordId ?? null;
    messageProvenance.push({ messageIndex: index, sourceRecordId });
    if (sourceRecordId) provenanceIndexes.set(sourceRecordId, index);
  }
  return {
    messages,
    messageProvenance,
    historyMode: rollout.historyMode,
    activeTurnIds: rollout.getActiveTurnIds(),
    agentPath: rollout.agentPath,
    pendingInterAgentCommunication: rollout.getPendingInterAgentCommunication(),
  };
}

function dedupeTraceEvents(events: TraceEventDraft[]): SessionTraceEvent[] {
  const eventCallIds = new Set(events.filter((event) => event.kind === "event" && event.callId).map((event) => event.callId));
  return events
    .filter((event) => !(event.kind === "tool_result" && event.callId && eventCallIds.has(event.callId)))
    .map((event, index) => ({ ...event, index }));
}

function extractTraceEvents(rows: unknown[], format: SessionFormat): SessionTraceEvent[] {
  if (format === "claude") return dedupeTraceEvents(extractClaudeTraceEvents(rows));
  if (format === "codex") return dedupeCodexTraceEvents(extractCodexTraceEvents(rows));
  if (format === "workbuddy") return extractWorkBuddyTraceEvents(rows);
  return [];
}

function extractWorkBuddyTraceEvents(rows: unknown[]): SessionTraceEvent[] {
  const events: TraceEventDraft[] = [];
  const callNames = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const rowType = stringField(row, "type");
    const timestamp = timestampString(unknownField(row, "timestamp"));
    const callId = stringField(row, "callId");
    if (rowType === "function_call") {
      const input = parseMaybeJson(unknownField(row, "arguments"));
      const name = stringField(row, "name");
      if (!name || !callId) continue;
      callNames.set(callId, name);
      const summary = firstStringField(input, ["command", "cmd", "path", "file_path", "query", "url"]);
      events.push({
        kind: "tool_call",
        source: "workbuddy",
        title: titleWithSummary(name, summary),
        detail: stringifyDetail(input),
        timestamp,
        callId,
        eventType: "workbuddy.function_call",
        status: "running",
        attributes: { input },
      });
      continue;
    }
    if (rowType !== "function_call_result" || !callId) continue;

    const parsedOutput = parseMaybeJson(unknownField(row, "output"));
    const output = workBuddyTraceText(parsedOutput) || parsedOutput;
    const rowStatus = stringField(row, "status");
    const failed = unknownField(row, "isError") === true || rowStatus === "failed" || rowStatus === "error";
    const name = stringField(row, "name") || callNames.get(callId);
    if (!name) continue;
    events.push({
      kind: "tool_result",
      source: "workbuddy",
      title: `${name} result`,
      detail: stringifyDetail(output),
      timestamp,
      callId,
      eventType: "workbuddy.function_call_result",
      status: failed ? "failed" : "completed",
      attributes: { output: parsedOutput },
    });
  }
  return dedupeTraceEvents(events);
}

function workBuddyTraceText(value: unknown): string {
  if (Array.isArray(value)) return value.map(workBuddyTraceText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  return stringField(value, "text");
}

function addTokenUsage(total: TokenUsage, next: TokenUsage): void {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.cachedInputTokens += next.cachedInputTokens;
  if (total.cacheCreationInputTokens !== undefined || next.cacheCreationInputTokens !== undefined) {
    total.cacheCreationInputTokens = (total.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0);
  }
  total.reasoningOutputTokens += next.reasoningOutputTokens;
  total.totalTokens += next.totalTokens;
}

function createTokenUsage(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  reasoningOutputTokens: number,
  cacheCreationInputTokens = 0,
): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + cachedInputTokens + cacheCreationInputTokens + reasoningOutputTokens,
  };
}

function parseTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function tokenEvent(
  timestamp: number,
  dedupeKey: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  reasoningOutputTokens: number,
  cacheCreationInputTokens = 0,
): TokenUsageEvent {
  return {
    timestamp,
    dedupeKey,
    ...createTokenUsage(inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens, cacheCreationInputTokens),
  };
}

function putTokenEvent(entries: Map<string, TokenUsageEvent>, entry: TokenUsageEvent): void {
  const existing = entries.get(entry.dedupeKey);
  if (!existing || entry.totalTokens > existing.totalTokens) entries.set(entry.dedupeKey, entry);
}

function tokenUsageFromEvents(events: TokenUsageEvent[]): TokenUsage {
  const total = emptyTokenUsage();
  for (const entry of events) addTokenUsage(total, entry);
  return total;
}

function subtractTokenUsage(current: TokenUsage, previous: TokenUsage | null): TokenUsage {
  if (!previous) return current;
  return createTokenUsage(
    Math.max(0, current.inputTokens - previous.inputTokens),
    Math.max(0, current.outputTokens - previous.outputTokens),
    Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    Math.max(0, current.reasoningOutputTokens - previous.reasoningOutputTokens),
    Math.max(0, (current.cacheCreationInputTokens ?? 0) - (previous.cacheCreationInputTokens ?? 0)),
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

interface CodexTokenRow {
  row: unknown;
  sourceTurnId: string | null;
}

function collectCodexTokenRows(rows: unknown[]): CodexTokenRow[] {
  const rollout = new CodexRolloutAccumulator();
  const startedTurnIds: string[] = [];
  const tokenRows: CodexTokenRow[] = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const payload = objectField(row, "payload");
    if (row.type === "event_msg" && payload?.type === "thread_rolled_back") {
      const numTurns = payload.num_turns;
      if (Number.isSafeInteger(numTurns) && (numTurns as number) > 0 && (numTurns as number) <= startedTurnIds.length) {
        rollout.discardActiveTurnIds(startedTurnIds.splice(startedTurnIds.length - (numTurns as number), numTurns as number));
      }
      continue;
    }

    const rolloutRecord = rollout.consume(row);
    if (row.type === "event_msg" && payload?.type === "task_started" && rolloutRecord.sourceTurnId) {
      startedTurnIds.push(rolloutRecord.sourceTurnId);
    }
    if (row.type === "turn_context" || (row.type === "event_msg" && stringField(payload, "type") === "token_count")) {
      tokenRows.push({ row, sourceTurnId: rolloutRecord.sourceTurnId });
    }
  }

  return tokenRows;
}

function extractCodexTokenEvents(rows: readonly CodexTokenRow[]): TokenUsageEvent[] {
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

  for (const tokenRow of rows) {
    const { row, sourceTurnId } = tokenRow;
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
            ...(sourceTurnId ? { sourceTurnId } : {}),
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
      putTokenEvent(entries, {
        ...tokenEvent(timestamp, key, l.input, l.output, l.cached, l.reasoning),
        ...(sourceTurnId ? { sourceTurnId } : {}),
      });
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

function firstNonZeroNumber(...values: number[]): number {
  return values.find((value) => value > 0) ?? 0;
}

function optionalNumberField(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function firstPresentNumber(...values: Array<number | null>): number {
  return values.find((value): value is number => value !== null) ?? 0;
}

function maxNumberField(value: unknown, keys: string[]): number {
  if (!isRecord(value)) return 0;
  return Math.max(0, ...keys.map((key) => numberField(value, key)));
}

function maxDetailNumber(value: unknown, keys: string[]): number {
  const details = Array.isArray(value) ? value : [value];
  return Math.max(0, ...details.map((detail) => maxNumberField(detail, keys)));
}

// WorkBuddy repeats one usage snapshot across the records emitted for a model
// response. Its input total includes cache reads but excludes cache writes;
// split the read bucket out and keep cache creation as an additional bucket.
function readWorkBuddyUsage(row: Record<string, unknown>): TokenUsage | null {
  const providerData = objectField(row, "providerData");
  const usage = objectField(providerData, "usage");
  const rawUsage = objectField(providerData, "rawUsage");
  const messageUsage = objectField(objectField(row, "message"), "usage");
  const inputTotal = firstPresentNumber(
    optionalNumberField(usage, "inputTokens"),
    optionalNumberField(messageUsage, "input_tokens"),
    optionalNumberField(rawUsage, "prompt_tokens"),
  );
  const output = firstPresentNumber(
    optionalNumberField(usage, "outputTokens"),
    optionalNumberField(messageUsage, "output_tokens"),
    optionalNumberField(rawUsage, "completion_tokens"),
  );
  const cacheRead = firstNonZeroNumber(
    numberField(rawUsage, "prompt_cache_hit_tokens"),
    numberField(messageUsage, "cache_read_input_tokens"),
    numberField(rawUsage, "cache_read_input_tokens"),
    numberField(usage, "cacheReadInputTokens"),
    maxDetailNumber(unknownField(rawUsage, "prompt_tokens_details"), ["cached_tokens"]),
    maxDetailNumber(unknownField(usage, "inputTokensDetails"), ["cached_tokens"]),
  );
  const cacheCreation = Math.max(
    numberField(rawUsage, "cache_creation_input_tokens"),
    numberField(rawUsage, "prompt_cache_write_tokens"),
  );
  const reasoning = firstNonZeroNumber(
    numberField(rawUsage, "completion_thinking_tokens"),
    numberField(objectField(rawUsage, "completion_tokens_details"), "reasoning_tokens"),
  );
  if (inputTotal === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0 && reasoning === 0) return null;
  return createTokenUsage(
    Math.max(0, inputTotal - cacheRead),
    Math.max(0, output),
    cacheRead,
    reasoning,
    cacheCreation,
  );
}

function extractWorkBuddyTokenEvents(rows: unknown[]): TokenUsageEvent[] {
  const entries = new Map<string, TokenUsageEvent>();
  rows.forEach((row) => {
    if (!isRecord(row)) return;
    const providerData = objectField(row, "providerData");
    const usage = readWorkBuddyUsage(row);
    if (!usage) return;

    const key = stringField(providerData, "messageId")
      || stringField(row, "id")
      || stringField(row, "callId");
    if (!key) return;
    putTokenEvent(entries, {
      ...usage,
      timestamp: parseTimestampMs(row.timestamp),
      dedupeKey: key.startsWith("workbuddy:") ? key : `workbuddy:${key}`,
    });
  });
  return [...entries.values()];
}

function firstClaudeGitBranch(rows: unknown[]): string | null {
  for (const row of rows) {
    if (!row || typeof row !== "object" || !("gitBranch" in row)) continue;
    const branch = (row as ClaudeConversationLine).gitBranch?.trim();
    if (branch) return branch;
  }
  return null;
}

// CodeBuddy session rows do not currently embed gitBranch. Resolve the active
// branch from the session cwd's .git metadata so branch tags still appear.
function readGitBranchFromCwd(cwd: string): string | null {
  if (!cwd.trim()) return null;

  let current = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    const branch = readGitBranchAt(path.join(current, ".git"));
    if (branch) return branch;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function readGitBranchAt(gitPath: string): string | null {
  try {
    if (!fs.existsSync(gitPath)) return null;

    let gitDir = gitPath;
    const gitStat = fs.statSync(gitPath);
    if (gitStat.isFile()) {
      const content = fs.readFileSync(gitPath, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/iu.exec(content);
      if (!match?.[1]) return null;
      const gitDirRef = match[1].trim();
      gitDir = path.isAbsolute(gitDirRef) ? gitDirRef : path.resolve(path.dirname(gitPath), gitDirRef);
    } else if (!gitStat.isDirectory()) {
      return null;
    }

    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const refMatch = /^ref:\s*refs\/heads\/(.+)$/u.exec(head);
    if (refMatch?.[1]) return refMatch[1].trim() || null;
    if (/^[0-9a-f]{40,64}$/iu.test(head)) return "HEAD";
    return null;
  } catch {
    return null;
  }
}

function createIndexedSession(input: {
  keyPrefix: "claude" | "codex" | "tclaude" | "tcodex" | "codebuddy" | "workbuddy" | "codewiz" | "openclaw" | "hermes" | "opencode" | "zcode" | "cursor" | "trae" | "qoder" | "pi" | "deepseek" | "kimi";
  rawId: string;
  source: SessionSource;
  projectPath: string;
  filePath: string;
  originalTitle: string;
  firstQuestion: string;
  timestamp: number;
  prUrl?: string | null;
  prNumber?: number | null;
  gitBranch?: string | null;
  tokenUsage?: TokenUsage;
  stat?: VirtualSessionFileStat;
  isSubagent?: boolean;
  parentSessionId?: string | null;
}): IndexedSession {
  const stat = input.stat ?? safeStat(input.filePath);
  return {
    sessionKey: `${input.keyPrefix}:${input.rawId}`,
    rawId: input.rawId,
    source: input.source,
    projectPath: input.projectPath,
    filePath: input.filePath,
    originalTitle: input.originalTitle || input.firstQuestion || "Untitled Session",
    firstQuestion: input.firstQuestion,
    timestamp: input.timestamp || stat.mtimeMs,
    fileMtimeMs: stat.mtimeMs,
    fileSize: stat.size,
    prUrl: input.prUrl ?? null,
    prNumber: input.prNumber ?? null,
    gitBranch: input.gitBranch ?? null,
    tokenUsage: input.tokenUsage ?? emptyTokenUsage(),
    isSubagent: input.isSubagent ?? false,
    parentSessionId: input.parentSessionId ?? null,
  };
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

// Claude, CodeBuddy, and WorkBuddy write their AI-generated session title as a dedicated
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
  options: {
    title?: string;
    updatedAt?: string;
    sourceOverride?: SessionSource;
    stat?: VirtualSessionFileStat;
    sessionMeta?: NonNullable<ReturnType<typeof parseCodexSessionMetaLine>>;
    includeTraceEvents?: boolean;
  } = {},
): LoadedSession | null {
  if (rows.length === 0) return null;

  const meta = options.sessionMeta ?? findCodexSessionMeta(rows);
  if (!meta) return null;

  const visibleRows = codexVisibleConversationRows(rows);
  const extracted = extractCodexMessages(visibleRows);
  const tokenEvents = extractCodexTokenEvents(collectCodexTokenRows(rows));
  const traceEvents = options.includeTraceEvents === false ? [] : extractTraceEvents(visibleRows, "codex");
  return createLoadedCodexSession(filePath, meta, extracted.messages, tokenEvents, traceEvents, options, {
    historyMode: meta.historyMode ?? extracted.historyMode,
    messageProvenance: extracted.messageProvenance,
    activeTurnIds: extracted.activeTurnIds,
    ...(extracted.agentPath === undefined || extracted.agentPath === "/root" ? {} : { agentPath: extracted.agentPath }),
    ...(extracted.pendingInterAgentCommunication
      ? { pendingInterAgentCommunication: extracted.pendingInterAgentCommunication }
      : {}),
  });
}

export function loadCodexSessionFile(filePath: string, title?: string, updatedAt?: string): LoadedSession | null {
  const scanned = scanCodexSessionFile(filePath);
  if (!scanned) return null;
  return createLoadedCodexSession(filePath, scanned.meta, scanned.messages, scanned.tokenEvents, scanned.traceEvents, {
    title,
    updatedAt,
    stat: { ...safeStat(filePath), size: scanned.committedOffset },
  }, scanned.codexIncrementalState);
}

function walkJsonlFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonlFiles(fullPath));
    else if (entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
  return files;
}

function parseValidPiTimestampMs(value: unknown): number | null {
  const timestamp = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string"
      ? new Date(value).getTime()
      : Number.NaN;
  return Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime())
    ? timestamp
    : null;
}

function piActiveRows(rows: unknown[]): unknown[] | null {
  const header = rows[0];
  if (!isRecord(header) || header.type !== "session" || !stringField(header, "id").trim()) return null;
  const rawVersion = unknownField(header, "version");
  const version = rawVersion === undefined || rawVersion === null ? 1 : rawVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 3) return null;
  if (version < 2) return rows.slice(1);

  const nodes = new Map<string, Record<string, unknown>>();
  let current: Record<string, unknown> | null = null;
  for (const row of rows.slice(1)) {
    if (!isRecord(row)) continue;
    const id = stringField(row, "id");
    if (!id) continue;
    if (nodes.has(id)) return null;
    nodes.set(id, row);
    current = row;
  }
  if (!current) return null;

  const activeRows: unknown[] = [];
  const visited = new Set<string>();
  while (current) {
    const id = stringField(current, "id");
    if (!id || visited.has(id)) return null;
    visited.add(id);
    activeRows.push(current);

    const parentId = unknownField(current, "parentId");
    if (parentId === null) break;
    if (typeof parentId !== "string" || !parentId) return null;
    const parent = nodes.get(parentId);
    if (!parent) return null;
    current = parent;
  }

  return activeRows.reverse();
}

function piTokenEvents(rows: unknown[]): TokenUsageEvent[] {
  const events: TokenUsageEvent[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row) || row.type !== "message") return;
    const message = objectField(row, "message");
    if (stringField(message, "role") !== "assistant") return;
    const usage = objectField(message, "usage");
    if (!usage) return;
    const innerTimestamp = parseValidPiTimestampMs(unknownField(message, "timestamp"));

    const tokenUsage = createTokenUsage(
      numberField(usage, "input"),
      Math.max(0, numberField(usage, "output") - numberField(usage, "reasoning")),
      numberField(usage, "cacheRead") + numberField(usage, "cacheWrite"),
      numberField(usage, "reasoning"),
    );
    events.push({
      ...tokenUsage,
      timestamp: innerTimestamp ?? parseValidPiTimestampMs(row.timestamp) ?? 0,
      dedupeKey: `pi:${stringField(row, "id") || index}`,
    });
  });
  return events;
}

function piTraceEvents(rows: unknown[]): SessionTraceEvent[] {
  const events: TraceEventDraft[] = [];

  for (const row of rows) {
    if (!isRecord(row) || row.type !== "message") continue;
    const message = objectField(row, "message");
    const role = stringField(message, "role");
    const innerTimestamp = parseValidPiTimestampMs(unknownField(message, "timestamp"));
    const timestamp = innerTimestamp !== null
      ? new Date(innerTimestamp).toISOString()
      : stringField(row, "timestamp");
    if (role === "assistant") {
      const content = unknownField(message, "content");
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const args = unknownField(block, "arguments");
        const name = stringField(block, "name") || "tool";
        events.push({
          kind: "tool_call",
          source: "pi",
          title: titleWithSummary(name, firstStringField(args, ["command", "cmd", "file_path", "path", "query", "url"])),
          detail: stringifyDetail(args),
          timestamp,
          callId: stringField(block, "id") || null,
          eventType: null,
          status: "unknown",
        });
      }
      continue;
    }

    if (role !== "toolResult") continue;
    const isError = unknownField(message, "isError");
    events.push({
      kind: "tool_result",
      source: "pi",
      title: titleWithSummary(stringField(message, "toolName") || "tool", "result"),
      detail: stringifyDetail(unknownField(message, "content")),
      timestamp,
      callId: stringField(message, "toolCallId") || null,
      eventType: null,
      status: typeof isError === "boolean" ? (isError ? "failed" : "completed") : "unknown",
    });
  }

  return events.map((event, index) => ({ ...event, index }));
}

function loadPiSessionFile(filePath: string, stat?: VirtualSessionFileStat): LoadedSession | null {
  const rows = readJsonl(filePath);
  const header = rows[0];
  if (!isRecord(header)) return null;
  const rawId = stringField(header, "id").trim();
  const projectPath = stringField(header, "cwd").trim();
  const timestamp = parseValidPiTimestampMs(header.timestamp);
  if (!rawId || !projectPath || timestamp === null) return null;
  const activeRows = piActiveRows(rows);
  if (!activeRows) return null;

  const messages = extractMessages(activeRows, "pi");
  if (messages.length === 0) return null;
  let question = "";
  for (const row of activeRows) {
    if (!isRecord(row) || row.type !== "message") continue;
    const message = objectField(row, "message");
    if (stringField(message, "role") !== "user") continue;
    const content = unknownField(message, "content");
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .filter((block) => isRecord(block) && block.type === "text")
          .map((block) => stringField(block, "text"))
          .filter(Boolean)
          .join("\n")
        : "";
    if (!isMeaningfulUserMessage(text)) continue;
    question = cleanTitle(text);
    break;
  }
  let latestName = "";
  for (const row of rows) {
    if (isRecord(row) && row.type === "session_info") latestName = stringField(row, "name").trim();
  }
  const tokenEvents = piTokenEvents(rows);
  const traceEvents = piTraceEvents(activeRows);
  const session = createIndexedSession({
    keyPrefix: "pi",
    rawId,
    source: "pi-cli",
    projectPath,
    filePath,
    originalTitle: latestName || question,
    firstQuestion: question,
    timestamp,
    tokenUsage: tokenUsageFromEvents(tokenEvents),
    stat,
  });
  return { session, messages, tokenEvents, traceEvents };
}

function* loadPiSessionsIterator(
  piSessionsDir: string,
  options: SessionLoadOptions,
): Generator<LoadedSession> {
  for (const filePath of walkJsonlFiles(piSessionsDir)) {
    const stat = safeStat(filePath);
    if (shouldSkipFile(options, filePath, stat)) continue;
    const loaded = loadPiSessionFile(filePath, stat);
    if (loaded) yield loaded;
  }
}

function loadKimiProjectPaths(root: string): { dependencyMtimeMs?: number; paths: Map<string, string> } {
  const metadataPath = path.join(root, "kimi.json");
  const metadataStat = safeStat(metadataPath);
  const paths = new Map<string, string>();
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as unknown;
    if (!isRecord(metadata) || !Array.isArray(metadata.work_dirs)) return { dependencyMtimeMs: metadataStat?.mtimeMs, paths };
    for (const item of metadata.work_dirs) {
      if (!isRecord(item)) continue;
      const projectPath = stringField(item, "path");
      if (!projectPath) continue;
      paths.set(createHash("md5").update(projectPath, "utf8").digest("hex"), projectPath);
    }
  } catch {
    // Missing or malformed metadata should not prevent session discovery.
  }
  return { dependencyMtimeMs: metadataStat?.mtimeMs, paths };
}

function legacyKimiSessionRawId(filePath: string, root: string): string {
  const relativeParts = path.relative(root, filePath).split(/[\\/]+/u);
  const sessionsIndex = relativeParts.indexOf("sessions");
  const sessionParts = sessionsIndex >= 0 ? relativeParts.slice(sessionsIndex + 1) : [];
  const fileName = path.basename(filePath).toLowerCase();
  if (/^(?:context|wire)\.jsonl$/u.test(fileName)) return sessionParts.slice(0, -1).filter(Boolean).join("/");
  return [...sessionParts.slice(0, -1), path.basename(filePath, ".jsonl")].filter(Boolean).join("/");
}

function legacyKimiSessionId(filePath: string): string {
  return /^(?:context|wire)\.jsonl$/iu.test(path.basename(filePath))
    ? path.basename(path.dirname(filePath))
    : path.basename(filePath, ".jsonl");
}

function legacyKimiStatePath(filePath: string): string | null {
  return /^(?:context|wire)\.jsonl$/iu.test(path.basename(filePath))
    ? path.join(path.dirname(filePath), "state.json")
    : null;
}

function loadLegacyKimiSessionFile(filePath: string, root: string, projectPaths: ReadonlyMap<string, string>, stat?: VirtualSessionFileStat): LoadedSession | null {
  const rows = readJsonl(filePath);
  if (rows.length === 0) return null;
  const messages = sourceMessages(rows, "kimi");
  if (messages.length === 0) return null;
  const meta = rows.find((row): row is Record<string, unknown> => isRecord(row) && (stringField(row, "type") === "session" || stringField(row, "type") === "session_info"));
  const relativeParts = path.relative(root, filePath).split(/[\\/]+/u);
  const sessionsIndex = relativeParts.indexOf("sessions");
  const sessionParts = sessionsIndex >= 0 ? relativeParts.slice(sessionsIndex + 1) : [];
  const rawId = legacyKimiSessionRawId(filePath, root) || stringField(meta, "id") || path.basename(path.dirname(filePath)) || path.basename(filePath, ".jsonl");
  const workDirKey = sessionParts[0] ?? "";
  const mappedProjectPath = [...projectPaths].find(([hash]) => workDirKey === hash || workDirKey.endsWith(`_${hash}`))?.[1] ?? "";
  const projectPath = stringField(meta, "cwd") || stringField(meta, "workDir") || stringField(meta, "work_dir") || mappedProjectPath;
  const question = cleanTitle(firstQuestion(messages));
  const statePath = legacyKimiStatePath(filePath);
  const state = statePath ? readJsonObject(statePath) : null;
  const title = stringField(state, "custom_title") || question || rawId;
  return {
    session: createIndexedSession({ keyPrefix: "kimi", rawId, source: "kimi-cli", projectPath, filePath, originalTitle: title, firstQuestion: question, timestamp: stat?.mtimeMs ?? Date.now(), stat }),
    messages,
    traceEvents: traceEventsFromRows(rows, "kimi"),
  };
}

interface KimiCodeIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readKimiCodeSessionIndex(root: string): Map<string, KimiCodeIndexEntry> {
  const sessionsRoot = path.join(root, "sessions");
  const entries = new Map<string, KimiCodeIndexEntry>();
  for (const row of readJsonl(path.join(root, "session_index.jsonl"))) {
    if (!isRecord(row)) continue;
    const sessionId = stringField(row, "sessionId");
    if (!sessionId) continue;
    if (row.deleted === true) {
      entries.delete(sessionId);
      continue;
    }
    const sessionDir = stringField(row, "sessionDir");
    const workDir = stringField(row, "workDir");
    if (!path.isAbsolute(sessionDir) || path.basename(sessionDir) !== sessionId || !isPathInside(sessionsRoot, sessionDir)) continue;
    entries.set(sessionId, { sessionId, sessionDir: path.resolve(sessionDir), workDir });
  }
  return entries;
}

function kimiCodeContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => isRecord(part) && stringField(part, "type") === "text" ? stringField(part, "text") : "")
    .filter(Boolean)
    .join("\n");
}

function kimiCodeMessages(rows: unknown[]): SessionMessage[] {
  const drafts: Array<{ role: "user" | "assistant"; parts: string[]; timestamp: string }> = [];
  const openSteps = new Map<string, (typeof drafts)[number]>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const recordType = stringField(row, "type");
    if (recordType === "context.append_message") {
      const message = objectField(row, "message");
      const role = stringField(message, "role");
      if (role !== "user" && role !== "assistant") continue;
      const text = kimiCodeContentText(message?.content);
      if (!text || (role === "user" && !isMeaningfulUserMessage(text))) continue;
      drafts.push({ role, parts: [text], timestamp: timestampString(row.time) });
      continue;
    }
    if (recordType !== "context.append_loop_event") continue;
    const event = objectField(row, "event");
    const eventType = stringField(event, "type");
    if (eventType === "step.begin") {
      const stepId = stringField(event, "uuid");
      if (!stepId) continue;
      const draft = { role: "assistant" as const, parts: [], timestamp: timestampString(row.time) };
      drafts.push(draft);
      openSteps.set(stepId, draft);
      continue;
    }
    if (eventType === "content.part") {
      const draft = openSteps.get(stringField(event, "stepUuid"));
      const part = objectField(event, "part");
      if (draft && stringField(part, "type") === "text") {
        const text = stringField(part, "text");
        if (text) draft.parts.push(text);
      }
      continue;
    }
    if (eventType === "step.end") openSteps.delete(stringField(event, "uuid"));
  }
  return drafts
    .map((draft) => ({ ...draft, content: draft.parts.join("\n") }))
    .filter((draft) => Boolean(draft.content))
    .map((draft, index) => messageFromParts(draft.role, draft.content, draft.timestamp, index));
}

function kimiCodeMainWireIdentity(filePath: string, root: string): { sessionId: string; sessionDir: string } | null {
  const parts = path.relative(root, filePath).split(/[\\/]+/u);
  if (parts.length !== 6 || parts[0] !== "sessions" || parts[3] !== "agents" || parts[4] !== "main" || parts[5] !== "wire.jsonl") return null;
  return { sessionId: parts[2], sessionDir: path.dirname(path.dirname(path.dirname(filePath))) };
}

function kimiCodeTitle(state: Record<string, unknown>, question: string, rawId: string): string {
  const title = stringField(state, "title");
  if (typeof state.isCustomTitle === "boolean" && title) return title;
  return stringField(state, "customTitle") || title || stringField(state, "lastPrompt") || question || rawId;
}

function loadKimiCodeSessionFile(
  filePath: string,
  root: string,
  indexEntry: KimiCodeIndexEntry | undefined,
  state: Record<string, unknown>,
  stat: VirtualSessionFileStat,
): LoadedSession | null {
  const identity = kimiCodeMainWireIdentity(filePath, root);
  if (!identity) return null;
  const rows = readJsonl(filePath);
  const messages = kimiCodeMessages(rows);
  if (messages.length === 0) return null;
  const question = cleanTitle(firstQuestion(messages));
  const projectPath = stringField(state, "cwd") || stringField(state, "workDir") || indexEntry?.workDir || "";
  const timestamp = parseTimestampMs(state.updatedAt) || parseTimestampMs(state.createdAt) || stat.mtimeMs;
  return {
    session: createIndexedSession({
      keyPrefix: "kimi",
      rawId: identity.sessionId,
      source: "kimi-cli",
      projectPath,
      filePath,
      originalTitle: kimiCodeTitle(state, question, identity.sessionId),
      firstQuestion: question,
      timestamp,
      stat,
    }),
    messages,
  };
}

function* loadKimiSessionsIterator(legacyRoot: string, codeRoot: string, options: SessionLoadOptions): Generator<LoadedSession> {
  const seen = new Set<string>();
  const legacySessionIds = new Set<string>();
  const projectMetadata = loadKimiProjectPaths(legacyRoot);
  const filesBySessionDir = new Map<string, string[]>();
  for (const filePath of walkJsonlFiles(legacyRoot)) {
    const relativeParts = path.relative(legacyRoot, filePath).split(/[\\/]+/u);
    if (relativeParts.some((part) => part === "agents" || part === "subagents")) continue;
    const sessionsIndex = relativeParts.indexOf("sessions");
    const sessionParts = sessionsIndex >= 0 ? relativeParts.slice(sessionsIndex + 1) : [];
    const isDirectorySession = /^(?:context|wire)\.jsonl$/iu.test(path.basename(filePath));
    const isFlatSession = sessionParts.length === 2 && path.extname(filePath).toLowerCase() === ".jsonl";
    if (!isDirectorySession && !isFlatSession) continue;
    const sessionDir = isDirectorySession ? path.dirname(filePath) : filePath;
    const files = filesBySessionDir.get(sessionDir) ?? [];
    files.push(filePath);
    filesBySessionDir.set(sessionDir, files);
  }
  const representativeFiles = [...filesBySessionDir.values()]
    .map((files) => files.sort((left, right) => {
      const leftPriority = path.basename(left).toLowerCase() === "context.jsonl" ? 0 : 1;
      const rightPriority = path.basename(right).toLowerCase() === "context.jsonl" ? 0 : 1;
      return leftPriority - rightPriority || left.localeCompare(right);
    })[0])
    .sort((left, right) => left.localeCompare(right));
  for (const filePath of representativeFiles) {
    const rawId = legacyKimiSessionRawId(filePath, legacyRoot);
    const seenKey = rawId || filePath;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    legacySessionIds.add(legacyKimiSessionId(filePath));
    const stat = safeStat(filePath);
    const statePath = legacyKimiStatePath(filePath);
    const dependencyMtimeMs = Math.max(projectMetadata.dependencyMtimeMs ?? 0, statePath ? safeStat(statePath).mtimeMs : 0);
    if (shouldSkipFile(options, filePath, stat, dependencyMtimeMs)) continue;
    const loaded = loadLegacyKimiSessionFile(filePath, legacyRoot, projectMetadata.paths, stat);
    if (loaded) yield loaded;
  }

  const indexPath = path.join(codeRoot, "session_index.jsonl");
  const sessionIndex = readKimiCodeSessionIndex(codeRoot);
  const candidates = new Map<string, { sessionId: string; sessionDir: string; filePath: string }>();
  for (const entry of sessionIndex.values()) {
    const filePath = path.join(entry.sessionDir, "agents", "main", "wire.jsonl");
    if (fs.existsSync(filePath)) candidates.set(path.resolve(entry.sessionDir), { sessionId: entry.sessionId, sessionDir: entry.sessionDir, filePath });
  }
  for (const filePath of walkJsonlFiles(path.join(codeRoot, "sessions"))) {
    const identity = kimiCodeMainWireIdentity(filePath, codeRoot);
    if (identity) candidates.set(path.resolve(identity.sessionDir), { ...identity, filePath });
  }
  for (const candidate of [...candidates.values()].sort((left, right) => left.filePath.localeCompare(right.filePath))) {
    const statePath = path.join(candidate.sessionDir, "state.json");
    const state = readJsonObject(statePath) ?? {};
    const custom = objectField(state, "custom");
    const importedLegacyId = stringField(custom, "kimi_cli_session_id");
    if (importedLegacyId && legacySessionIds.has(importedLegacyId)) continue;
    const stat = safeStat(candidate.filePath);
    const dependencyMtimeMs = Math.max(safeStat(indexPath).mtimeMs, safeStat(statePath).mtimeMs);
    if (shouldSkipFile(options, candidate.filePath, stat, dependencyMtimeMs)) continue;
    const indexed = sessionIndex.get(candidate.sessionId);
    const indexEntry = indexed && path.resolve(indexed.sessionDir) === path.resolve(candidate.sessionDir) ? indexed : undefined;
    const loaded = loadKimiCodeSessionFile(candidate.filePath, codeRoot, indexEntry, state, stat);
    if (loaded) yield loaded;
  }
}

interface StreamedCodexTurn {
  messages: SessionMessage[];
  traceEvents: TraceEventDraft[];
  hasUserMessage: boolean;
  sourceTurnIds: Set<string>;
}

function createLoadedCodexSession(
  filePath: string,
  meta: NonNullable<ReturnType<typeof parseCodexSessionMetaLine>>,
  messages: SessionMessage[],
  tokenEvents: TokenUsageEvent[],
  traceEvents: SessionTraceEvent[],
  options: {
    title?: string;
    updatedAt?: string;
    sourceOverride?: SessionSource;
    stat?: VirtualSessionFileStat;
  },
  codexIncrementalState?: LoadedSession["codexIncrementalState"],
): LoadedSession {
  const tokenUsage = tokenUsageFromEvents(tokenEvents);
  const question = firstQuestion(messages);
  const source: SessionSource = options.sourceOverride || (CODEX_APP_ORIGINATORS.has(meta.originator || "") ? "codex-app" : "codex-cli");
  const session = createIndexedSession({
    keyPrefix: source === "tcodex-cli" ? "tcodex" : "codex",
    rawId: meta.id,
    source,
    projectPath: meta.projectPath,
    filePath,
    originalTitle: cleanTitle(options.title || meta.title || question) || "Untitled Session",
    firstQuestion: question ? cleanTitle(question) : "",
    timestamp: options.updatedAt ? new Date(options.updatedAt).getTime() : meta.ts,
    gitBranch: meta.gitBranch,
    tokenUsage,
    isSubagent: meta.isSubagent,
    parentSessionId: meta.parentSessionId,
    stat: options.stat,
  });
  return {
    session,
    messages,
    tokenEvents,
    traceEvents,
    codexIncrementalState: codexIncrementalState ?? {
      historyMode: meta.historyMode ?? "legacy",
      messageProvenance: messages.map((message) => ({ messageIndex: message.index, sourceRecordId: null })),
      activeTurnIds: [],
    },
  };
}

interface ScannedCodexSession {
  meta: NonNullable<ReturnType<typeof parseCodexSessionMetaLine>>;
  messages: SessionMessage[];
  tokenEvents: TokenUsageEvent[];
  traceEvents: SessionTraceEvent[];
  codexIncrementalState: NonNullable<LoadedSession["codexIncrementalState"]>;
  committedOffset: number;
}

function isCodexInlineImageOutput(line: Buffer): boolean {
  return (
    (
      line.indexOf(CODEX_FUNCTION_OUTPUT_MARKER) >= 0
      || line.indexOf(CODEX_CUSTOM_TOOL_OUTPUT_MARKER) >= 0
    )
    && line.indexOf(CODEX_INLINE_IMAGE_MARKER) >= 0
  );
}

function shouldParseCodexJsonlLine(line: Buffer): boolean {
  return !(line.length > 512 * 1024 && isCodexInlineImageOutput(line));
}

function createCodexScanAccumulator(base?: { offset: number; loaded: LoadedSession }): {
  onRecord(row: unknown): void;
  finish(committedOffset: number): ScannedCodexSession | null;
  hasInvalidRollback(): boolean;
} {
  const adapter = getAdapter("codex");
  const allMessages: SessionMessage[] = [...(base?.loaded.messages ?? [])];
  const allTraceEvents: TraceEventDraft[] = [...(base?.loaded.traceEvents ?? [])];
  const rollout = new CodexRolloutAccumulator(base ? {
    historyMode: base.loaded.codexIncrementalState?.historyMode ?? "legacy",
    activeTurnIds: base.loaded.codexIncrementalState?.activeTurnIds ?? [],
    agentPath: base.loaded.codexIncrementalState?.agentPath
      ?? (base.loaded.session.isSubagent ? null : "/root"),
    pendingInterAgentCommunication: base.loaded.codexIncrementalState?.pendingInterAgentCommunication,
    sourceTurnIds: [
      ...allMessages.map((message) => message.sourceTurnId),
      ...allTraceEvents.map((event) => event.sourceTurnId),
      ...(base.loaded.tokenEvents ?? []).map((event) => event.sourceTurnId),
    ],
  } : undefined);
  const messageProvenance = new Map<SessionMessage, string | null>();
  const provenanceMessages = new Map<string, SessionMessage>();
  const sourceRecordIdByMessageIndex = new Map(
    base?.loaded.codexIncrementalState?.messageProvenance.map((entry) => [entry.messageIndex, entry.sourceRecordId]) ?? [],
  );
  for (const message of allMessages) {
    const sourceRecordId = sourceRecordIdByMessageIndex.get(message.index) ?? null;
    messageProvenance.set(message, sourceRecordId);
    if (sourceRecordId) provenanceMessages.set(sourceRecordId, message);
  }
  const preamble: StreamedCodexTurn = {
    messages: [...allMessages],
    traceEvents: [...allTraceEvents],
    hasUserMessage: false,
    sourceTurnIds: new Set(),
  };
  const turns: StreamedCodexTurn[] = [];
  const tokenRows: CodexTokenRow[] = [];
  let currentTurn: StreamedCodexTurn | null = null;
  let meta: NonNullable<ReturnType<typeof parseCodexSessionMetaLine>> | null = base ? {
    id: base.loaded.session.rawId,
    projectPath: base.loaded.session.projectPath,
    ts: base.loaded.session.timestamp,
    title: base.loaded.session.originalTitle,
    gitBranch: base.loaded.session.gitBranch ?? undefined,
    originator: base.loaded.session.source === "codex-app" ? "Codex Desktop" : undefined,
    isSubagent: base.loaded.session.isSubagent ?? false,
    parentSessionId: base.loaded.session.parentSessionId ?? null,
    agentPath: base.loaded.codexIncrementalState?.agentPath
      ?? (base.loaded.session.isSubagent ? null : "/root"),
    historyMode: base.loaded.codexIncrementalState?.historyMode ?? "legacy",
  } : null;
  let invalidRollback = false;

  return {
    onRecord: (row) => {
      const parsedMeta = parseCodexSessionMetaLine(row);
      if (parsedMeta) {
        meta = meta ? {
          ...meta,
          projectPath: usableCodexProjectPath(meta.projectPath) ? meta.projectPath : parsedMeta.projectPath || meta.projectPath,
          ts: meta.ts || parsedMeta.ts,
          title: meta.title || parsedMeta.title,
          gitBranch: meta.gitBranch || parsedMeta.gitBranch,
          originator: meta.originator || parsedMeta.originator,
          isSubagent: meta.isSubagent || parsedMeta.isSubagent,
          parentSessionId: meta.parentSessionId || parsedMeta.parentSessionId,
          agentPath: meta.agentPath || parsedMeta.agentPath,
          historyMode: meta.historyMode === "paginated" || parsedMeta.historyMode === "paginated" ? "paginated" : "legacy",
        } : parsedMeta;
      }
      const turnContextProjectPath = codexTurnContextProjectPath(row);
      if (meta && !usableCodexProjectPath(meta.projectPath) && turnContextProjectPath) {
        meta = { ...meta, projectPath: turnContextProjectPath };
      }

      if (isRecord(row)) {
        const payload = objectField(row, "payload");
        if (row.type === "event_msg" && payload?.type === "thread_rolled_back") {
          const numTurns = payload.num_turns;
          if (!Number.isSafeInteger(numTurns) || (numTurns as number) <= 0 || (numTurns as number) > turns.length) {
            invalidRollback = true;
          } else {
            const removedTurns = turns.splice(turns.length - (numTurns as number), numTurns as number);
            rollout.discardActiveTurnIds(removedTurns.flatMap((turn) => [...turn.sourceTurnIds]));
            currentTurn = turns.at(-1) ?? null;
          }
          return;
        }
      }

      const rolloutRecord = rollout.consume(row);
      if (
        isRecord(row)
        && (
          row.type === "turn_context"
          || (row.type === "event_msg" && stringField(objectField(row, "payload"), "type") === "token_count")
        )
      ) {
        tokenRows.push({ row, sourceTurnId: rolloutRecord.sourceTurnId });
      }
      const parsedMessage = adapter.parseLine(row);
      let message = parsedMessage
        && !(rollout.historyMode === "paginated" && parsedMessage.role === "user")
        && (parsedMessage.role !== "user" || isMeaningfulUserMessage(parsedMessage.content))
        ? {
            ...parsedMessage,
            index: 0,
            sourceTurnId: rolloutRecord.message?.sourceTurnId ?? null,
            phase: parsedMessage.role === "assistant" ? rolloutRecord.message?.phase ?? null : null,
          }
        : null;
      if (rolloutRecord.completedMessage) {
        const completed = rolloutRecord.completedMessage;
        const content = completed.role === "user"
          ? stripCodexInjectedNoise(completed.content)
          : completed.content;
        const existing = provenanceMessages.get(completed.replacesSourceRecordId);
        if (completed.role === "user" && !isMeaningfulUserMessage(content)) {
          if (existing) {
            const messageIndex = allMessages.indexOf(existing);
            if (messageIndex >= 0) allMessages.splice(messageIndex, 1);
            messageProvenance.delete(existing);
            provenanceMessages.delete(completed.replacesSourceRecordId);
          }
          message = null;
        } else if (existing) {
          Object.assign(existing, {
            role: completed.role,
            content,
            timestamp: completed.timestamp,
            sourceTurnId: completed.sourceTurnId,
            phase: completed.phase,
          });
          messageProvenance.set(existing, completed.sourceRecordId);
          provenanceMessages.delete(completed.replacesSourceRecordId);
          provenanceMessages.set(completed.sourceRecordId, existing);
          message = null;
        } else {
          message = {
            role: completed.role,
            content,
            timestamp: completed.timestamp,
            index: 0,
            sourceTurnId: completed.sourceTurnId,
            phase: completed.phase,
          };
        }
      }
      const traces = isRecord(row)
        ? [
            ...extractCodexResponseTrace(row, rolloutRecord.sourceTurnId),
            ...extractCodexEventTrace(row, rolloutRecord.sourceTurnId),
            ...rolloutRecord.traceEvents,
          ]
        : [];
      if (message) {
        allMessages.push(message);
        messageProvenance.set(
          message,
          rolloutRecord.completedMessage?.sourceRecordId
            ?? rolloutRecord.message?.sourceRecordId
            ?? null,
        );
        const sourceRecordId = messageProvenance.get(message);
        if (sourceRecordId) provenanceMessages.set(sourceRecordId, message);
      }
      allTraceEvents.push(...traces);

      const payload = isRecord(row) ? objectField(row, "payload") : null;
      const startsTurn = isRecord(row) && row.type === "event_msg" && payload?.type === "task_started";
      let target: StreamedCodexTurn;
      if (startsTurn) {
        currentTurn = {
          messages: [],
          traceEvents: [],
          hasUserMessage: false,
          sourceTurnIds: new Set(),
        };
        turns.push(currentTurn);
        target = currentTurn;
      } else if (message?.role === "user") {
        if (!currentTurn || currentTurn.hasUserMessage) {
          currentTurn = {
            messages: [],
            traceEvents: [],
            hasUserMessage: false,
            sourceTurnIds: new Set(),
          };
          turns.push(currentTurn);
        }
        currentTurn.hasUserMessage = true;
        target = currentTurn;
      } else {
        target = currentTurn ?? preamble;
      }
      if (message) target.messages.push(message);
      target.traceEvents.push(...traces);
      if (rolloutRecord.sourceTurnId) target.sourceTurnIds.add(rolloutRecord.sourceTurnId);
    },
    finish: (committedOffset) => {
      if (!meta) return null;

      const visibleMessages = invalidRollback
        ? allMessages
        : [...preamble.messages, ...turns.flatMap((turn) => turn.messages)];
      const visibleTraces = invalidRollback
        ? allTraceEvents
        : [...preamble.traceEvents, ...turns.flatMap((turn) => turn.traceEvents)];
      const pendingInterAgentCommunication = rollout.getPendingInterAgentCommunication();
      const tokenEvents = new Map<string, TokenUsageEvent>();
      for (const event of base?.loaded.tokenEvents ?? []) putTokenEvent(tokenEvents, event);
      const newTokenRows = base
        ? tokenRows.map((tokenRow) => ({ ...tokenRow, row: stripCodexCumulativeUsage(tokenRow.row) }))
        : tokenRows;
      for (const event of extractCodexTokenEvents(newTokenRows)) {
        putTokenEvent(tokenEvents, event);
      }
      return {
        meta,
        messages: visibleMessages.map((message, index) => ({ ...message, index })),
        tokenEvents: [...tokenEvents.values()],
        traceEvents: dedupeCodexTraceEvents(visibleTraces),
        codexIncrementalState: {
          historyMode: rollout.historyMode,
          messageProvenance: visibleMessages.map((message, messageIndex) => ({
            messageIndex,
            sourceRecordId: messageProvenance.get(message) ?? null,
          })),
          activeTurnIds: rollout.getActiveTurnIds(),
          ...(rollout.agentPath === undefined || rollout.agentPath === "/root" ? {} : { agentPath: rollout.agentPath }),
          ...(pendingInterAgentCommunication
            ? { pendingInterAgentCommunication }
            : {}),
        },
        committedOffset,
      };
    },
    hasInvalidRollback: () => invalidRollback,
  };
}

function scanCodexSessionFile(filePath: string, base?: { offset: number; loaded: LoadedSession }): ScannedCodexSession | null {
  if (base && safeStat(filePath).size < base.offset) return scanCodexSessionFile(filePath);
  const accumulator = createCodexScanAccumulator(base);
  try {
    const result = scanCompleteJsonl(filePath, {
      startOffset: base?.offset,
      shouldSkipLinePrefix: isCodexInlineImageOutput,
      shouldParseLine: shouldParseCodexJsonlLine,
      onRecord: accumulator.onRecord,
    });
    if (base && accumulator.hasInvalidRollback()) return scanCodexSessionFile(filePath);
    return accumulator.finish(result.committedOffset);
  } catch {
    return null;
  }
}

async function scanCodexSessionFileAsync(filePath: string, base?: { offset: number; loaded: LoadedSession }): Promise<ScannedCodexSession | null> {
  if (base && safeStat(filePath).size < base.offset) return scanCodexSessionFileAsync(filePath);
  const accumulator = createCodexScanAccumulator(base);
  try {
    const result = await scanCompleteJsonlAsync(filePath, {
      startOffset: base?.offset,
      shouldSkipLinePrefix: isCodexInlineImageOutput,
      shouldParseLine: shouldParseCodexJsonlLine,
      onRecord: accumulator.onRecord,
    });
    if (base && accumulator.hasInvalidRollback()) return scanCodexSessionFileAsync(filePath);
    return accumulator.finish(result.committedOffset);
  } catch {
    return null;
  }
}

function stripCodexCumulativeUsage(row: unknown): unknown {
  if (!isRecord(row)) return row;
  const payload = objectField(row, "payload");
  const info = objectField(payload, "info");
  if (!payload || !info || !("total_token_usage" in info)) return row;
  const { total_token_usage: _total, ...nextInfo } = info;
  return { ...row, payload: { ...payload, info: nextInfo } };
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
    const incrementalBase = options.loadIncrementalCodexSession?.(filePath)
      ?? options.incrementalCodexSessions?.get(filePath);
    const scanned = scanCodexSessionFile(
      filePath,
      incrementalBase && stat.size > incrementalBase.offset ? incrementalBase : undefined,
    );
    if (!scanned) continue;
    const indexedTitle = titleMap.get(scanned.meta.id);
    const loaded = createLoadedCodexSession(filePath, scanned.meta, scanned.messages, scanned.tokenEvents, scanned.traceEvents, {
      title: indexedTitle?.title,
      updatedAt: indexedTitle?.updatedAt,
      sourceOverride,
      stat: { ...stat, size: scanned.committedOffset },
    }, scanned.codexIncrementalState);
    yield loaded;
  }
}

export async function* loadCodexSessionsAsyncIterator(
  codexDir = path.join(os.homedir(), ".codex"),
  sourceOverride?: SessionSource,
  options: SessionLoadOptions = {},
): AsyncGenerator<LoadedSession> {
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
    const incrementalBase = await options.loadIncrementalCodexSession?.(filePath)
      ?? options.incrementalCodexSessions?.get(filePath);
    const scanned = await scanCodexSessionFileAsync(
      filePath,
      incrementalBase && stat.size > incrementalBase.offset ? incrementalBase : undefined,
    );
    if (!scanned) continue;
    const indexedTitle = titleMap.get(scanned.meta.id);
    yield createLoadedCodexSession(filePath, scanned.meta, scanned.messages, scanned.tokenEvents, scanned.traceEvents, {
      title: indexedTitle?.title,
      updatedAt: indexedTitle?.updatedAt,
      sourceOverride,
      stat: { ...stat, size: scanned.committedOffset },
    }, scanned.codexIncrementalState);
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
    includeTraceEvents?: boolean;
  } = {},
): LoadedSession | null {
  const rawId = options.rawId || path.basename(filePath, ".jsonl");
  const visibleRows = claudeVisibleConversationRows(rows);
  const messages = extractMessages(visibleRows, "claude");
  const tokenEvents = extractClaudeTokenEvents(rows);
  const traceEvents = options.includeTraceEvents === false ? [] : extractTraceEvents(visibleRows, "claude");
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
  return {
    session: createIndexedSession({
      keyPrefix: options.source === "tclaude-cli" ? "tclaude" : "claude",
      rawId,
      source: options.source ?? "claude-cli",
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
    const visibleRows = claudeVisibleConversationRows(rows);
    const messages = extractMessages(visibleRows, "claude");
    const tokenEvents = extractClaudeTokenEvents(rows);
    const traceEvents = extractTraceEvents(visibleRows, "claude");
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
  const gitBranch = firstClaudeGitBranch(rows) ?? readGitBranchFromCwd(meta.projectPath);

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
      gitBranch,
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

interface WorkBuddySessionIdentity {
  rawId: string;
  isSubagent: boolean;
  parentSessionId: string | null;
}

function workBuddySessionIdentity(projectsDir: string, filePath: string): WorkBuddySessionIdentity | null {
  const relativePath = path.relative(projectsDir, filePath);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return null;
  const segments = relativePath.split(path.sep);
  const stem = path.basename(filePath, ".jsonl");
  if (!stem || stem === "." || stem === ".." || path.extname(filePath) !== ".jsonl") return null;
  if (segments.length === 2) {
    return /^[A-Za-z0-9_-]+$/u.test(stem) ? { rawId: stem, isSubagent: false, parentSessionId: null } : null;
  }
  if (segments.length !== 4 || segments[2] !== "subagents") return null;

  const parentSessionId = segments[1];
  if (!/^[A-Za-z0-9_-]+$/u.test(parentSessionId)) return null;
  return {
    rawId: `${parentSessionId}:subagent:${stem}`,
    isSubagent: true,
    parentSessionId,
  };
}

function workBuddyProjectsDirForFile(filePath: string): string | null {
  let current = path.dirname(path.resolve(filePath));
  while (true) {
    if (path.basename(current) === "projects" && path.basename(path.dirname(current)) === WORKBUDDY_DIR) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function firstWorkBuddySessionMeta(rows: unknown[]): { projectPath: string; timestamp: number } {
  let projectPath = "";
  let timestamp = 0;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (!projectPath) projectPath = stringField(row, "cwd");
    const rowTimestamp = parseTimestampMs(row.timestamp);
    if (rowTimestamp && (!timestamp || rowTimestamp < timestamp)) timestamp = rowTimestamp;
  }
  return { projectPath, timestamp };
}

function loadWorkBuddyCliSessionRowsWithIdentity(
  filePath: string,
  rows: unknown[],
  stat: VirtualSessionFileStat,
  identity: WorkBuddySessionIdentity,
): LoadedSession | null {
  if (rows.length === 0) return null;

  const meta = firstWorkBuddySessionMeta(rows);
  const messages = extractMessages(rows, "workbuddy");
  const tokenEvents = extractWorkBuddyTokenEvents(rows);
  const traceEvents = extractTraceEvents(rows, "workbuddy");
  if (messages.length === 0 && traceEvents.length === 0) return null;

  const question = firstQuestion(messages);
  return {
    session: createIndexedSession({
      keyPrefix: "workbuddy",
      rawId: identity.rawId,
      source: "workbuddy-cli",
      projectPath: meta.projectPath,
      filePath,
      originalTitle: firstAiTitle(rows) || cleanTitle(question) || "Untitled Session",
      firstQuestion: cleanTitle(question),
      timestamp: meta.timestamp,
      tokenUsage: tokenUsageFromEvents(tokenEvents),
      stat,
      isSubagent: identity.isSubagent,
      parentSessionId: identity.parentSessionId,
    }),
    messages,
    tokenEvents,
    traceEvents,
  };
}

export function loadWorkBuddyCliSessionRows(
  filePath: string,
  rows: unknown[],
  stat: VirtualSessionFileStat,
): LoadedSession | null {
  const projectsDir = workBuddyProjectsDirForFile(filePath);
  if (!projectsDir) return null;
  const identity = workBuddySessionIdentity(projectsDir, filePath);
  return identity ? loadWorkBuddyCliSessionRowsWithIdentity(filePath, rows, stat, identity) : null;
}

export function loadWorkBuddyCliSessionFile(filePath: string, stat = safeStat(filePath)): LoadedSession | null {
  return loadWorkBuddyCliSessionRows(filePath, readJsonl(filePath), stat);
}

export function loadWorkBuddyCliSessions(workBuddyDir = path.join(os.homedir(), WORKBUDDY_DIR)): LoadedSession[] {
  return [...loadWorkBuddyCliSessionsIterator(workBuddyDir)];
}

export function* loadWorkBuddyCliSessionsIterator(
  workBuddyDir = path.join(os.homedir(), WORKBUDDY_DIR),
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  const projectsDir = path.join(workBuddyDir, "projects");
  if (!fs.existsSync(projectsDir)) return;

  for (const filePath of walkJsonlFiles(projectsDir)) {
    const identity = workBuddySessionIdentity(projectsDir, filePath);
    if (!identity) continue;
    const stat = safeStat(filePath);
    if (shouldSkipFile(options, filePath, stat)) continue;
    const loaded = loadWorkBuddyCliSessionRowsWithIdentity(filePath, readJsonl(filePath), stat, identity);
    if (loaded) yield loaded;
  }
}

function readOnlyDatabase(dbPath: string): import("node:sqlite").DatabaseSync | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

function sqliteTableExists(db: import("node:sqlite").DatabaseSync, tableName: string): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function sqliteColumns(db: import("node:sqlite").DatabaseSync, tableName: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name));
  } catch {
    return new Set();
  }
}

function sqliteHasColumns(db: import("node:sqlite").DatabaseSync, tableName: string, columns: string[]): boolean {
  const available = sqliteColumns(db, tableName);
  return columns.every((column) => available.has(column));
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function timestampString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value !== "string") return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageFromParts(role: "user" | "assistant", content: string, timestamp: string, index: number): SessionMessage {
  return { role, content, timestamp, index };
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  const direct = firstStringField(value, ["text", "content", "message", "summary", "input", "output"]);
  if (direct) return direct;
  const nested = unknownField(value, "content") ?? unknownField(value, "text");
  if (nested !== value) return extractText(nested);
  return "";
}

function roleFromValue(value: unknown): "user" | "assistant" | null {
  if (!isRecord(value)) return null;
  const message = objectField(value, "message");
  const role = unknownField(value, "role") ?? unknownField(value, "type") ?? unknownField(message, "role");
  return role === "user" || role === "assistant" ? role : null;
}

function sourceMessages(rows: unknown[], format: SessionFormat): SessionMessage[] {
  return extractMessages(rows, format);
}

function normalizeTraceTitle(name: string, summary: string): string {
  return titleWithSummary(name || "event", summary);
}

function traceEventsFromRows(rows: unknown[], format: SessionFormat): SessionTraceEvent[] {
  const events: TraceEventDraft[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const rowType = stringField(row, "type");
    if (!rowType || rowType === "session" || rowType === "message" || rowType === "user" || rowType === "assistant") continue;

    const data = unknownField(row, "data") ?? unknownField(row, "arguments") ?? unknownField(row, "input") ?? row;
    const parsedData = parseJsonText(data);
    const eventName = stringField(row, "customType") || stringField(row, "name") || stringField(row, "tool_name") || rowType;
    const summary =
      firstStringField(parsedData, ["command", "cmd", "path", "file_path", "query", "url"]) ||
      firstStringField(row, ["command", "cmd", "path", "file_path", "query", "url"]);
    const kind: SessionTraceKind = rowType === "tool_call" || eventName.includes("tool_call") ? "tool_call" : rowType === "tool_result" ? "tool_result" : "event";
    events.push({
      kind,
      source: format,
      title: normalizeTraceTitle(eventName, summary),
      detail: stringifyDetail(parsedData),
      timestamp: timestampString(unknownField(row, "timestamp") ?? unknownField(row, "time")),
      callId: stringField(row, "call_id") || stringField(row, "id") || null,
      eventType: rowType,
      status: "unknown",
    });
  }
  return dedupeTraceEvents(events);
}

function loadOpenClawSessionFile(filePath: string, stat = safeStat(filePath)): LoadedSession | null {
  const rows = readJsonl(filePath);
  if (rows.length === 0) return null;

  const fallbackRawId = path.basename(filePath, ".jsonl");
  const meta = rows.find((row): row is Record<string, unknown> => isRecord(row) && stringField(row, "type") === "session");
  const rawId = stringField(meta, "id") || fallbackRawId;
  const projectPath = stringField(meta, "cwd") || rows.map((row) => (isRecord(row) ? stringField(row, "cwd") : "")).find(Boolean) || "";
  const messages = sourceMessages(rows, "openclaw");
  const traceEvents = traceEventsFromRows(rows, "openclaw");
  const question = firstQuestion(messages);

  return {
    session: createIndexedSession({
      keyPrefix: "openclaw",
      rawId,
      source: "openclaw",
      projectPath,
      filePath,
      originalTitle: cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: timestampMs(meta && unknownField(meta, "timestamp")) || stat.mtimeMs,
      stat,
    }),
    messages,
    traceEvents,
  };
}

export function loadOpenClawSessions(openClawDir = path.join(os.homedir(), ".openclaw")): LoadedSession[] {
  return [...loadOpenClawSessionsIterator(openClawDir)];
}

export function* loadOpenClawSessionsIterator(
  openClawDir = path.join(os.homedir(), ".openclaw"),
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  const agentsDir = path.join(openClawDir, "agents");
  if (!fs.existsSync(agentsDir)) return;
  for (const filePath of walkJsonlFiles(agentsDir)) {
    if (filePath.endsWith(".trajectory.jsonl")) continue;
    if (!filePath.includes(`${path.sep}sessions${path.sep}`)) continue;
    const stat = safeStat(filePath);
    if (shouldSkipFile(options, filePath, stat)) continue;
    const loaded = loadOpenClawSessionFile(filePath, stat);
    if (loaded) yield loaded;
  }
}

function decodeTraeProjectDir(value: string): string {
  if (!value) return "";
  if (!value.startsWith("-")) return value;

  const decoded = value.replace(/-/g, "/");
  if (fs.existsSync(decoded)) return decoded;

  // Trae's legacy directory encoding is lossy: "/" and "_" both become "-".
  // Prefer a candidate that exists on disk when the session has no raw cwd.
  const slashIndexes: number[] = [];
  for (let index = 1; index < decoded.length; index += 1) {
    if (decoded[index] === "/") slashIndexes.push(index);
  }

  const maxCandidates = 4096;
  let attempts = 0;
  const chars = decoded.split("");
  const findExistingCandidate = (index: number): string | null => {
    if (attempts >= maxCandidates) return null;
    if (index >= slashIndexes.length) {
      attempts += 1;
      const candidate = chars.join("");
      return fs.existsSync(candidate) ? candidate : null;
    }

    const slashIndex = slashIndexes[index];
    const slashCandidate = findExistingCandidate(index + 1);
    if (slashCandidate) return slashCandidate;

    chars[slashIndex] = "_";
    const underscoreCandidate = findExistingCandidate(index + 1);
    chars[slashIndex] = "/";
    return underscoreCandidate;
  };

  const existingCandidate = findExistingCandidate(0);
  if (existingCandidate) {
    return existingCandidate;
  }

  return decoded;
}

function traeAssistantSummary(row: Record<string, unknown>): string {
  const parts = [
    stringField(row, "outcome"),
    Array.isArray(row.actions) && row.actions.length > 0 ? `Actions:\n${row.actions.map((item) => `- ${String(item)}`).join("\n")}` : "",
    Array.isArray(row.learned) && row.learned.length > 0 ? `Learned:\n${row.learned.map((item) => `- ${String(item)}`).join("\n")}` : "",
  ];
  return joinNonEmpty(parts);
}

function loadTraeMemoryFile(filePath: string, traeDir: string, stat = safeStat(filePath)): LoadedSession | null {
  const rows = readJsonl(filePath).filter(isRecord);
  if (rows.length === 0) return null;
  const rawId = path.basename(filePath, ".jsonl");
  const projectMarker = `${path.sep}memory${path.sep}projects${path.sep}`;
  const projectSegment = filePath.includes(projectMarker) ? filePath.split(projectMarker)[1]?.split(path.sep)[0] || "" : "";
  const projectPath = firstStringField(rows[0], ["projectPath", "project_path", "cwd"]) || decodeTraeProjectDir(projectSegment);
  const messages: SessionMessage[] = [];
  for (const row of rows) {
    const ts = timestampString(stringField(row, "message_summary_time") || stringField(row, "timestamp"));
    const intent = stringField(row, "intent");
    if (intent && isMeaningfulUserMessage(intent)) messages.push(messageFromParts("user", intent, ts, messages.length));
    const assistant = traeAssistantSummary(row);
    if (assistant) messages.push(messageFromParts("assistant", assistant, ts, messages.length));
  }
  const question = firstQuestion(messages);
  return {
    session: createIndexedSession({
      keyPrefix: "trae",
      rawId,
      source: "trae",
      projectPath,
      filePath,
      originalTitle: cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: timestampMs(stringField(rows[0], "message_summary_time") || stringField(rows[0], "timestamp")) || stat.mtimeMs,
      stat,
    }),
    messages,
  };
}

export function loadTraeSessions(traeDir = path.join(os.homedir(), ".trae")): LoadedSession[] {
  return [...loadTraeSessionsIterator(traeDir)];
}

export function* loadTraeSessionsIterator(traeDir = path.join(os.homedir(), ".trae"), options: SessionLoadOptions = {}): Generator<LoadedSession> {
  const memoryDir = path.join(traeDir, "memory", "projects");
  if (!fs.existsSync(memoryDir)) return;
  for (const filePath of walkJsonlFiles(memoryDir)) {
    if (!path.basename(filePath).startsWith("session_memory_")) continue;
    const stat = safeStat(filePath);
    if (shouldSkipFile(options, filePath, stat)) continue;
    const loaded = loadTraeMemoryFile(filePath, traeDir, stat);
    if (loaded) yield loaded;
  }
}

export function loadQoderSessions(qoderDir = path.join(os.homedir(), QODER_DIR)): LoadedSession[] {
  return [...loadQoderSessionsIterator(qoderDir)];
}

export function* loadQoderSessionsIterator(qoderDir = path.join(os.homedir(), QODER_DIR), options: SessionLoadOptions = {}): Generator<LoadedSession> {
  const projectsDir = path.join(qoderDir, "cache", "projects");
  if (!fs.existsSync(projectsDir)) return;
  for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const slug = projectEntry.name;
    const conversationDir = path.join(projectsDir, slug, "conversation-history");
    if (!fs.existsSync(conversationDir)) continue;
    for (const filePath of walkJsonlFiles(conversationDir)) {
      const stat = safeStat(filePath);
      if (shouldSkipFile(options, filePath, stat)) continue;
      const loaded = loadQoderConversationFile(filePath, slug, stat);
      if (loaded) yield loaded;
    }
  }
}

function stripQoderSlugHash(slug: string): string {
  return slug.replace(/-[0-9a-f]{8}$/, "") || slug;
}

function qoderContentFromRow(row: Record<string, unknown>): string {
  const message = row.message;
  if (!isRecord(message)) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  const raw = content
    .filter((item): item is Record<string, unknown> => isRecord(item) && stringField(item, "type") === "text")
    .map((item) => stringField(item, "text"))
    .filter(Boolean)
    .join("\n");
  return stripQoderWrapperTags(raw);
}

/**
 * Strips Qoder-specific wrapper tags so that downstream title generation
 * and search see the actual user query instead of XML envelopes.
 *
 * - `<system-reminder>…</system-reminder>` — metadata, removed entirely
 * - `<attached_files>…</attached_files>` — file list, removed entirely
 * - `<user_query>…</user_query>` — the actual user input, inner text kept
 */
function stripQoderWrapperTags(text: string): string {
  const withoutSystemReminder = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  const withoutAttachedFiles = withoutSystemReminder.replace(/<attached_files>[\s\S]*?<\/attached_files>/gi, "");
  const userQueryMatch = withoutAttachedFiles.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (userQueryMatch) return userQueryMatch[1].trim();
  return withoutAttachedFiles.trim();
}

function loadQoderConversationFile(filePath: string, slug: string, stat: VirtualSessionFileStat): LoadedSession | null {
  return loadQoderSessionRows(filePath, readJsonl(filePath), { stat, slug });
}

function extractQoderSlugFromPath(filePath: string): string {
  const match = filePath.match(/projects\/([^/]+)\/conversation-history\//);
  return match?.[1] ?? path.basename(filePath);
}

export function loadQoderSessionRows(filePath: string, rows: unknown[], options: { stat: VirtualSessionFileStat; slug?: string }): LoadedSession | null {
  const filteredRows = rows.filter(isRecord);
  if (filteredRows.length === 0) return null;
  const slug = options.slug ?? extractQoderSlugFromPath(filePath);
  const taskId = path.basename(filePath, ".jsonl");
  const rawId = `${slug}/${taskId}`;
  const projectPath = stripQoderSlugHash(slug);
  const messages: SessionMessage[] = [];
  for (const row of filteredRows) {
    const role = stringField(row, "role");
    if (role !== "user" && role !== "assistant") continue;
    const content = qoderContentFromRow(row);
    if (!content) continue;
    messages.push(messageFromParts(role, content, "", messages.length));
  }
  if (messages.length === 0) return null;
  const question = firstQuestion(messages);
  return {
    session: createIndexedSession({
      keyPrefix: "qoder",
      rawId,
      source: "qoder",
      projectPath,
      filePath,
      originalTitle: cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: options.stat.mtimeMs,
      stat: options.stat,
    }),
    messages,
  };
}

function extractProjectPathFromJson(value: unknown): string {
  const parsed = parseJsonText(value);
  if (!isRecord(parsed)) return "";
  return firstStringField(parsed, ["cwd", "directory", "projectPath", "project_path", "workdir", "workspacePath", "workspace_path"]);
}

function createSourceTokenUsage(inputTokens: number, outputTokens: number, cachedInputTokens: number, reasoningOutputTokens: number): TokenUsage {
  return createTokenUsage(
    Math.max(0, inputTokens),
    Math.max(0, outputTokens),
    Math.max(0, cachedInputTokens),
    Math.max(0, reasoningOutputTokens),
  );
}

export function loadDeepSeekCliSessionFile(filePath: string, stat: VirtualSessionFileStat): LoadedSession | null {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  const log = parseDeepSeekSessionLog(buffer, filePath);
  if (!log) return null;
  const view = projectDeepSeekSession(log);
  if (view.messages.length === 0) return null;
  const question = firstQuestion(view.messages);
  const usage = createSourceTokenUsage(
    view.usage.inputTokens,
    view.usage.outputTokens,
    view.usage.cacheReadTokens,
    view.usage.reasoningTokens,
  );
  return {
    session: createIndexedSession({
      keyPrefix: "deepseek",
      rawId: log.header.id,
      source: "deepseek-cli",
      projectPath: log.header.cwd || "",
      filePath,
      originalTitle: view.title || cleanTitle(question) || log.header.id,
      firstQuestion: cleanTitle(question),
      timestamp: log.header.createdAt || stat.mtimeMs,
      tokenUsage: usage,
      isSubagent: log.header.delegationDepth > 0,
      parentSessionId: log.header.parentSession ?? null,
      stat,
    }),
    messages: view.messages,
    tokenEvents: view.tokenEvents,
    traceEvents: view.traceEvents,
  };
}

export function loadDeepSeekCliSessions(deepSeekDir?: string): LoadedSession[] {
  return [...loadDeepSeekCliSessionsIterator(deepSeekDir)];
}

export function* loadDeepSeekCliSessionsIterator(
  deepSeekDir = process.env.DSH_HOME?.trim() || path.join(os.homedir(), DEEPSEEK_HARNESS_DIR),
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  const sessionsDir = path.join(deepSeekDir, "sessions");
  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(sessionsDir, projectEntry.name);
    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const filePath = path.join(projectDir, sessionEntry.name, DEEPSEEK_HARNESS_LOG_NAME);
      const stat = safeStat(filePath);
      if (shouldSkipFile(options, filePath, stat)) continue;
      const loaded = loadDeepSeekCliSessionFile(filePath, stat);
      if (loaded) yield loaded;
    }
  }
}

export function loadHermesSessions(hermesDir = path.join(os.homedir(), ".hermes")): LoadedSession[] {
  const dbPath = path.join(hermesDir, "state.db");
  const db = readOnlyDatabase(dbPath);
  if (!db) return [];
  try {
    if (!sqliteTableExists(db, "sessions") || !sqliteTableExists(db, "messages")) return [];
    if (!sqliteHasColumns(db, "sessions", ["id", "started_at"]) || !sqliteHasColumns(db, "messages", ["id", "session_id", "timestamp"])) {
      return [];
    }
    const sessions = db.prepare("SELECT * FROM sessions ORDER BY started_at DESC").all() as Array<Record<string, unknown>>;
    return sessions.map((session) => loadHermesSessionRow(db, dbPath, session)).filter((item): item is LoadedSession => Boolean(item));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function loadHermesSessionRow(db: import("node:sqlite").DatabaseSync, dbPath: string, session: Record<string, unknown>): LoadedSession | null {
  const rawId = stringField(session, "id");
  if (!rawId) return null;
  const rows = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, id").all(rawId) as Array<Record<string, unknown>>;
  const messages: SessionMessage[] = [];
  const traceDrafts: TraceEventDraft[] = [];
  for (const row of rows) {
    const role = roleFromValue(row);
    const content = stringField(row, "content");
    const ts = timestampString(unknownField(row, "timestamp"));
    if (role && content && isMeaningfulUserMessage(content)) messages.push(messageFromParts(role, content, ts, messages.length));
    const toolName = stringField(row, "tool_name");
    const toolCalls = stringField(row, "tool_calls");
    if (toolName || toolCalls) {
      traceDrafts.push({
        kind: "tool_call",
        source: "hermes",
        title: toolName || "tool_call",
        detail: stringifyDetail(parseJsonText(toolCalls || toolName)),
        timestamp: ts,
        callId: stringField(row, "tool_call_id") || null,
        eventType: null,
        status: "unknown",
      });
    }
  }
  const usage = createSourceTokenUsage(
    numberField(session, "input_tokens"),
    numberField(session, "output_tokens"),
    numberField(session, "cache_read_tokens") + numberField(session, "cached_input_tokens"),
    numberField(session, "reasoning_tokens") + numberField(session, "reasoning_output_tokens"),
  );
  const question = firstQuestion(messages);
  const stat = safeStat(dbPath);
  const title = stringField(session, "title");
  const modelConfig = parseJsonText(unknownField(session, "model_config"));
  const delegateFrom = isRecord(modelConfig) ? stringField(modelConfig, "_delegate_from") || null : null;
  const parentSessionId = delegateFrom
    ? stringField(session, "parent_session_id") || delegateFrom
    : null;
  return {
    session: createIndexedSession({
      keyPrefix: "hermes",
      rawId,
      source: "hermes",
      projectPath:
        stringField(session, "cwd") ||
        extractProjectPathFromJson(unknownField(session, "model_config")),
      filePath: dbPath,
      originalTitle: title || cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: timestampMs(unknownField(session, "started_at")) || stat.mtimeMs,
      tokenUsage: usage,
      stat,
      isSubagent: parentSessionId !== null,
      parentSessionId,
    }),
    messages,
    traceEvents: dedupeTraceEvents(traceDrafts),
  };
}

function resolveOpenCodeDbPath(root: string, shareDir = "opencode"): string {
  const direct = path.join(root, "opencode.db");
  if (fs.existsSync(direct)) return direct;
  return path.join(root, ".local", "share", shareDir, "opencode.db");
}

export function loadOpenCodeSessions(opencodeRoot = path.join(os.homedir(), ".local", "share", "opencode")): LoadedSession[] {
  return loadOpenCodeLikeSessions(opencodeRoot, {
    keyPrefix: "opencode",
    source: "opencode-cli",
    traceSource: "opencode",
  });
}

export function loadCodeWizSessions(codeWizRoot = path.join(os.homedir(), CODEWIZ_SHARE_DIR)): LoadedSession[] {
  return loadOpenCodeLikeSessions(codeWizRoot, {
    keyPrefix: "codewiz",
    source: "codewiz-cli",
    traceSource: "codewiz",
  });
}

function loadOpenCodeLikeSessions(
  opencodeRoot: string,
  sourceOptions: { keyPrefix: "opencode" | "codewiz"; source: "opencode-cli" | "codewiz-cli"; traceSource: "opencode" | "codewiz" },
): LoadedSession[] {
  const dbPath = resolveOpenCodeDbPath(opencodeRoot, sourceOptions.keyPrefix);
  const db = readOnlyDatabase(dbPath);
  if (!db) return [];
  try {
    if (!sqliteTableExists(db, "session")) return [];
    if (!sqliteHasColumns(db, "session", ["id", "time_created"])) return [];
    if (sqliteTableExists(db, "message") && !sqliteHasColumns(db, "message", ["id", "session_id", "data"])) return [];
    const sessions = db.prepare("SELECT * FROM session ORDER BY time_created DESC").all() as Array<Record<string, unknown>>;
    return sessions.map((session) => loadOpenCodeSessionRow(db, dbPath, session, sourceOptions)).filter((item): item is LoadedSession => Boolean(item));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function opencodeMessagesFromParts(
  db: import("node:sqlite").DatabaseSync,
  rawId: string,
  traceSource: "opencode" | "codewiz" = "opencode",
): { messages: SessionMessage[]; traceEvents: SessionTraceEvent[]; tokenEvents: TokenUsageEvent[] } {
  if (!sqliteTableExists(db, "message")) return { messages: [], traceEvents: [], tokenEvents: [] };
  const messageColumns = sqliteColumns(db, "message");
  const partColumns = sqliteColumns(db, "part");
  const hasPart = sqliteTableExists(db, "part") && partColumns.has("data");
  const messageTypeSelect = messageColumns.has("type") ? "message.type" : "'' AS type";
  const rows = hasPart
    ? (db
        .prepare(
          `
          SELECT message.id, ${messageTypeSelect}, message.time_created, message.data AS message_data,
            part.id AS part_id, part.time_created AS part_time_created, part.data AS part_data
          FROM message
          LEFT JOIN part ON part.message_id = message.id
          WHERE message.session_id = ?
          ORDER BY message.time_created, part.time_created, part.id
        `,
        )
        .all(rawId) as Array<Record<string, unknown>>)
    : (db
        .prepare(
          `
          SELECT id, type, ${messageColumns.has("time_created") ? "time_created" : "0 AS time_created"}, data AS message_data
          FROM message
          WHERE session_id = ?
          ORDER BY time_created, id
        `,
        )
        .all(rawId) as Array<Record<string, unknown>>);

  const messages: SessionMessage[] = [];
  const traceDrafts: TraceEventDraft[] = [];
  const tokenEntries = new Map<string, TokenUsageEvent>();
  for (const row of rows) {
    const messageData = parseJsonText(unknownField(row, "message_data"));
    const partData = parseJsonText(unknownField(row, "part_data"));
    const ts = timestampString(unknownField(row, "part_time_created") || unknownField(row, "time_created"));
    const tokenSource = tokenDataFromOpenCodeRecord(partData) || tokenDataFromOpenCodeRecord(messageData);
    if (tokenSource) {
      const rawKey = stringField(row, "id") || stringField(row, "part_id") || `${rawId}:${tokenEntries.size}`;
      const key = `${traceSource}:${rawKey}`;
      putTokenEvent(tokenEntries, tokenEvent(timestampMs(unknownField(row, "part_time_created") || unknownField(row, "time_created")), key, tokenSource.input, tokenSource.output, tokenSource.cached, tokenSource.reasoning));
    }
    const role = (isRecord(messageData) && roleFromValue(messageData)) || roleFromValue(row);
    const content = extractText(partData) || (isRecord(messageData) ? extractText(messageData) : "");
    if (role && content && isMeaningfulUserMessage(content)) {
      messages.push(messageFromParts(role, content, ts, messages.length));
      continue;
    }
    if (content || isRecord(partData)) {
      const name = isRecord(partData) ? firstStringField(partData, ["tool", "toolName", "name", "type"]) : stringField(row, "type");
      traceDrafts.push({
        kind: "event",
        source: traceSource,
        title: normalizeTraceTitle(name || "part", firstStringField(partData, ["command", "path", "file_path", "query"])),
        detail: stringifyDetail(partData || messageData),
        timestamp: ts,
        callId: stringField(row, "part_id") || stringField(row, "id") || null,
        eventType: stringField(row, "type") || null,
        status: "unknown",
      });
    }
  }
  return { messages, traceEvents: dedupeTraceEvents(traceDrafts), tokenEvents: Array.from(tokenEntries.values()) };
}

function tokenDataFromOpenCodeRecord(value: unknown): { input: number; output: number; cached: number; reasoning: number } | null {
  if (!isRecord(value)) return null;
  const tokens = unknownField(value, "tokens");
  if (!isRecord(tokens)) return null;
  const cache = unknownField(tokens, "cache");
  const cached = isRecord(cache) ? numberField(cache, "read") + numberField(cache, "write") : numberField(tokens, "cached") + numberField(tokens, "cache_read") + numberField(tokens, "cache_write");
  const input = numberField(tokens, "input");
  const output = numberField(tokens, "output");
  const reasoning = numberField(tokens, "reasoning");
  if (input <= 0 && output <= 0 && cached <= 0 && reasoning <= 0) return null;
  return { input, output, cached, reasoning };
}

function loadOpenCodeSessionRow(
  db: import("node:sqlite").DatabaseSync,
  dbPath: string,
  session: Record<string, unknown>,
  sourceOptions: { keyPrefix: "opencode" | "codewiz"; source: "opencode-cli" | "codewiz-cli"; traceSource: "opencode" | "codewiz" } = {
    keyPrefix: "opencode",
    source: "opencode-cli",
    traceSource: "opencode",
  },
): LoadedSession | null {
  const rawId = stringField(session, "id");
  if (!rawId) return null;
  const { messages, traceEvents, tokenEvents } = opencodeMessagesFromParts(db, rawId, sourceOptions.traceSource);
  const question = firstQuestion(messages);
  const stat = safeStat(dbPath);
  const usage = tokenEvents.length
    ? tokenUsageFromEvents(tokenEvents)
    : createSourceTokenUsage(
        numberField(session, "tokens_input"),
        numberField(session, "tokens_output"),
        numberField(session, "tokens_cache_read") + numberField(session, "tokens_cache_write"),
        numberField(session, "tokens_reasoning"),
      );
  return {
    session: createIndexedSession({
      keyPrefix: sourceOptions.keyPrefix,
      rawId,
      source: sourceOptions.source,
      projectPath: stringField(session, "directory") || stringField(session, "path"),
      filePath: dbPath,
      originalTitle: stringField(session, "title") || cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: timestampMs(unknownField(session, "time_updated")) || timestampMs(unknownField(session, "time_created")) || stat.mtimeMs,
      tokenUsage: usage,
      stat,
    }),
    messages,
    tokenEvents,
    traceEvents,
  };
}

function zcodeDatabaseStat(dbPath: string): VirtualSessionFileStat {
  const database = safeStat(dbPath);
  const wal = safeStat(`${dbPath}-wal`);
  return {
    mtimeMs: Math.max(database.mtimeMs, wal.mtimeMs),
    size: database.size + wal.size,
  };
}

function zcodeToolStatus(value: string): "completed" | "failed" | "unknown" {
  if (value === "completed") return "completed";
  if (value === "error") return "failed";
  return "unknown";
}

function zcodeMessagesFromParts(
  db: import("node:sqlite").DatabaseSync,
  rawId: string,
): { messages: SessionMessage[]; traceEvents: SessionTraceEvent[]; assistantMessageIds: Set<string> } {
  const rows = db
    .prepare(
      `
        SELECT message.id AS message_id, message.time_created AS message_time_created, message.data AS message_data,
          part.id AS part_id, part.time_created AS part_time_created, part.data AS part_data
        FROM message
        LEFT JOIN part ON part.message_id = message.id
        WHERE message.session_id = ?
        ORDER BY message.time_created, message.id, part.time_created, part.id
      `,
    )
    .all(rawId) as Array<Record<string, unknown>>;

  const drafts = new Map<string, { role: "user" | "assistant"; timestamp: string; text: string[] }>();
  const assistantMessageIds = new Set<string>();
  const traceDrafts: TraceEventDraft[] = [];
  for (const row of rows) {
    const messageId = stringField(row, "message_id");
    const messageData = parseJsonText(unknownField(row, "message_data"));
    const role = roleFromValue(messageData);
    if (!messageId || !role) continue;
    if (role === "assistant") assistantMessageIds.add(messageId);

    let draft = drafts.get(messageId);
    if (!draft) {
      draft = {
        role,
        timestamp: timestampString(unknownField(row, "message_time_created")),
        text: [],
      };
      drafts.set(messageId, draft);
    }

    const partData = parseJsonText(unknownField(row, "part_data"));
    if (!isRecord(partData)) continue;
    const partType = stringField(partData, "type");
    if (partType === "text") {
      const text = stringField(partData, "text").trim();
      if (text) draft.text.push(text);
      continue;
    }
    if (partType !== "tool") continue;

    const state = objectField(partData, "state");
    const input = state ? unknownField(state, "input") : undefined;
    const output = state ? unknownField(state, "output") : undefined;
    const time = state ? objectField(state, "time") : null;
    const toolName = stringField(partData, "tool") || "tool";
    const summary = firstStringField(input, ["command", "path", "file_path", "query", "url", "description"]);
    traceDrafts.push({
      kind: "tool_call",
      source: "zcode",
      title: normalizeTraceTitle(toolName, summary),
      detail: stringifyDetail({ input, output }),
      timestamp: timestampString(unknownField(time, "start") || unknownField(row, "part_time_created")),
      callId: stringField(partData, "callID") || null,
      eventType: "tool",
      status: zcodeToolStatus(stringField(state, "status")),
    });
  }

  const messages: SessionMessage[] = [];
  for (const draft of drafts.values()) {
    const content = draft.text.join("\n");
    if (!content || (draft.role === "user" && !isMeaningfulUserMessage(content))) continue;
    messages.push(messageFromParts(draft.role, content, draft.timestamp, messages.length));
  }
  return { messages, traceEvents: dedupeTraceEvents(traceDrafts), assistantMessageIds };
}

function zcodeTokenEventsFromModelUsage(
  db: import("node:sqlite").DatabaseSync,
  rawId: string,
  assistantMessageIds: ReadonlySet<string>,
): TokenUsageEvent[] {
  if (!sqliteTableExists(db, "model_usage")) return [];
  if (
    !sqliteHasColumns(db, "model_usage", [
      "id",
      "session_id",
      "assistant_message_id",
      "query_source",
      "status",
      "started_at",
      "completed_at",
      "input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ])
  ) {
    return [];
  }

  try {
    const rows = db
      .prepare(
        `
          SELECT id, assistant_message_id, started_at, completed_at, input_tokens, output_tokens,
            reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens
          FROM model_usage
          WHERE session_id = ? AND status = 'completed' AND query_source <> 'session_title'
          ORDER BY COALESCE(completed_at, started_at), started_at, id
        `,
      )
      .all(rawId) as Array<Record<string, unknown>>;
    const events: TokenUsageEvent[] = [];
    for (const row of rows) {
      const id = stringField(row, "id");
      const assistantMessageId = stringField(row, "assistant_message_id");
      if (!id || !assistantMessageIds.has(assistantMessageId)) continue;
      const cached = Math.max(0, numberField(row, "cache_read_input_tokens"));
      const cacheCreation = Math.max(0, numberField(row, "cache_creation_input_tokens"));
      const freshInput = Math.max(0, numberField(row, "input_tokens") - cached - cacheCreation);
      events.push(
        tokenEvent(
          timestampMs(unknownField(row, "completed_at")) || timestampMs(unknownField(row, "started_at")),
          id,
          freshInput,
          Math.max(0, numberField(row, "output_tokens")),
          cached,
          Math.max(0, numberField(row, "reasoning_tokens")),
          cacheCreation,
        ),
      );
    }
    return events;
  } catch {
    return [];
  }
}

function loadZcodeSessionRow(
  db: import("node:sqlite").DatabaseSync,
  dbPath: string,
  stat: VirtualSessionFileStat,
  session: Record<string, unknown>,
): LoadedSession | null {
  const rawId = stringField(session, "id");
  if (!rawId) return null;
  const { messages, traceEvents, assistantMessageIds } = zcodeMessagesFromParts(db, rawId);
  const tokenEvents = zcodeTokenEventsFromModelUsage(db, rawId, assistantMessageIds);
  const question = firstQuestion(messages);
  const parentSessionId = stringField(session, "parent_id") || null;
  return {
    session: createIndexedSession({
      keyPrefix: "zcode",
      rawId,
      source: "zcode-cli",
      projectPath: stringField(session, "directory"),
      filePath: dbPath,
      originalTitle: stringField(session, "title") || cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: timestampMs(unknownField(session, "time_updated")) || timestampMs(unknownField(session, "time_created")) || stat.mtimeMs,
      tokenUsage: tokenUsageFromEvents(tokenEvents),
      stat,
      isSubagent: parentSessionId !== null,
      parentSessionId,
    }),
    messages,
    tokenEvents,
    traceEvents,
  };
}

export function loadZcodeSessions(zcodeDir = path.join(os.homedir(), ".zcode")): LoadedSession[] {
  const dbPath = path.join(zcodeDir, "cli", "db", "db.sqlite");
  const db = readOnlyDatabase(dbPath);
  if (!db) return [];
  try {
    if (!sqliteHasColumns(db, "session", ["id", "title", "directory", "time_created", "time_updated", "parent_id"])) return [];
    if (!sqliteHasColumns(db, "message", ["id", "session_id", "time_created", "data"])) return [];
    if (!sqliteHasColumns(db, "part", ["id", "message_id", "session_id", "time_created", "data"])) return [];
    const stat = zcodeDatabaseStat(dbPath);
    const sessions = db.prepare("SELECT * FROM session ORDER BY time_updated DESC, time_created DESC, id").all() as Array<Record<string, unknown>>;
    return sessions
      .map((session) => {
        try {
          return loadZcodeSessionRow(db, dbPath, stat, session);
        } catch {
          return null;
        }
      })
      .filter((item): item is LoadedSession => Boolean(item));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function traceEventsFromCursorRows(rows: unknown[]): SessionTraceEvent[] {
  const events: TraceEventDraft[] = [];
  for (const row of rows) {
    if (!isRecord(row) || stringField(row, "role") !== "assistant") continue;
    const message = objectField(row, "message");
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    const timestamp = cursorTimestampFromRow(row);
    for (const block of content) {
      if (!isRecord(block) || stringField(block, "type") !== "tool_use") continue;
      const name = stringField(block, "name") || "tool";
      const input = unknownField(block, "input");
      const parsedInput = parseMaybeJson(input);
      const summary =
        firstStringField(parsedInput, ["path", "command", "query", "url", "pattern", "glob_pattern", "description", "search_term"]) ||
        firstStringField(block, ["path", "command", "query", "url"]);
      events.push({
        kind: "tool_call",
        source: "cursor",
        title: normalizeTraceTitle(name, summary),
        detail: stringifyDetail(parsedInput),
        timestamp,
        callId: stringField(block, "id") || null,
        eventType: "tool_use",
        status: "unknown",
      });
    }
  }
  return dedupeTraceEvents(events);
}

function cursorWorkspaceStateDbPath(cursorDir: string, override?: string): string {
  if (override) return override;
  const homeDir = path.basename(cursorDir) === ".cursor" ? path.dirname(cursorDir) : cursorDir;
  if (process.platform === "win32") {
    return path.join(homeDir, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function cursorDatabaseStat(stateDbPath: string): VirtualSessionFileStat {
  const databaseStat = safeStat(stateDbPath);
  const walStat = safeStat(`${stateDbPath}-wal`);
  return {
    mtimeMs: Math.max(databaseStat.mtimeMs, walStat.mtimeMs),
    size: databaseStat.size + walStat.size,
  };
}

function folderPathFromWorkspaceMetadataEntry(entry: Record<string, unknown>): string {
  const folderUri = stringField(entry, "folderUri");
  if (folderUri.startsWith("file://")) return decodeURIComponent(folderUri.replace(/^file:\/\//, ""));

  const paths = entry.paths;
  if (Array.isArray(paths) && isRecord(paths[0])) {
    const uri = objectField(paths[0], "uri");
    const fsPath = uri ? stringField(uri, "fsPath") : "";
    if (fsPath) return fsPath;
  }

  return "";
}

export function loadCursorWorkspacePathMap(
  cursorDir = path.join(os.homedir(), ".cursor"),
  stateDbPath = cursorWorkspaceStateDbPath(cursorDir),
): Map<string, string> {
  const map = new Map<string, string>();

  try {
    if (fs.existsSync(stateDbPath)) {
      const db = new DatabaseSync(stateDbPath, { readOnly: true });
      try {
        const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("workspaceMetadata.entries") as { value?: string } | undefined;
        if (row?.value) {
          const parsed = JSON.parse(row.value) as { entries?: unknown[] };
          for (const entry of parsed.entries ?? []) {
            if (!isRecord(entry)) continue;
            const folderPath = folderPathFromWorkspaceMetadataEntry(entry);
            if (folderPath) map.set(encodeCursorWorkspaceSlug(folderPath), folderPath);
          }
        }
      } finally {
        db.close();
      }
    }
  } catch {
    // Ignore metadata lookup failures and fall back to slug heuristics.
  }

  const projectsDir = path.join(cursorDir, "projects");
  if (fs.existsSync(projectsDir)) {
    for (const slug of fs.readdirSync(projectsDir)) {
      if (!slug || slug === "empty-window" || map.has(slug)) continue;
      const decoded = decodeCursorWorkspaceSlugHeuristic(slug);
      if (decoded && fs.existsSync(decoded)) map.set(slug, decoded);
    }
  }

  return map;
}

function decodeCursorWorkspaceSlugHeuristic(slug: string): string {
  if (!slug || slug === "empty-window") return "";
  const parts = slug.split("-");
  if (parts[0] === "Users" && parts.length >= 2) {
    return `/${parts.join("/")}`;
  }
  if (parts[0] === "C" && parts[1] === "Users" && parts.length >= 3) {
    return `${parts[0]}:/${parts.slice(1).join("/")}`;
  }
  return slug;
}

export function decodeCursorWorkspaceSlug(slug: string, pathMap?: ReadonlyMap<string, string>): string {
  if (!slug || slug === "empty-window") return "";
  return pathMap?.get(slug) || decodeCursorWorkspaceSlugHeuristic(slug);
}

export function encodeCursorWorkspaceSlug(projectPath: string): string {
  const trimmed = projectPath.trim();
  if (!trimmed) return "empty-window";
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const slashEncoded = /^[A-Za-z]:\//.test(normalized)
    ? normalized.replace(/^[A-Za-z]:\//, (match) => `${match[0]}-`).replace(/\//g, "-")
    : normalized.replace(/^\/+/, "").replace(/\//g, "-");
  const sanitized = slashEncoded.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "empty-window";
}

function cursorTranscriptSessionIdFromPath(filePath: string): string {
  const baseName = path.basename(filePath);
  const match = baseName.match(/^(.+?)\.jsonl(?:\.tmp-.+)?$/i);
  return match ? match[1] : baseName.replace(/\.jsonl$/i, "");
}

export function parseCursorTranscriptPath(filePath: string): {
  workspaceSlug: string;
  sessionId: string;
  isSubagent: boolean;
  parentSessionId: string | null;
} {
  const projectsMarker = `${path.sep}projects${path.sep}`;
  const afterProjects = filePath.includes(projectsMarker) ? filePath.split(projectsMarker)[1] || "" : "";
  const workspaceSlug = afterProjects.split(path.sep)[0] || "";
  const sessionId = cursorTranscriptSessionIdFromPath(filePath);
  const parts = filePath.split(path.sep);
  const transcriptsIndex = parts.lastIndexOf("agent-transcripts");
  const subagentsIndex = parts.lastIndexOf("subagents");
  const isSubagent = subagentsIndex >= 0 && transcriptsIndex >= 0 && subagentsIndex > transcriptsIndex;
  const parentSessionId = isSubagent && subagentsIndex > 0 ? parts[subagentsIndex - 1] || null : null;
  return { workspaceSlug, sessionId, isSubagent, parentSessionId };
}

function cursorTimestampMsFromRows(rows: unknown[]): number {
  for (const row of rows) {
    const timestamp = cursorTimestampFromRow(row);
    const parsed = timestampMs(timestamp);
    if (parsed) return parsed;
  }
  return 0;
}

interface CursorComposerMetadata {
  composerId: string;
  title: string;
  projectPath: string;
  createdAt: number;
  isDraft: boolean;
  isSubagent: boolean;
  parentSessionId: string | null;
  messages: SessionMessage[];
  hasVisibleConversation: boolean;
  executionEnvironmentHint?: LoadedSession["executionEnvironmentHint"];
}

interface CursorBubbleDraft {
  bubbleId: string;
  key: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

function cursorSshEnvironmentHint(
  ...uris: Array<Record<string, unknown> | null>
): LoadedSession["executionEnvironmentHint"] | undefined {
  for (const uri of uris) {
    if (!uri) continue;
    if (stringField(uri, "scheme") !== "vscode-remote") continue;
    const authority = stringField(uri, "authority");
    if (!authority.startsWith("ssh-remote+")) continue;
    const hostAlias = authority.slice("ssh-remote+".length).trim();
    if (hostAlias) return { kind: "ssh", label: hostAlias, hostAlias };
  }
  return undefined;
}

function loadCursorComposerMetadata(stateDbPath: string): Map<string, CursorComposerMetadata> {
  const metadata = new Map<string, CursorComposerMetadata>();
  const db = readOnlyDatabase(stateDbPath);
  if (!db) return metadata;

  try {
    if (!sqliteHasColumns(db, "composerHeaders", ["composerId", "createdAt", "isSubagent", "value"])) return metadata;

    const messageDrafts = new Map<string, Map<string, CursorBubbleDraft>>();
    const visibleBubbleIds = new Map<string, string[]>();
    if (sqliteHasColumns(db, "cursorDiskKV", ["key", "value"])) {
      const composerRows = db
        .prepare("SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all() as Array<{ key?: string; value?: string }>;
      for (const row of composerRows) {
        const key = row.key || "";
        const composerId = key.slice("composerData:".length);
        const composerData = parseJsonText(row.value);
        if (!composerId || !isRecord(composerData)) continue;
        const headers = unknownField(composerData, "fullConversationHeadersOnly");
        if (!Array.isArray(headers)) continue;
        visibleBubbleIds.set(
          composerId,
          headers
            .map((header) => stringField(header, "bubbleId"))
            .filter((bubbleId): bubbleId is string => Boolean(bubbleId)),
        );
      }

      const bubbleRows = db
        .prepare("SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'")
        .all() as Array<{ key?: string; value?: string }>;
      for (const row of bubbleRows) {
        const key = row.key || "";
        const separator = key.indexOf(":", "bubbleId:".length);
        if (separator < 0) continue;
        const composerId = key.slice("bubbleId:".length, separator);
        const bubble = parseJsonText(row.value);
        if (!composerId || !isRecord(bubble)) continue;
        const bubbleId = stringField(bubble, "bubbleId") || key.slice(separator + 1);
        if (!bubbleId) continue;
        const type = numberField(bubble, "type");
        const role = type === 1 ? "user" : type === 2 ? "assistant" : null;
        if (!role) continue;
        const plainText = stringField(bubble, "text").trim();
        const rawContent = plainText || extractText(parseJsonText(stringField(bubble, "richText"))).trim();
        const content = role === "user" ? extractCursorUserQuery(rawContent) : rawContent;
        if (!content || (role === "user" && !isMeaningfulUserMessage(content))) continue;
        const drafts = messageDrafts.get(composerId) ?? new Map<string, CursorBubbleDraft>();
        drafts.set(bubbleId, {
          bubbleId,
          key,
          role,
          content,
          timestamp: timestampString(unknownField(bubble, "createdAt")),
        });
        messageDrafts.set(composerId, drafts);
      }
    }

    const headerRows = db.prepare("SELECT composerId, createdAt, isSubagent, value FROM composerHeaders").all() as Array<
      Record<string, unknown>
    >;
    for (const row of headerRows) {
      const composerId = stringField(row, "composerId");
      const header = parseJsonText(unknownField(row, "value"));
      if (!composerId || !isRecord(header)) continue;

      const workspaceIdentifier = objectField(header, "workspaceIdentifier");
      const workspaceUri = objectField(workspaceIdentifier, "uri");
      const agentLocation = objectField(header, "agentLocation");
      const agentEnvironment = objectField(agentLocation, "environment");
      const agentUri = objectField(agentEnvironment, "uri");
      const draftTarget = objectField(header, "draftTarget");
      const draftEnvironment = objectField(draftTarget, "environment");
      const draftUri = objectField(draftEnvironment, "uri");
      const subagentInfo = objectField(header, "subagentInfo");
      const draftsById = messageDrafts.get(composerId) ?? new Map<string, CursorBubbleDraft>();
      const visibleIds = visibleBubbleIds.get(composerId);
      const drafts = visibleIds !== undefined
        ? visibleIds.flatMap((bubbleId) => {
            const draft = draftsById.get(bubbleId);
            return draft ? [draft] : [];
          })
        : [...draftsById.values()].sort((left, right) => {
            const timestampDelta = timestampMs(left.timestamp) - timestampMs(right.timestamp);
            return timestampDelta || left.key.localeCompare(right.key);
          });

      metadata.set(composerId, {
        composerId,
        title: cleanTitle(stringField(header, "name")),
        projectPath:
          firstStringField(workspaceUri, ["fsPath", "path"]) ||
          firstStringField(agentUri, ["fsPath", "path"]) ||
          firstStringField(draftUri, ["fsPath", "path"]),
        createdAt: numberField(row, "createdAt") || numberField(header, "createdAt"),
        isDraft: unknownField(header, "isDraft") === true,
        isSubagent: numberField(row, "isSubagent") === 1 || Boolean(subagentInfo),
        parentSessionId: stringField(subagentInfo, "parentComposerId") || null,
        messages: drafts.map((draft, index) => messageFromParts(draft.role, draft.content, draft.timestamp, index)),
        hasVisibleConversation: visibleIds !== undefined,
        executionEnvironmentHint: cursorSshEnvironmentHint(workspaceUri, agentUri, draftUri),
      });
    }
  } catch {
    return new Map();
  } finally {
    db.close();
  }

  return metadata;
}

function cursorTranscriptRowsForVisibleBranch(
  rows: unknown[],
  visibleMessages: SessionMessage[],
): unknown[] | null {
  const visiblePrompts = visibleMessages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim());
  if (visiblePrompts.length === 0) return [];

  const turns: Array<{ rowIndex: number; prompt: string }> = [];
  for (const [rowIndex, row] of rows.entries()) {
    const prompt = sourceMessages([row], "cursor")
      .find((message) => message.role === "user")
      ?.content.trim();
    if (prompt) turns.push({ rowIndex, prompt });
  }

  // Cursor appends replacement turns after discarded ones. Match backwards so
  // repeated prompts resolve to the latest branch without an O(n*m) LCS table.
  const visibleTurnRows = new Set<number>();
  let turnIndex = turns.length - 1;
  for (let visibleIndex = visiblePrompts.length - 1; visibleIndex >= 0; visibleIndex -= 1) {
    while (turnIndex >= 0 && turns[turnIndex].prompt !== visiblePrompts[visibleIndex]) {
      turnIndex -= 1;
    }
    if (turnIndex < 0) return null;
    visibleTurnRows.add(turns[turnIndex].rowIndex);
    turnIndex -= 1;
  }

  const filtered: unknown[] = [];
  const turnRows = new Set(turns.map((turn) => turn.rowIndex));
  let includeTurn = false;
  for (const [rowIndex, row] of rows.entries()) {
    if (turnRows.has(rowIndex)) {
      includeTurn = visibleTurnRows.has(rowIndex);
    }
    if (includeTurn) filtered.push(row);
  }
  return filtered;
}

export function loadCursorTranscriptFile(
  filePath: string,
  stat = safeStat(filePath),
  workspacePathMap?: ReadonlyMap<string, string>,
  visibleMessages?: SessionMessage[],
): LoadedSession | null {
  const rows = readJsonl(filePath);
  if (rows.length === 0) return null;

  const { workspaceSlug, sessionId, isSubagent, parentSessionId } = parseCursorTranscriptPath(filePath);
  const rawId = sessionId;
  const visibleRows = visibleMessages === undefined
    ? rows
    : cursorTranscriptRowsForVisibleBranch(rows, visibleMessages);
  const messages = visibleRows === null
    ? (visibleMessages ?? sourceMessages(rows, "cursor"))
    : sourceMessages(visibleRows, "cursor");
  const traceEvents = visibleRows === null ? [] : traceEventsFromCursorRows(visibleRows);
  const question = firstQuestion(messages);
  const projectPath =
    rows.map((row) => (isRecord(row) ? firstStringField(row, ["cwd", "projectPath", "project_path", "workspacePath", "workspace_path"]) : "")).find(Boolean) ||
    decodeCursorWorkspaceSlug(workspaceSlug, workspacePathMap);
  const firstTs = cursorTimestampMsFromRows(rows) || stat.mtimeMs;
  const session = createIndexedSession({
    keyPrefix: "cursor",
    rawId,
    source: "cursor-agent",
    projectPath,
    filePath,
    originalTitle: cleanTitle(question) || rawId,
    firstQuestion: cleanTitle(question),
    timestamp: firstTs,
    stat,
    isSubagent,
    parentSessionId,
  });

  return {
    session: {
      ...session,
      sessionKey: workspaceSlug ? `cursor:${workspaceSlug}:${rawId}` : session.sessionKey,
    },
    messages,
    traceEvents,
  };
}

export function loadCursorAgentSessions(cursorDir = path.join(os.homedir(), ".cursor"), options: SessionLoadOptions = {}): LoadedSession[] {
  return [...loadCursorAgentSessionsIterator(cursorDir, options)];
}

export function* loadCursorAgentSessionsIterator(cursorDir = path.join(os.homedir(), ".cursor"), options: SessionLoadOptions = {}): Generator<LoadedSession> {
  const projectsDir = path.join(cursorDir, "projects");
  const stateDbPath = cursorWorkspaceStateDbPath(cursorDir, options.cursorStateDbPath);
  const stateDbStat = cursorDatabaseStat(stateDbPath);
  const composerMetadata = loadCursorComposerMetadata(stateDbPath);
  const workspacePathMap = options.cursorWorkspacePathMap ?? loadCursorWorkspacePathMap(cursorDir, stateDbPath);
  const transcriptSessionIds = new Set<string>();

  if (fs.existsSync(projectsDir)) {
    for (const filePath of walkJsonlFiles(projectsDir)) {
      if (!filePath.includes(`${path.sep}agent-transcripts${path.sep}`)) continue;
      const transcriptPath = parseCursorTranscriptPath(filePath);
      const stat = safeStat(filePath);
      if (shouldSkipFile(options, filePath, stat, stateDbStat.mtimeMs)) {
        transcriptSessionIds.add(transcriptPath.sessionId);
        continue;
      }
      const header = composerMetadata.get(transcriptPath.sessionId);
      const loaded = loadCursorTranscriptFile(
        filePath,
        stat,
        workspacePathMap,
        header?.hasVisibleConversation ? header.messages : undefined,
      );
      if (!loaded) continue;
      transcriptSessionIds.add(transcriptPath.sessionId);
      if (header) {
        loaded.session = {
          ...loaded.session,
          projectPath: header.projectPath || loaded.session.projectPath,
          originalTitle: header.title || loaded.session.originalTitle,
          timestamp: header.createdAt || loaded.session.timestamp,
          isSubagent: header.isSubagent || loaded.session.isSubagent,
          parentSessionId: header.parentSessionId || loaded.session.parentSessionId,
          storageEnvironmentId: "local",
        };
        loaded.executionEnvironmentHint = header.executionEnvironmentHint;
      }
      yield loaded;
    }
  }

  for (const header of composerMetadata.values()) {
    if (transcriptSessionIds.has(header.composerId)) continue;
    // A header without readable messages is only Cursor's residual metadata. It
    // can remain after the conversation disappears from Cursor's own history,
    // and indexing it produces a misleading zero-message session.
    if (header.messages.length === 0) continue;
    const question = cleanTitle(firstQuestion(header.messages));
    if (header.isDraft && !header.title && !question) continue;
    const workspaceSlug = encodeCursorWorkspaceSlug(header.projectPath);
    const session = createIndexedSession({
      keyPrefix: "cursor",
      rawId: header.composerId,
      source: "cursor-agent",
      projectPath: header.projectPath,
      filePath: stateDbPath,
      originalTitle: header.title || question || header.composerId,
      firstQuestion: question,
      timestamp: header.createdAt,
      stat: stateDbStat,
      isSubagent: header.isSubagent,
      parentSessionId: header.parentSessionId,
    });
    yield {
      session: {
        ...session,
        sessionKey: `cursor:${workspaceSlug}:${header.composerId}`,
        storageEnvironmentId: "local",
      },
      messages: header.messages,
      executionEnvironmentHint: header.executionEnvironmentHint,
    };
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
  if (options.includePi) {
    yield* loadPiSessionsIterator(path.join(homeDir, PI_SESSIONS_DIR), options);
  }
  if (options.includeKimiCli) yield* loadKimiSessionsIterator(path.join(homeDir, KIMI_LEGACY_DIR), resolveKimiCodeRoot(homeDir, options), options);
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
  if (options.includeDeepSeekCli) {
    const deepSeekDir = options.homeDir === undefined
      ? process.env.DSH_HOME?.trim() || path.join(homeDir, DEEPSEEK_HARNESS_DIR)
      : path.join(homeDir, DEEPSEEK_HARNESS_DIR);
    yield* loadDeepSeekCliSessionsIterator(deepSeekDir, options);
  }
  if (options.includeTclaude) yield* loadClaudeCliSessionsIterator(path.join(homeDir, TCLAUDE_DIR), "tclaude-cli", options);
  if (options.includeTcodex) yield* loadCodexSessionsIterator(path.join(homeDir, TCODEX_DIR), "tcodex-cli", options);
  if (options.includeCodeBuddyCli) yield* loadCodeBuddyCliSessionsIterator(path.join(homeDir, CODEBUDDY_DIR), options);
  if (options.includeWorkBuddy) yield* loadWorkBuddyCliSessionsIterator(path.join(homeDir, WORKBUDDY_DIR), options);
}

export async function* loadDefaultSessionsAsyncIterator(options: SessionLoadOptions = {}): AsyncGenerator<LoadedSession> {
  const homeDir = options.homeDir ?? os.homedir();
  yield* loadClaudeCliSessionsIterator(path.join(homeDir, ".claude"), "claude-cli", options);
  yield* loadClaudeAppSessionsIterator(
    path.join(homeDir, "Library", "Application Support", "Claude", "claude-code-sessions"),
    path.join(homeDir, ".claude"),
    options,
  );
  yield* loadCodexSessionsAsyncIterator(path.join(homeDir, ".codex"), undefined, options);
  if (options.includePi) {
    yield* loadPiSessionsIterator(path.join(homeDir, PI_SESSIONS_DIR), options);
  }
  if (options.includeKimiCli) yield* loadKimiSessionsIterator(path.join(homeDir, KIMI_LEGACY_DIR), resolveKimiCodeRoot(homeDir, options), options);
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
  if (options.includeDeepSeekCli) {
    const deepSeekDir = options.homeDir === undefined
      ? process.env.DSH_HOME?.trim() || path.join(homeDir, DEEPSEEK_HARNESS_DIR)
      : path.join(homeDir, DEEPSEEK_HARNESS_DIR);
    yield* loadDeepSeekCliSessionsIterator(deepSeekDir, options);
  }
  if (options.includeTclaude) yield* loadClaudeCliSessionsIterator(path.join(homeDir, TCLAUDE_DIR), "tclaude-cli", options);
  if (options.includeTcodex) yield* loadCodexSessionsAsyncIterator(path.join(homeDir, TCODEX_DIR), "tcodex-cli", options);
  if (options.includeCodeBuddyCli) yield* loadCodeBuddyCliSessionsIterator(path.join(homeDir, CODEBUDDY_DIR), options);
  if (options.includeWorkBuddy) yield* loadWorkBuddyCliSessionsIterator(path.join(homeDir, WORKBUDDY_DIR), options);
}
