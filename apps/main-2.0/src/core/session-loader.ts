import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanTitle, getAdapter, isMeaningfulUserMessage, stripCodexInjectedNoise } from "./format-adapters";
import { scanCompleteJsonl, scanCompleteJsonlAsync } from "./codex-jsonl-stream";
import {
  CodexRolloutAccumulator,
  dedupeCodexTraceEvents,
  extractCodexExecToolNames,
  formatCodexToolDetail,
  sanitizeCodexTraceValue,
} from "./session-loaders/codex-rollout";
import {
  DEEPSEEK_HARNESS_DIR,
} from "./deepseek-harness";
import {
  CODEWIZ_SHARE_DIR,
  KIMI_CODE_DIR,
  KIMI_LEGACY_DIR,
  PI_SESSIONS_DIR,
  QODER_DIR,
  TRAE_DIR_NAMES,
  loadCodeWizSessions,
  loadCursorAgentSessionsIterator,
  loadDeepSeekCliSessionsIterator,
  loadHermesSessions,
  loadOpenClawSessionsIterator,
  loadOpenCodeSessions,
  loadPiSessionsIterator,
  loadKimiSessionsIterator,
  loadQoderSessionsIterator,
  loadTraeSessionsIterator,
  loadZcodeSessions,
} from "./session-loaders/alternative-sources";
export * from "./session-loaders/alternative-sources";
import { loadWorkBuddySessionsIterator } from "./session-loaders/workbuddy";
export * from "./session-loaders/workbuddy";
import {
  createIndexedSession,
  createTokenUsage,
  dedupeTraceEvents,
  extractMessages,
  firstQuestion,
  firstStringField,
  isRecord,
  joinNonEmpty,
  mcpDurationAttribute,
  mcpResultStatus,
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
  ClaudeAppSessionFile,
  ClaudeConversationLine,
  ClaudeSessionIndexFile,
  CodexConversationLine,
  CodexHistoryMode,
  LoadedSession,
  SessionFormat,
  SessionMessage,
  SessionSource,
  SessionTraceEvent,
  TokenUsage,
  TokenUsageEvent,
} from "./types";

const CODEX_APP_ORIGINATORS = new Set(["Codex Desktop", "codex_work_desktop"]);
const CODEX_FUNCTION_OUTPUT_MARKER = Buffer.from('"type":"function_call_output"');
const CODEX_CUSTOM_TOOL_OUTPUT_MARKER = Buffer.from('"type":"custom_tool_call_output"');
const CODEX_INLINE_IMAGE_MARKER = Buffer.from('"image_url":"data:image/');
const TCLAUDE_DIR = ".tclaude";
const TCODEX_DIR = ".tcodex";
const CODEBUDDY_DIR = ".codebuddy";
const WORKBUDDY_DIR = ".workbuddy";
const CODEX_WORKSPACE_PLACEHOLDER = /^<[^>]+>$/u;

function resolveKimiCodeRoot(homeDir: string, options: SessionLoadOptions): string {
  return options.homeDir === undefined
    ? process.env.KIMI_CODE_HOME?.trim() || path.join(homeDir, KIMI_CODE_DIR)
    : path.join(homeDir, KIMI_CODE_DIR);
}

interface CodexSessionMeta {
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
}

export function parseCodexSessionMetaLine(parsed: unknown): CodexSessionMeta | null {
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

function readCodexSessionMetaHint(filePath: string): CodexSessionMeta | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0]?.trim();
    return firstLine ? parseCodexSessionMetaLine(JSON.parse(firstLine)) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readClaudeSubagentParentSessionHint(filePath: string, fallbackParentSessionId: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8", 0, bytesRead).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          isRecord(parsed)
          && ("sessionId" in parsed || "agentId" in parsed)
        ) {
          return stringField(parsed, "sessionId").trim() || fallbackParentSessionId;
        }
      } catch {
        // Continue looking for the relation row in the bounded prefix.
      }
    }
  } catch {
    return fallbackParentSessionId;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return fallbackParentSessionId;
}

function codexSessionSource(
  meta: CodexSessionMeta | null,
  sourceOverride: SessionSource | undefined,
  stepcodeSessionAgents: ReadonlyMap<string, "claude" | "codex"> | undefined,
): SessionSource {
  if (sourceOverride) return sourceOverride;
  if (meta && stepcodeSessionAgents?.get(meta.id) === "codex") return "stepcode-codex";
  return meta && CODEX_APP_ORIGINATORS.has(meta.originator || "") ? "codex-app" : "codex-cli";
}

function findCodexSessionMeta(
  rows: unknown[],
): CodexSessionMeta | null {
  let result: CodexSessionMeta | null = null;
  for (const row of rows) {
    const parsed = parseCodexSessionMetaLine(row);
    if (!parsed) continue;
    if (!result) {
      result = parsed;
      continue;
    }
    if (!usableCodexProjectPath(result.projectPath) && parsed.projectPath) result.projectPath = parsed.projectPath;
    if (!result.ts) result.ts = parsed.ts;
    if (!result.title) result.title = parsed.title;
    if (!result.gitBranch) result.gitBranch = parsed.gitBranch;
    if (!result.originator) result.originator = parsed.originator;
    result.isSubagent ||= parsed.isSubagent;
    if (!result.parentSessionId) result.parentSessionId = parsed.parentSessionId;
    if (!result.agentPath) result.agentPath = parsed.agentPath;
    if (parsed.historyMode === "paginated") result.historyMode = "paginated";
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

function extractTraceEvents(rows: unknown[], format: SessionFormat): SessionTraceEvent[] {
  if (format === "claude") return dedupeTraceEvents(extractClaudeTraceEvents(rows));
  if (format === "codex") return dedupeCodexTraceEvents(extractCodexTraceEvents(rows));
  return [];
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

function firstClaudeGitBranch(rows: unknown[]): string | null {
  for (const row of rows) {
    if (!row || typeof row !== "object" || !("gitBranch" in row)) continue;
    const branch = (row as ClaudeConversationLine).gitBranch?.trim();
    if (branch) return branch;
  }
  return null;
}

// CodeBuddy rows do not currently embed gitBranch, so derive it from the
// session working directory when that directory belongs to a Git repository.
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
      gitDir = path.isAbsolute(gitDirRef)
        ? gitDirRef
        : path.resolve(path.dirname(gitPath), gitDirRef);
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

export function loadCodexSessions(codexDir = path.join(os.homedir(), ".codex"), sourceOverride?: SessionSource): LoadedSession[] {
  return [...loadCodexSessionsIterator(codexDir, sourceOverride)];
}

interface StreamedCodexTurn {
  messages: SessionMessage[];
  traceEvents: TraceEventDraft[];
  hasUserMessage: boolean;
  sourceTurnIds: Set<string>;
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

function createLoadedCodexSession(
  filePath: string,
  meta: CodexSessionMeta,
  messages: SessionMessage[],
  tokenEvents: TokenUsageEvent[],
  traceEvents: SessionTraceEvent[],
  options: {
    title?: string;
    updatedAt?: string;
    sourceOverride?: SessionSource;
    stepcodeSessionAgents?: ReadonlyMap<string, "claude" | "codex">;
    stat?: VirtualSessionFileStat;
  },
  codexIncrementalState?: LoadedSession["codexIncrementalState"],
): LoadedSession {
  const tokenUsage = tokenUsageFromEvents(tokenEvents);
  const question = firstQuestion(messages);
  const source = codexSessionSource(meta, options.sourceOverride, options.stepcodeSessionAgents);
  const session = createIndexedSession({
    keyPrefix: source === "tcodex-cli" ? "tcodex" : source === "stepcode-codex" ? "stepcode" : "codex",
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
  meta: CodexSessionMeta;
  messages: SessionMessage[];
  tokenEvents: TokenUsageEvent[];
  traceEvents: SessionTraceEvent[];
  codexIncrementalState: NonNullable<LoadedSession["codexIncrementalState"]>;
  committedOffset: number;
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
  let meta: CodexSessionMeta | null = base ? {
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
          if (!Number.isSafeInteger(numTurns) || (numTurns as number) <= 0 || (numTurns as number) > turns.length) invalidRollback = true;
          else {
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
      const visibleMessages = invalidRollback ? allMessages : [...preamble.messages, ...turns.flatMap((turn) => turn.messages)];
      const visibleTraces = invalidRollback ? allTraceEvents : [...preamble.traceEvents, ...turns.flatMap((turn) => turn.traceEvents)];
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
    const metaHint = readCodexSessionMetaHint(filePath);
    if (shouldSkipFile(
      options,
      filePath,
      stat,
      indexStat.mtimeMs,
      codexSessionSource(metaHint, sourceOverride, options.stepcodeSessionAgents),
    )) continue;
    const incrementalBase = options.incrementalCodexSessions?.get(filePath);
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
      stepcodeSessionAgents: options.stepcodeSessionAgents,
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
    const metaHint = readCodexSessionMetaHint(filePath);
    if (shouldSkipFile(
      options,
      filePath,
      stat,
      indexStat.mtimeMs,
      codexSessionSource(metaHint, sourceOverride, options.stepcodeSessionAgents),
    )) continue;
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
      stepcodeSessionAgents: options.stepcodeSessionAgents,
      stat: { ...stat, size: scanned.committedOffset },
    }, scanned.codexIncrementalState);
  }
}

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function loadClaudeCliSessionRows(
  filePath: string,
  rows: unknown[],
  options: {
    rawId?: string;
    cwd?: string;
    startedAt?: number;
    source?: SessionSource;
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
  const source = options.source
    ?? (options.stepcodeAgent === "claude" ? "stepcode-claude" : "claude-cli");
  return {
    session: createIndexedSession({
      keyPrefix: source === "tclaude-cli"
        ? "tclaude"
        : source === "stepcode-claude"
          ? "stepcode-claude"
          : "claude",
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

export function loadClaudeCliSessions(claudeDir = path.join(os.homedir(), ".claude"), source: SessionSource = "claude-cli"): LoadedSession[] {
  return [...loadClaudeCliSessionsIterator(claudeDir, source)];
}

export function* loadClaudeCliSessionsIterator(
  claudeDir = path.join(os.homedir(), ".claude"),
  source: SessionSource | null = "claude-cli",
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
      const sessionSource = source
        ?? (options.stepcodeSessionAgents?.get(rawId) === "claude" ? "stepcode-claude" : "claude-cli");
      if (shouldSkipFile(options, filePath, stat, indexMtimeBySessionId.get(rawId) ?? 0, sessionSource)) continue;
      const loaded = loadClaudeCliSessionRows(filePath, readJsonl(filePath), {
        rawId,
        cwd: index.get(rawId)?.cwd,
        startedAt: index.get(rawId)?.startedAt,
        source: sessionSource,
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
        const parentSessionIdHint = readClaudeSubagentParentSessionHint(filePath, parentEntry.name);
        const sessionSource = source
          ?? (options.stepcodeSessionAgents?.get(parentSessionIdHint) === "claude" ? "stepcode-claude" : "claude-cli");
        if (shouldSkipFile(options, filePath, stat, 0, sessionSource)) continue;
        const rows = readJsonl(filePath);
        const relationRow = rows.find(
          (row): row is ClaudeConversationLine => Boolean(row && typeof row === "object" && ("sessionId" in row || "agentId" in row)),
        );
        const rawId = relationRow?.agentId || file.replace(/\.jsonl$/, "").replace(/^agent-?/, "");
        const parentSessionId = relationRow?.sessionId || parentEntry.name;
        const loaded = loadClaudeCliSessionRows(filePath, rows, {
          rawId,
          cwd: index.get(parentSessionId)?.cwd,
          source: sessionSource,
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

export function loadDefaultSessions(options: SessionLoadOptions = {}): LoadedSession[] {
  return [...loadDefaultSessionsIterator(options)];
}

export function loadStepcodeSessionAgents(homeDir: string): Map<string, "claude" | "codex"> {
  const agents = new Map<string, "claude" | "codex">();
  const sessionsDir = path.join(homeDir, ".stepcode", "sessions");
  if (!fs.existsSync(sessionsDir)) return agents;
  for (const file of fs.readdirSync(sessionsDir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const row of readJsonl(path.join(sessionsDir, file))) {
      if (!isRecord(row)) continue;
      const nativeSessionId = stringField(row, "ccSessionId").trim();
      const agent = stringField(row, "agent").trim();
      if (nativeSessionId && (agent === "claude" || agent === "codex")) {
        agents.set(nativeSessionId, agent);
      }
    }
  }
  return agents;
}

function sessionRootsMatch(firstDir: string, secondDir: string): boolean {
  try {
    return fs.realpathSync(path.join(firstDir, "sessions"))
      === fs.realpathSync(path.join(secondDir, "sessions"));
  } catch {
    return false;
  }
}

export function* loadDefaultSessionsIterator(options: SessionLoadOptions = {}): Generator<LoadedSession> {
  const homeDir = options.homeDir ?? os.homedir();
  const stepcodeSessionAgents = options.includeStepcode
    ? loadStepcodeSessionAgents(homeDir)
    : undefined;
  const effectiveOptions = { ...options, stepcodeSessionAgents };
  const nativeClaudeDir = path.join(homeDir, ".claude");
  yield* loadClaudeCliSessionsIterator(nativeClaudeDir, null, effectiveOptions);
  yield* loadClaudeAppSessionsIterator(
    path.join(homeDir, "Library", "Application Support", "Claude", "claude-code-sessions"),
    path.join(homeDir, ".claude"),
    effectiveOptions,
  );
  const nativeCodexDir = path.join(homeDir, ".codex");
  const stepcodeCodexDir = path.join(homeDir, ".stepcode", "codex");
  yield* loadCodexSessionsIterator(nativeCodexDir, undefined, effectiveOptions);
  if (options.includeStepcode && !sessionRootsMatch(nativeCodexDir, stepcodeCodexDir)) {
    yield* loadCodexSessionsIterator(stepcodeCodexDir, undefined, effectiveOptions);
  }
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
  if (options.includePi) yield* loadPiSessionsIterator(path.join(homeDir, PI_SESSIONS_DIR), options);
  if (options.includeKimiCli) yield* loadKimiSessionsIterator(
    path.join(homeDir, KIMI_LEGACY_DIR),
    resolveKimiCodeRoot(homeDir, options),
    options,
  );
  if (options.includeTclaude) yield* loadClaudeCliSessionsIterator(path.join(homeDir, TCLAUDE_DIR), "tclaude-cli", options);
  if (options.includeTcodex) yield* loadCodexSessionsIterator(path.join(homeDir, TCODEX_DIR), "tcodex-cli", options);
  if (options.includeCodeBuddyCli) yield* loadCodeBuddyCliSessionsIterator(path.join(homeDir, CODEBUDDY_DIR), options);
  if (options.includeWorkBuddy) yield* loadWorkBuddySessionsIterator(path.join(homeDir, WORKBUDDY_DIR), options);
}

export async function* loadDefaultSessionsAsyncIterator(options: SessionLoadOptions = {}): AsyncGenerator<LoadedSession> {
  const homeDir = options.homeDir ?? os.homedir();
  const stepcodeSessionAgents = options.includeStepcode
    ? loadStepcodeSessionAgents(homeDir)
    : undefined;
  const effectiveOptions = { ...options, stepcodeSessionAgents };
  const nativeClaudeDir = path.join(homeDir, ".claude");
  yield* loadClaudeCliSessionsIterator(nativeClaudeDir, null, effectiveOptions);
  yield* loadClaudeAppSessionsIterator(
    path.join(homeDir, "Library", "Application Support", "Claude", "claude-code-sessions"),
    path.join(homeDir, ".claude"),
    effectiveOptions,
  );
  const nativeCodexDir = path.join(homeDir, ".codex");
  const stepcodeCodexDir = path.join(homeDir, ".stepcode", "codex");
  yield* loadCodexSessionsAsyncIterator(nativeCodexDir, undefined, effectiveOptions);
  if (options.includeStepcode && !sessionRootsMatch(nativeCodexDir, stepcodeCodexDir)) {
    yield* loadCodexSessionsAsyncIterator(stepcodeCodexDir, undefined, effectiveOptions);
  }
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
  if (options.includePi) yield* loadPiSessionsIterator(path.join(homeDir, PI_SESSIONS_DIR), options);
  if (options.includeKimiCli) yield* loadKimiSessionsIterator(
    path.join(homeDir, KIMI_LEGACY_DIR),
    resolveKimiCodeRoot(homeDir, options),
    options,
  );
  if (options.includeTclaude) yield* loadClaudeCliSessionsIterator(path.join(homeDir, TCLAUDE_DIR), "tclaude-cli", options);
  if (options.includeTcodex) yield* loadCodexSessionsAsyncIterator(path.join(homeDir, TCODEX_DIR), "tcodex-cli", options);
  if (options.includeCodeBuddyCli) yield* loadCodeBuddyCliSessionsIterator(path.join(homeDir, CODEBUDDY_DIR), options);
  if (options.includeWorkBuddy) yield* loadWorkBuddySessionsIterator(path.join(homeDir, WORKBUDDY_DIR), options);
}
