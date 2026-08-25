import type {
  CodexHistoryMode,
  CodexIncrementalState,
  SessionMessage,
  SessionTraceEvent,
} from "../types";
import { truncateTraceDetail } from "../trace-detail";
import { sanitizeCodexTraceValue } from "./codex-trace-value";

type TraceEventDraft = Omit<SessionTraceEvent, "index">;

export type NormalizedCodexFact =
  | {
      kind: "message";
      sourceTurnId: string | null;
      phase: SessionMessage["phase"];
      sourceRecordId: string | null;
      rawType: "response_item.message";
    }
  | {
      kind: "turn_lifecycle";
      event: TraceEventDraft;
    };

export interface CodexRolloutRecordResult {
  message: Extract<NormalizedCodexFact, { kind: "message" }> | null;
  completedMessage: {
    role: SessionMessage["role"];
    content: string;
    timestamp: string;
    sourceTurnId: string | null;
    phase: Exclude<SessionMessage["phase"], undefined>;
    sourceRecordId: string;
    replacesSourceRecordId: string;
  } | null;
  sourceTurnId: string | null;
  traceEvents: TraceEventDraft[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function unixSecondsToIso(value: unknown): string | null {
  const seconds = nonNegativeNumber(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowTimestamp(row: Record<string, unknown>, preferred: unknown): string {
  return unixSecondsToIso(preferred) || stringValue(row.timestamp);
}

function historyMode(value: unknown): CodexHistoryMode {
  return value === "paginated" ? "paginated" : "legacy";
}

function responseMessageContext(
  payload: Record<string, unknown>,
): Extract<NormalizedCodexFact, { kind: "message" }> | null {
  if (payload.type !== "message") return null;
  const metadata = record(payload.internal_chat_message_metadata_passthrough);
  const explicitTurnId = stringValue(metadata?.turn_id) || null;
  const rawPhase = stringValue(payload.phase);
  const phase = rawPhase === "commentary" || rawPhase === "final_answer" ? rawPhase : null;
  const itemId = stringValue(payload.id);
  return {
    kind: "message",
    sourceTurnId: explicitTurnId,
    phase,
    sourceRecordId: itemId ? `response_item:${itemId}` : null,
    rawType: "response_item.message",
  };
}

function errorDetail(value: unknown): string {
  const error = record(value);
  if (!error) return stringValue(value);
  return stringValue(error.message) || stringValue(error.error) || "";
}

function normalizeItemType(value: string): string {
  return value.replaceAll(/[^a-z0-9]/giu, "").toLocaleLowerCase();
}

function completedItem(value: unknown): { type: string; payload: Record<string, unknown> } | null {
  const item = record(value);
  if (!item) return null;
  const taggedType = stringValue(item.type);
  if (taggedType) return { type: normalizeItemType(taggedType), payload: item };
  for (const [key, payload] of Object.entries(item)) {
    const object = record(payload);
    if (object) return { type: normalizeItemType(key), payload: object };
  }
  return null;
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(collectText);
  const object = record(value);
  if (!object) return [];
  if (typeof object.text === "string") return object.text ? [object.text] : [];
  return Object.entries(object)
    .filter(([key]) => !key.toLocaleLowerCase().includes("encrypted"))
    .flatMap(([, nested]) => collectText(nested));
}

function isJavascriptIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[a-z0-9_$]/iu.test(value);
}

function skipJavascriptQuotedText(input: string, start: number): number {
  const quote = input[start];
  let index = start + 1;
  while (index < input.length) {
    if (input[index] === "\\") {
      index += 2;
      continue;
    }
    if (input[index] === quote) return index + 1;
    index += 1;
  }
  return input.length;
}

function skipJavascriptComment(input: string, start: number): number | null {
  if (input[start] !== "/") return null;
  if (input[start + 1] === "/") {
    const end = input.indexOf("\n", start + 2);
    return end === -1 ? input.length : end + 1;
  }
  if (input[start + 1] === "*") {
    const end = input.indexOf("*/", start + 2);
    return end === -1 ? input.length : end + 2;
  }
  return null;
}

function skipJavascriptWhitespace(input: string, start: number): number {
  let index = start;
  while (/\s/u.test(input[index] || "")) index += 1;
  return index;
}

function codexExecToolNameAt(input: string, start: number): { name: string; end: number } | null {
  if (input.slice(start, start + 5) !== "tools") return null;
  let previousIndex = start - 1;
  while (/\s/u.test(input[previousIndex] || "")) previousIndex -= 1;
  if (
    isJavascriptIdentifierCharacter(input[start - 1])
    || input[previousIndex] === "."
    || isJavascriptIdentifierCharacter(input[start + 5])
  ) {
    return null;
  }

  let index = skipJavascriptWhitespace(input, start + 5);
  let bracketAccess = false;
  if (input.slice(index, index + 2) === "?.") index += 2;
  else if (input[index] === ".") index += 1;
  else if (input[index] === "[") {
    bracketAccess = true;
    index += 1;
  } else return null;

  index = skipJavascriptWhitespace(input, index);
  let name = "";
  if (bracketAccess) {
    const quote = input[index];
    if (quote !== "\"" && quote !== "'") return null;
    const propertyEnd = skipJavascriptQuotedText(input, index);
    name = input.slice(index + 1, propertyEnd - 1);
    if (!/^[a-z_$][a-z0-9_$]*$/iu.test(name)) return null;
    index = skipJavascriptWhitespace(input, propertyEnd);
    if (input[index] !== "]") return null;
    index = skipJavascriptWhitespace(input, index + 1);
  } else {
    const nameStart = index;
    while (isJavascriptIdentifierCharacter(input[index])) index += 1;
    name = input.slice(nameStart, index);
    if (!/^[a-z_$][a-z0-9_$]*$/iu.test(name)) return null;
    index = skipJavascriptWhitespace(input, index);
  }

  if (input.slice(index, index + 2) === "?.") index = skipJavascriptWhitespace(input, index + 2);
  return input[index] === "(" ? { name, end: index + 1 } : null;
}

export function extractCodexExecToolNames(input: unknown): string[] {
  if (typeof input !== "string") return [];
  const names: string[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (index < input.length) {
    const character = input[index];
    if (character === "\"" || character === "'" || character === "`") {
      index = skipJavascriptQuotedText(input, index);
      continue;
    }
    const commentEnd = skipJavascriptComment(input, index);
    if (commentEnd !== null) {
      index = commentEnd;
      continue;
    }
    const tool = codexExecToolNameAt(input, index);
    if (tool) {
      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        names.push(tool.name);
      }
      index = tool.end;
      continue;
    }
    index += 1;
  }
  return names;
}

const COMPACTION_BINARY_FIELDS = new Set([
  "audio_url",
  "b64_json",
  "data",
  "file_data",
  "image_url",
  "screenshot",
]);
const COMPACTION_BINARY_CHILD_FIELDS = new Set([
  "b64",
  "b64_json",
  "base64",
  "data",
  "file_data",
  "src",
  "url",
]);
const COMPACTION_UNKNOWN_BINARY_MIN_CHARS = 64 * 1_024;
const COMPACTION_MARKER_EARLY_TOLERANCE_MS = 1_000;
const COMPACTION_MARKER_LATE_TOLERANCE_MS = 30_000;
const COMPACTION_MISSING_TURN_MATCH_WINDOW_MS = 1_000;

function sanitizeCompactionJson(value: unknown, key = "", binaryContext = false): unknown {
  const normalizedKey = key.toLocaleLowerCase();
  const insideBinaryField = binaryContext || COMPACTION_BINARY_FIELDS.has(normalizedKey);
  if (key.toLocaleLowerCase().includes("encrypted")) {
    if (value === null || value === undefined || value === "") return value;
    if (typeof value === "boolean" || typeof value === "number") return value;
    return "[encrypted content omitted]";
  }
  if (typeof value === "string") {
    const looksLikeDataUrl = value.slice(0, 5).toLocaleLowerCase() === "data:";
    const looksLikeEncodedBinary = value.length > 1_024 && /^[a-z0-9+/_=\r\n-]+$/iu.test(value);
    const unknownFieldBinaryFallback = value.length >= COMPACTION_UNKNOWN_BINARY_MIN_CHARS;
    if (looksLikeDataUrl || (looksLikeEncodedBinary && (insideBinaryField || unknownFieldBinaryFallback))) {
      return `[binary omitted: ${value.length} characters]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCompactionJson(item, key, insideBinaryField));
  }
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object).map(([nestedKey, nestedValue]) => [
      nestedKey,
      sanitizeCompactionJson(
        nestedValue,
        nestedKey,
        insideBinaryField && COMPACTION_BINARY_CHILD_FIELDS.has(nestedKey.toLocaleLowerCase()),
      ),
    ]),
  );
}

function detailSection(label: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const text = typeof value === "string" ? value : JSON.stringify(sanitizeCodexTraceValue(value), null, 2);
  return text ? `${label}:\n${text}` : "";
}

export function formatCodexToolDetail(input: unknown, output: unknown): string {
  return truncateTraceDetail(
    [detailSection("input", input), detailSection("output", output)].filter(Boolean).join("\n\n"),
  );
}

function completedTimestamp(row: Record<string, unknown>, payload: Record<string, unknown>): string {
  const milliseconds = nonNegativeNumber(payload.completed_at_ms);
  if (milliseconds !== null && milliseconds > 0) return new Date(milliseconds).toISOString();
  return stringValue(row.timestamp);
}

function itemTimingAttributes(
  payload: Record<string, unknown>,
  sourceRecordId: string,
  rawType: string,
): Record<string, unknown> {
  const startedAtMs = nonNegativeNumber(payload.started_at_ms);
  const completedAtMs = nonNegativeNumber(payload.completed_at_ms);
  const attributes: Record<string, unknown> = {
    codex: { sourceItemId: sourceRecordId, rawType },
  };
  if (startedAtMs !== null && startedAtMs > 0) attributes.startedAt = new Date(startedAtMs).toISOString();
  if (completedAtMs !== null && completedAtMs > 0) attributes.endedAt = new Date(completedAtMs).toISOString();
  if (startedAtMs !== null && completedAtMs !== null && completedAtMs >= startedAtMs) {
    attributes.durationMs = completedAtMs - startedAtMs;
  }
  return attributes;
}

function toolStatus(value: unknown): SessionTraceEvent["status"] {
  const status = stringValue(value).toLocaleLowerCase();
  if (status === "in_progress" || status === "inprogress" || status === "running") return "running";
  if (status === "failed" || status === "error") return "failed";
  if (status === "declined" || status === "aborted" || status === "cancelled") return "aborted";
  if (status === "completed" || status === "success" || status === "succeeded") return "completed";
  return "unknown";
}

function itemToolTrace(
  row: Record<string, unknown>,
  wrapper: Record<string, unknown>,
  type: string,
  item: Record<string, unknown>,
  sourceTurnId: string | null,
): TraceEventDraft | null {
  const itemId = stringValue(item.id);
  if (!itemId) return null;
  const sourceRecordId = `item_completed:${itemId}`;
  const attributes = itemTimingAttributes(wrapper, sourceRecordId, type);
  if (item.duration !== null && item.duration !== undefined) {
    attributes.itemDuration = sanitizeCodexTraceValue(item.duration);
  }
  let title = "";
  let input: unknown;
  let output: unknown;
  let eventType = "";
  let status = toolStatus(item.status);

  if (type === "commandexecution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : stringValue(item.command);
    title = command ? `shell · ${command}` : "shell";
    eventType = "codex.command_execution";
    input = { command, cwd: item.cwd, parsedCommand: item.parsed_cmd };
    output = {
      stdout: item.stdout,
      stderr: item.stderr,
      aggregatedOutput: item.aggregated_output,
      formattedOutput: item.formatted_output,
      exitCode: item.exit_code,
    };
  } else if (type === "dynamictoolcall") {
    const namespace = stringValue(item.namespace);
    const tool = stringValue(item.tool) || "dynamic tool";
    const nestedTools = tool === "exec" ? extractCodexExecToolNames(item.arguments) : [];
    const nestedToolSummary = nestedTools.map((name) => name.replaceAll("__", ".")).join(", ");
    const qualifiedTool = namespace ? `${namespace}.${tool}` : tool;
    title = nestedToolSummary ? `${qualifiedTool} · ${nestedToolSummary}` : qualifiedTool;
    eventType = "codex.dynamic_tool";
    input = item.arguments;
    output = item.error || item.content_items || { success: item.success };
    if (nestedTools.length > 0) attributes.nestedTools = nestedTools;
    if (item.success === false) status = "failed";
  } else if (type === "mcptoolcall") {
    title = [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join(".") || "MCP tool";
    eventType = "codex.mcp_tool";
    input = item.arguments;
    output = item.error || item.result;
  } else if (type === "websearch") {
    title = stringValue(item.query) ? `web search · ${stringValue(item.query)}` : "web search";
    eventType = "codex.web_search";
    input = { query: item.query, action: item.action };
    output = item.results;
    status = "completed";
  } else if (type === "imageview") {
    title = stringValue(item.path) ? `view image · ${stringValue(item.path)}` : "view image";
    eventType = "codex.image_view";
    input = { path: item.path };
    status = "completed";
  } else if (type === "imagegeneration") {
    title = "image generation";
    eventType = "codex.image_generation";
    input = { revisedPrompt: item.revised_prompt };
    output = { savedPath: item.saved_path };
  } else if (type === "extension") {
    const extensionKind = stringValue(item.kind);
    if (extensionKind === "image_gen.generation") {
      title = "image generation";
      eventType = "codex.image_generation";
      input = { revisedPrompt: item.revisedPrompt ?? item.revised_prompt };
      output = { savedPath: item.savedPath ?? item.saved_path };
    } else if (extensionKind === "web.search") {
      title = stringValue(item.query) ? `web search · ${stringValue(item.query)}` : "web search";
      eventType = "codex.web_search";
      input = { query: item.query, action: item.action };
      output = item.results;
      status = "completed";
    } else if (extensionKind === "clock.sleep") {
      const durationMs = nonNegativeNumber(item.durationMs ?? item.duration_ms);
      title = durationMs === null ? "wait" : `wait · ${durationMs} ms`;
      eventType = "codex.extension.sleep";
      input = durationMs === null ? null : { durationMs };
      status = "completed";
    } else {
      return null;
    }
  } else if (type === "filechange") {
    title = "apply patch";
    eventType = "codex.file_change";
    input = { changes: item.changes, autoApproved: item.auto_approved };
    output = { stdout: item.stdout, stderr: item.stderr };
    if (status === "unknown") status = "completed";
  } else {
    return null;
  }

  attributes.input = sanitizeCodexTraceValue(input);
  attributes.output = sanitizeCodexTraceValue(output);
  return {
    kind: "tool_result",
    source: "codex",
    title,
    detail: formatCodexToolDetail(input, output),
    timestamp: completedTimestamp(row, wrapper),
    callId: itemId,
    eventType,
    status,
    sourceTurnId,
    attributes,
  };
}

type AgentMessageDirection = "incoming" | "outgoing" | "unknown";
type AgentMessageType = "new_task" | "message" | "final_answer" | "unknown";

function agentMessageType(content: unknown): AgentMessageType {
  if (!Array.isArray(content)) return "unknown";
  const text: string[] = [];
  for (const value of content) {
    const part = record(value);
    if (!part) continue;
    const type = normalizeItemType(stringValue(part.type));
    if (type === "inputtext" && typeof part.text === "string") text.push(part.text);
  }
  const joined = text.join("\n").trim();
  const messageTypeMatch = joined.match(/^Message Type:\s*(NEW_TASK|MESSAGE|FINAL_ANSWER)\b/iu);
  return messageTypeMatch?.[1]?.toLocaleUpperCase() === "NEW_TASK"
    ? "new_task"
    : messageTypeMatch?.[1]?.toLocaleUpperCase() === "MESSAGE"
      ? "message"
      : messageTypeMatch?.[1]?.toLocaleUpperCase() === "FINAL_ANSWER"
        ? "final_answer"
        : "unknown";
}

function agentMessageDirection(author: string, recipient: string, agentPath: string | null): AgentMessageDirection {
  if (!agentPath) return "unknown";
  if (recipient === agentPath && author !== agentPath) return "incoming";
  if (author === agentPath && recipient !== agentPath) return "outgoing";
  return "unknown";
}

function contextAttributes(value: unknown): Record<string, unknown> {
  const source = record(value) ?? {};
  return sanitizeCodexTraceValue({
    model: source.model,
    cwd: source.cwd,
    currentDate: source.current_date ?? source.currentDate,
    timezone: source.timezone,
    approvalPolicy: source.approval_policy ?? source.approvalPolicy,
    approvalsReviewer: source.approvals_reviewer ?? source.approvalsReviewer,
    sandboxPolicy: source.sandbox_policy ?? source.sandboxPolicy,
    permissionProfile: source.permission_profile ?? source.permissionProfile,
    reasoningEffort: source.reasoning_effort ?? source.reasoningEffort ?? source.effort,
    reasoningSummary: source.reasoning_summary ?? source.reasoningSummary ?? source.summary,
    personality: source.personality,
    collaborationMode: source.collaboration_mode ?? source.collaborationMode,
    multiAgentVersion: source.multi_agent_version ?? source.multiAgentVersion,
    realtimeActive: source.realtime_active ?? source.realtimeActive,
    network: source.network,
  }) as Record<string, unknown>;
}

function richItemTrace(
  row: Record<string, unknown>,
  wrapper: Record<string, unknown>,
  type: string,
  item: Record<string, unknown>,
  sourceTurnId: string | null,
): TraceEventDraft | null {
  const itemId = stringValue(item.id);
  if (!itemId) return null;
  const attributes = itemTimingAttributes(wrapper, `item_completed:${itemId}`, type);
  let title = "";
  let detail = "";
  let eventType = "";
  let status: SessionTraceEvent["status"] = "completed";
  let callId: string | null = null;

  if (type === "reasoning") {
    detail = collectText(item.summary_text ?? item.summary).join("\n").trim();
    if (!detail) return null;
    title = "Reasoning summary";
    eventType = "codex.reasoning_summary";
  } else if (type === "plan") {
    detail = stringValue(item.text).trim();
    if (!detail) return null;
    title = "Plan";
    eventType = "codex.plan";
  } else if (type === "enteredreviewmode") {
    title = "Entered review mode";
    eventType = "codex.review.entered";
    detail = formatCodexToolDetail({
      target: item.target,
      hint: item.user_facing_hint ?? item.userFacingHint,
    }, null);
  } else if (type === "exitedreviewmode") {
    title = "Exited review mode";
    eventType = "codex.review.exited";
    detail = formatCodexToolDetail(null, item.review_output ?? item.reviewOutput);
  } else if (type === "collabagenttoolcall") {
    const tool = stringValue(item.tool) || "agent collaboration";
    title = `agent · ${tool}`;
    eventType = "codex.collaboration.tool";
    status = toolStatus(item.status);
    callId = itemId;
    const collab = sanitizeCodexTraceValue({
      tool: item.tool,
      senderThreadId: item.sender_thread_id ?? item.senderThreadId,
      receiverThreadIds: item.receiver_thread_ids ?? item.receiverThreadIds,
      receiverAgents: item.receiver_agents ?? item.receiverAgents,
      model: item.model,
      agentsStates: item.agents_states ?? item.agentsStates,
    });
    attributes.collaboration = collab;
    detail = formatCodexToolDetail(collab, null);
  } else if (type === "subagentactivity") {
    const activity = stringValue(item.kind) || "activity";
    title = `subagent · ${activity}`;
    eventType = "codex.collaboration.activity";
    const collaboration = sanitizeCodexTraceValue({
      kind: item.kind,
      agentThreadId: item.agent_thread_id ?? item.agentThreadId,
      agentPath: item.agent_path ?? item.agentPath,
    });
    attributes.collaboration = collaboration;
    detail = formatCodexToolDetail(collaboration, null);
  } else if (type === "contextcompaction") {
    title = "Context compacted";
    eventType = "codex.context.compaction";
  } else {
    return null;
  }

  return {
    kind: "event",
    source: "codex",
    title,
    detail: truncateTraceDetail(detail),
    timestamp: completedTimestamp(row, wrapper),
    callId,
    eventType,
    status,
    sourceTurnId,
    attributes,
  };
}

function richResponseTrace(
  row: Record<string, unknown>,
  payload: Record<string, unknown>,
  sourceTurnId: string | null,
  communication: { agentPath: string | null; triggerTurn: boolean | null },
): TraceEventDraft | null {
  const type = stringValue(payload.type);
  const responseItemId = stringValue(payload.id);
  const codex = {
    rawType: type,
    ...(responseItemId ? { sourceItemId: `response_item:${responseItemId}` } : {}),
  };
  if (type === "reasoning") {
    const detail = collectText(payload.summary).join("\n").trim();
    if (!detail) return null;
    return {
      kind: "event",
      source: "codex",
      title: "Reasoning summary",
      detail: truncateTraceDetail(detail),
      timestamp: stringValue(row.timestamp),
      callId: null,
      eventType: "codex.reasoning_summary",
      status: "completed",
      sourceTurnId,
      attributes: { codex },
    };
  }
  if (type === "agent_message") {
    const author = stringValue(payload.author);
    const recipient = stringValue(payload.recipient);
    if (!payload.content && !author && !recipient) return null;
    const direction = agentMessageDirection(author, recipient, communication.agentPath);
    const messageType = agentMessageType(payload.content);
    const output = sanitizeCodexTraceValue({
      message: payload,
      direction,
      triggerTurn: communication.triggerTurn,
      messageType,
    }, true);
    const attributes = {
      codex,
      collaboration: sanitizeCodexTraceValue({
        author,
        recipient,
        direction,
        triggerTurn: communication.triggerTurn,
        messageType,
      }),
      output,
    };
    return {
      kind: "event",
      source: "codex",
      title: "Agent message",
      detail: truncateTraceDetail(JSON.stringify(output, null, 2)),
      timestamp: stringValue(row.timestamp),
      callId: null,
      eventType: "codex.collaboration.message",
      status: "completed",
      sourceTurnId,
      attributes,
    };
  }
  if (type === "compaction" || type === "context_compaction") {
    return {
      kind: "event",
      source: "codex",
      title: "Context compacted",
      detail: "",
      timestamp: stringValue(row.timestamp),
      callId: null,
      eventType: "codex.context.compaction",
      status: "completed",
      sourceTurnId,
      attributes: { codex },
    };
  }
  return null;
}

function compactionCheckpointTrace(
  row: Record<string, unknown>,
  payload: Record<string, unknown>,
  sourceTurnId: string | null,
): TraceEventDraft {
  const replacementHistory = Array.isArray(payload.replacement_history)
    ? payload.replacement_history
    : null;
  const itemTypes: Record<string, number> = {};
  let encryptedSummary = false;
  for (const value of replacementHistory ?? []) {
    const item = record(value);
    const type = stringValue(item?.type) || "unknown";
    const normalizedType = normalizeItemType(type);
    const encryptedContent = item?.encrypted_content ?? item?.encryptedContent;
    itemTypes[type] = (itemTypes[type] ?? 0) + 1;
    if (
      (normalizedType === "compaction"
        || normalizedType === "compactionsummary"
        || normalizedType === "contextcompaction")
      && typeof encryptedContent === "string"
      && encryptedContent.length > 0
    ) {
      encryptedSummary = true;
    }
  }
  const sanitizedPayload = sanitizeCompactionJson(payload);
  const detail = truncateTraceDetail(
    `payload:\n${JSON.stringify(sanitizedPayload, null, 2)}`,
    512 * 1_024,
  );

  return {
    kind: "event",
    source: "codex",
    title: "Context compacted",
    detail,
    timestamp: stringValue(row.timestamp),
    callId: null,
    eventType: "codex.context.compaction",
    status: "completed",
    sourceTurnId,
    attributes: {
      codex: { rawType: "compacted" },
      compaction: {
        itemCount: replacementHistory?.length ?? 0,
        itemTypes,
        opaqueCompaction: encryptedSummary,
      },
    },
  };
}

function richEventTrace(
  row: Record<string, unknown>,
  payload: Record<string, unknown>,
  sourceTurnId: string | null,
): TraceEventDraft | null {
  const type = stringValue(payload.type);
  const base = {
    kind: "event" as const,
    source: "codex" as const,
    timestamp: stringValue(row.timestamp),
    callId: null,
    status: "completed" as const,
    sourceTurnId,
  };
  if (type === "agent_reasoning") {
    const detail = stringValue(payload.text).trim();
    return detail ? {
      ...base,
      title: "Reasoning summary",
      detail: truncateTraceDetail(detail),
      eventType: "codex.reasoning_summary",
      attributes: { codex: { rawType: type } },
    } : null;
  }
  if (type === "plan_update") {
    const plan = sanitizeCodexTraceValue({
      explanation: payload.explanation,
      plan: payload.plan,
    });
    return {
      ...base,
      title: "Plan",
      detail: formatCodexToolDetail(plan, null),
      eventType: "codex.plan",
      attributes: { codex: { rawType: type }, plan },
    };
  }
  if (type === "entered_review_mode" || type === "exited_review_mode") {
    const entered = type === "entered_review_mode";
    const value = entered
      ? { target: payload.target, hint: payload.user_facing_hint ?? payload.userFacingHint }
      : payload.review_output ?? payload.reviewOutput;
    return {
      ...base,
      title: entered ? "Entered review mode" : "Exited review mode",
      detail: entered ? formatCodexToolDetail(value, null) : formatCodexToolDetail(null, value),
      eventType: entered ? "codex.review.entered" : "codex.review.exited",
      attributes: { codex: { rawType: type } },
    };
  }
  if (type === "thread_goal_updated") {
    const goal = record(payload.goal);
    const value = sanitizeCodexTraceValue({
      objective: goal?.objective,
      status: goal?.status,
      tokenBudget: goal?.tokenBudget ?? goal?.token_budget,
      tokensUsed: goal?.tokensUsed ?? goal?.tokens_used,
      timeUsedSeconds: goal?.timeUsedSeconds ?? goal?.time_used_seconds,
    });
    return {
      ...base,
      title: "Goal updated",
      detail: formatCodexToolDetail(value, null),
      eventType: "codex.goal.updated",
      attributes: { codex: { rawType: type }, goal: value },
    };
  }
  if (type === "thread_settings_applied") {
    const settings = contextAttributes(payload.thread_settings ?? payload.threadSettings);
    return {
      ...base,
      title: "Thread settings",
      detail: formatCodexToolDetail(settings, null),
      eventType: "codex.thread.settings",
      attributes: { codex: { rawType: type }, settings },
    };
  }
  if (type === "context_compacted") {
    return {
      ...base,
      title: "Context compacted",
      detail: "",
      eventType: "codex.context.compaction",
      attributes: { codex: { rawType: type } },
    };
  }
  if (type === "sub_agent_activity") {
    const collaboration = sanitizeCodexTraceValue({
      kind: payload.kind,
      agentThreadId: payload.agent_thread_id ?? payload.agentThreadId,
      agentPath: payload.agent_path ?? payload.agentPath,
    });
    return {
      ...base,
      title: `subagent · ${stringValue(payload.kind) || "activity"}`,
      detail: formatCodexToolDetail(collaboration, null),
      eventType: "codex.collaboration.activity",
      attributes: { codex: { rawType: type }, collaboration },
    };
  }
  if (type.startsWith("collab_")) {
    const action = type.replace(/^collab_/, "").replace(/_(begin|end)$/u, "").replaceAll("_", " ");
    const isEnd = type.endsWith("_end");
    const collaboration = sanitizeCodexTraceValue({
      senderThreadId: payload.sender_thread_id,
      receiverThreadId: payload.receiver_thread_id,
      receiverThreadIds: payload.receiver_thread_ids,
      newThreadId: payload.new_thread_id,
      receiverAgentNickname: payload.receiver_agent_nickname,
      receiverAgentRole: payload.receiver_agent_role,
      status: payload.status,
      statuses: payload.statuses,
      agentStatuses: payload.agent_statuses,
    });
    return {
      ...base,
      title: `agent · ${action}`,
      detail: formatCodexToolDetail(collaboration, null),
      callId: stringValue(payload.call_id) || null,
      eventType: "codex.collaboration.tool",
      status: isEnd ? toolStatus(payload.status) : "running",
      attributes: { codex: { rawType: type }, collaboration },
    };
  }
  return null;
}

function emptyResult(
  overrides: Partial<CodexRolloutRecordResult> = {},
): CodexRolloutRecordResult {
  return {
    message: null,
    completedMessage: null,
    sourceTurnId: null,
    traceEvents: [],
    ...overrides,
  };
}

function mergeTraceValue(preferred: unknown, fallback: unknown): unknown {
  const preferredRecord = record(preferred);
  const fallbackRecord = record(fallback);
  if (preferredRecord && fallbackRecord) return { ...fallbackRecord, ...preferredRecord };
  if (preferredRecord) return preferredRecord;
  if (fallbackRecord && preferred !== null && preferred !== undefined) {
    return { ...fallbackRecord, responseValue: preferred };
  }
  return preferred ?? fallback;
}

export function dedupeCodexTraceEvents(events: TraceEventDraft[]): SessionTraceEvent[] {
  const merged: TraceEventDraft[] = [];
  const callIndexes = new Map<string, number>();
  const calls = new Map<string, TraceEventDraft>();
  const terminals = new Map<string, TraceEventDraft>();
  const codexAttributes = (event: TraceEventDraft) => record(event.attributes?.codex);
  const isCompletedItem = (event: TraceEventDraft) => {
    const codex = codexAttributes(event);
    return typeof codex?.sourceItemId === "string"
      && codex.sourceItemId.startsWith("item_completed:");
  };
  const isTerminal = (event: TraceEventDraft) =>
    event.kind === "tool_result"
    || isCompletedItem(event)
    || event.status === "completed"
    || event.status === "failed"
    || event.status === "aborted";
  const terminalRank = (event: TraceEventDraft) =>
    isCompletedItem(event) ? 3 : event.kind === "event" ? 2 : 1;
  const latestTimestamp = (...values: unknown[]): string | null => {
    let latest: { value: string; milliseconds: number } | null = null;
    for (const value of values) {
      if (typeof value !== "string" && typeof value !== "number") continue;
      const milliseconds = typeof value === "number" ? value : Date.parse(value);
      if (!Number.isFinite(milliseconds)) continue;
      if (!latest || milliseconds > latest.milliseconds) {
        latest = { value: typeof value === "number" ? new Date(value).toISOString() : value, milliseconds };
      }
    }
    return latest?.value ?? null;
  };
  const semanticKeys = (event: TraceEventDraft): string[] => {
    const keys: string[] = [];
    const sourceItemId = stringValue(codexAttributes(event)?.sourceItemId);
    if (sourceItemId) {
      const separator = sourceItemId.indexOf(":");
      keys.push(`${event.eventType || event.kind}:item:${sourceItemId.slice(separator + 1)}`);
    }
    if (event.eventType === "codex.thread.settings") {
      keys.push(`${event.eventType}:${event.detail}`);
    }
    if (event.eventType === "codex.reasoning_summary") {
      const detail = event.detail.normalize("NFKC").trim().replace(/\s+/gu, " ");
      keys.push(`${event.eventType}:${event.sourceTurnId || ""}:${detail}`);
    }
    return keys;
  };
  const rank = (event: TraceEventDraft) =>
    isCompletedItem(event) ? 4 : event.kind === "tool_result" ? 3 : event.kind === "event" ? 2 : 1;

  for (const event of events) {
    if (!event.callId) {
      merged.push(event);
      continue;
    }
    if (event.kind === "tool_call" && !calls.has(event.callId)) {
      calls.set(event.callId, event);
    }
    if (isTerminal(event)) {
      const terminal = terminals.get(event.callId);
      if (!terminal || terminalRank(event) >= terminalRank(terminal)) {
        terminals.set(event.callId, event);
      }
    }
    const existingIndex = callIndexes.get(event.callId);
    if (existingIndex === undefined) {
      callIndexes.set(event.callId, merged.length);
      merged.push(event);
      continue;
    }

    const existing = merged[existingIndex];
    const primary = rank(event) >= rank(existing) ? event : existing;
    const secondary = primary === event ? existing : event;
    const call = calls.get(event.callId) ?? null;
    const terminal = terminals.get(event.callId) ?? null;
    const primaryInput = primary.attributes?.input ?? (primary.kind === "tool_call" ? primary.detail || null : null);
    const secondaryInput = secondary.attributes?.input ?? (call === secondary ? secondary.detail || null : null);
    const primaryOutput = primary.attributes?.output
      ?? (primary.kind === "tool_result" ? primary.detail || null : null);
    const secondaryOutput = secondary.attributes?.output
      ?? (secondary.kind === "tool_result" ? secondary.detail || null : null);
    const input = mergeTraceValue(primaryInput, secondaryInput);
    const output = mergeTraceValue(primaryOutput, secondaryOutput);
    const explicitStartedAt = call?.attributes?.startedAt;
    let startedAt = call ? latestTimestamp(explicitStartedAt) ?? call.timestamp : null;
    let endedAt = call && terminal
      ? latestTimestamp(
        existing.attributes?.endedAt,
        isTerminal(existing) ? existing.timestamp : null,
        event.attributes?.endedAt,
        isTerminal(event) ? event.timestamp : null,
      )
      : null;
    const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
    const endedAtMs = endedAt ? Date.parse(endedAt) : Number.NaN;
    if (Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs) && endedAtMs < startedAtMs) {
      [startedAt, endedAt] = [endedAt, startedAt];
    }
    merged[existingIndex] = {
      ...secondary,
      ...primary,
      title: isCompletedItem(primary)
        ? primary.title
        : call?.title || existing.title || primary.title,
      detail: formatCodexToolDetail(input, output),
      timestamp: terminal?.timestamp || call?.timestamp || primary.timestamp,
      kind: call ? terminal ? "tool_result" : "tool_call" : primary.kind,
      eventType: isCompletedItem(primary)
        ? primary.eventType || call?.eventType || secondary.eventType
        : call?.eventType || primary.eventType || secondary.eventType,
      status: terminal?.status || call?.status || primary.status,
      sourceTurnId: primary.sourceTurnId || secondary.sourceTurnId,
      attributes: {
        ...(secondary.attributes ?? {}),
        ...(primary.attributes ?? {}),
        ...(startedAt ? { startedAt } : {}),
        ...(endedAt ? { endedAt } : {}),
        input: sanitizeCodexTraceValue(input),
        output: sanitizeCodexTraceValue(output),
      },
    };
  }

  const normalized: TraceEventDraft[] = [];
  const semanticIndexes = new Map<string, number>();
  for (const event of merged) {
    const keys = event.callId ? [] : semanticKeys(event);
    const existingIndex = keys.map((key) => semanticIndexes.get(key)).find(
      (index): index is number => index !== undefined,
    );
    if (existingIndex === undefined) {
      for (const key of keys) semanticIndexes.set(key, normalized.length);
      normalized.push(event);
      continue;
    }
    const existing = normalized[existingIndex];
    const primary = isCompletedItem(event) ? event : existing;
    const secondary = primary === event ? existing : event;
    normalized[existingIndex] = {
      ...secondary,
      ...primary,
      attributes: {
        ...(secondary.attributes ?? {}),
        ...(primary.attributes ?? {}),
      },
    };
    for (const key of keys) semanticIndexes.set(key, existingIndex);
  }
  const compactionMarkerTypes = new Set([
    "compaction",
    "context_compaction",
    "contextcompaction",
    "context_compacted",
  ]);
  const checkpointIndexes = normalized.flatMap((event, index) => (
    event.eventType === "codex.context.compaction"
      && stringValue(codexAttributes(event)?.rawType) === "compacted"
      ? [index]
      : []
  ));
  const markerIndexes = normalized.flatMap((event, index) => {
    if (event.eventType !== "codex.context.compaction" || event.detail.trim()) return [];
    return compactionMarkerTypes.has(stringValue(codexAttributes(event)?.rawType)) ? [index] : [];
  });
  const markerCandidates = new Map<number, number[]>();
  for (const markerIndex of markerIndexes) {
    const marker = normalized[markerIndex];
    const markerTime = Date.parse(marker.timestamp);
    const candidates: Array<{ checkpointIndex: number; exactTurn: boolean; distance: number }> = [];
    for (const checkpointIndex of checkpointIndexes) {
      const checkpoint = normalized[checkpointIndex];
      const exactTurn = Boolean(
        marker.sourceTurnId
        && checkpoint.sourceTurnId
        && marker.sourceTurnId === checkpoint.sourceTurnId,
      );
      if (marker.sourceTurnId && checkpoint.sourceTurnId && !exactTurn) continue;
      const checkpointTime = Date.parse(checkpoint.timestamp);
      const timesUsable = Number.isFinite(markerTime) && Number.isFinite(checkpointTime);
      let distance = Number.POSITIVE_INFINITY;
      if (timesUsable) {
        const markerDelay = markerTime - checkpointTime;
        if (
          exactTurn
          && (markerDelay < -COMPACTION_MARKER_EARLY_TOLERANCE_MS
            || markerDelay > COMPACTION_MARKER_LATE_TOLERANCE_MS)
        ) continue;
        if (!exactTurn && Math.abs(markerDelay) > COMPACTION_MISSING_TURN_MATCH_WINDOW_MS) continue;
        distance = Math.abs(markerDelay);
      } else if (!exactTurn) continue;
      candidates.push({ checkpointIndex, exactTurn, distance });
    }
    candidates.sort((left, right) =>
      Number(right.exactTurn) - Number(left.exactTurn)
      || left.distance - right.distance
      || left.checkpointIndex - right.checkpointIndex,
    );
    markerCandidates.set(markerIndex, candidates.map((candidate) => candidate.checkpointIndex));
  }
  const markerByCheckpoint = new Map<number, number>();
  const assignMarker = (markerIndex: number, visitedCheckpoints: Set<number>): boolean => {
    for (const checkpointIndex of markerCandidates.get(markerIndex) ?? []) {
      if (visitedCheckpoints.has(checkpointIndex)) continue;
      visitedCheckpoints.add(checkpointIndex);
      const previousMarker = markerByCheckpoint.get(checkpointIndex);
      if (previousMarker === undefined || assignMarker(previousMarker, visitedCheckpoints)) {
        markerByCheckpoint.set(checkpointIndex, markerIndex);
        return true;
      }
    }
    return false;
  };
  markerIndexes
    .sort((left, right) => {
      const leftTime = Date.parse(normalized[left].timestamp);
      const rightTime = Date.parse(normalized[right].timestamp);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
      return left - right;
    })
    .forEach((markerIndex) => assignMarker(markerIndex, new Set()));
  const duplicateCompactionMarkers = new Set(markerByCheckpoint.values());
  const withoutDuplicateCompactionMarkers = normalized.filter(
    (_event, index) => !duplicateCompactionMarkers.has(index),
  );
  const reasoningSignature = (event: TraceEventDraft) =>
    `${event.sourceTurnId || ""}:${event.detail.normalize("NFKC").trim().replace(/\s+/gu, " ")}`;
  const completedReasoning = new Set(
    withoutDuplicateCompactionMarkers
      .filter((event) => event.eventType === "codex.reasoning_summary" && isCompletedItem(event))
      .map(reasoningSignature),
  );
  return withoutDuplicateCompactionMarkers
    .filter((event) =>
      event.eventType !== "codex.reasoning_summary"
      || isCompletedItem(event)
      || !completedReasoning.has(reasoningSignature(event)),
    )
    .map((event, index) => ({ ...event, index }));
}

const LEGACY_TURN_ID_PREFIX = "agent-recall:legacy-turn:";

export class CodexRolloutAccumulator {
  private currentHistoryMode: CodexHistoryMode;
  private readonly activeTurnIds = new Set<string>();
  private latestStartedTurnId: string | null = null;
  private nextLegacyTurnSequence = 1;
  private currentAgentPath: string | null;
  private pendingInterAgentCommunication: { triggerTurn: boolean } | null;

  constructor(
    state?: Pick<CodexIncrementalState, "historyMode" | "activeTurnIds" | "agentPath" | "pendingInterAgentCommunication"> & {
      sourceTurnIds?: Iterable<string | null | undefined>;
    },
  ) {
    this.currentHistoryMode = state?.historyMode ?? "legacy";
    this.currentAgentPath = state?.agentPath !== undefined ? state.agentPath : "/root";
    this.pendingInterAgentCommunication = state?.pendingInterAgentCommunication ?? null;
    for (const turnId of state?.activeTurnIds ?? []) {
      if (!turnId) continue;
      this.activeTurnIds.add(turnId);
      this.latestStartedTurnId = turnId;
      this.rememberSourceTurnId(turnId);
    }
    for (const turnId of state?.sourceTurnIds ?? []) this.rememberSourceTurnId(turnId);
  }

  get historyMode(): CodexHistoryMode {
    return this.currentHistoryMode;
  }

  getActiveTurnIds(): string[] {
    return [...this.activeTurnIds];
  }

  get agentPath(): string | null {
    return this.currentAgentPath;
  }

  getPendingInterAgentCommunication(): { triggerTurn: boolean } | null {
    return this.pendingInterAgentCommunication ? { ...this.pendingInterAgentCommunication } : null;
  }

  discardActiveTurnIds(turnIds: Iterable<string>): void {
    for (const turnId of turnIds) this.retireActiveTurnId(turnId);
  }

  /**
   * Codex sometimes keeps writing assistant messages with a completed turn's
   * passthrough id after a newer task_started. Prefer an active turn instead.
   */
  private resolveAttributionTurnId(
    explicitTurnId: string | null,
    uniqueActiveTurnId: string | null,
  ): string | null {
    if (explicitTurnId && this.activeTurnIds.has(explicitTurnId)) return explicitTurnId;
    if (uniqueActiveTurnId) return uniqueActiveTurnId;
    if (this.latestStartedTurnId && this.activeTurnIds.has(this.latestStartedTurnId)) {
      return this.latestStartedTurnId;
    }
    if (this.activeTurnIds.size > 0) {
      return this.activeTurnIds.values().next().value as string;
    }
    return explicitTurnId;
  }

  private retireActiveTurnId(turnId: string | null): void {
    if (!turnId) return;
    this.activeTurnIds.delete(turnId);
    if (this.latestStartedTurnId !== turnId) return;
    this.latestStartedTurnId = this.activeTurnIds.size > 0
      ? [...this.activeTurnIds].at(-1) ?? null
      : null;
  }

  private rememberSourceTurnId(value: string | null | undefined): void {
    if (!value?.startsWith(LEGACY_TURN_ID_PREFIX)) return;
    const sequence = Number(value.slice(LEGACY_TURN_ID_PREFIX.length));
    if (Number.isSafeInteger(sequence) && sequence >= this.nextLegacyTurnSequence) {
      this.nextLegacyTurnSequence = sequence + 1;
    }
  }

  private createLegacyTurnId(): string {
    return `agent-recall:legacy-turn:${this.nextLegacyTurnSequence++}`;
  }

  consume(value: unknown): CodexRolloutRecordResult {
    const row = record(value);
    if (!row) return emptyResult();
    const payload = record(row.payload);
    if (!payload) return emptyResult();

    if (row.type === "session_meta") {
      this.currentHistoryMode = historyMode(payload.history_mode);
      const source = record(payload.source);
      const subagent = record(source?.subagent);
      const threadSpawn = record(subagent?.thread_spawn);
      const agentPath = stringValue(payload.agent_path) || stringValue(threadSpawn?.agent_path);
      const parentThreadId = stringValue(payload.parent_thread_id) || stringValue(threadSpawn?.parent_thread_id);
      this.currentAgentPath = agentPath || (!parentThreadId && payload.thread_source !== "subagent" ? "/root" : null);
      return emptyResult();
    }

    if (row.type === "inter_agent_communication_metadata") {
      this.pendingInterAgentCommunication = typeof payload.trigger_turn === "boolean"
        ? { triggerTurn: payload.trigger_turn }
        : null;
      return emptyResult();
    }

    const communication = row.type === "response_item" && payload.type === "agent_message"
      ? this.pendingInterAgentCommunication
      : null;
    this.pendingInterAgentCommunication = null;

    const uniqueActiveTurnId = this.activeTurnIds.size === 1
      ? this.activeTurnIds.values().next().value as string
      : null;
    if (row.type === "compacted") {
      const sourceTurnId = this.resolveAttributionTurnId(null, uniqueActiveTurnId);
      return emptyResult({
        sourceTurnId,
        traceEvents: [compactionCheckpointTrace(row, payload, sourceTurnId)],
      });
    }
    if (row.type === "turn_context") {
      const sourceTurnId = stringValue(payload.turn_id) || uniqueActiveTurnId;
      const settings = contextAttributes(payload);
      return emptyResult({
        sourceTurnId,
        traceEvents: [{
          kind: "event",
          source: "codex",
          title: "Turn context",
          detail: formatCodexToolDetail(settings, null),
          timestamp: stringValue(row.timestamp),
          callId: null,
          eventType: "codex.thread.settings",
          status: "completed",
          sourceTurnId,
          attributes: { codex: { rawType: "turn_context" }, settings },
        }],
      });
    }
    if (row.type === "response_item") {
      const messageContext = responseMessageContext(payload);
      const metadata = record(payload.internal_chat_message_metadata_passthrough);
      const sourceTurnId = this.resolveAttributionTurnId(
        messageContext?.sourceTurnId ?? (stringValue(metadata?.turn_id) || null),
        uniqueActiveTurnId,
      );
      const message = messageContext ? { ...messageContext, sourceTurnId } : null;
      const richTrace = richResponseTrace(row, payload, sourceTurnId, {
        agentPath: this.currentAgentPath,
        triggerTurn: communication?.triggerTurn ?? null,
      });
      return emptyResult({
        message,
        sourceTurnId,
        traceEvents: richTrace ? [richTrace] : [],
      });
    }
    if (row.type === "item_completed" || (row.type === "event_msg" && payload.type === "item_completed")) {
      const sourceTurnId = this.resolveAttributionTurnId(
        stringValue(payload.turn_id) || null,
        uniqueActiveTurnId,
      );
      const decoded = completedItem(payload.item);
      if (!decoded) return emptyResult({ sourceTurnId });
      const itemId = stringValue(decoded.payload.id);
      const sourceRecordId = itemId ? `item_completed:${itemId}` : "";
      const messageType: SessionMessage["role"] | null = decoded.type === "usermessage"
        ? "user"
        : decoded.type === "agentmessage"
          ? "assistant"
          : null;
      const messageContent = messageType ? collectText(decoded.payload.content).join("").trim() : "";
      const rawPhase = stringValue(decoded.payload.phase);
      const phase: Exclude<SessionMessage["phase"], undefined> =
        rawPhase === "commentary" || rawPhase === "final_answer" ? rawPhase : null;
      const completedMessage = this.currentHistoryMode === "paginated"
        && messageType
        && itemId
        && messageContent
        ? {
            role: messageType,
            content: messageContent,
            timestamp: completedTimestamp(row, payload),
            sourceTurnId,
            phase: messageType === "assistant" ? phase : null,
            sourceRecordId,
            replacesSourceRecordId: `response_item:${itemId}`,
          }
        : null;
      const toolTrace = itemToolTrace(row, payload, decoded.type, decoded.payload, sourceTurnId);
      const richTrace = richItemTrace(row, payload, decoded.type, decoded.payload, sourceTurnId);
      return emptyResult({
        completedMessage,
        sourceTurnId,
        traceEvents: [toolTrace, richTrace].filter((trace): trace is TraceEventDraft => trace !== null),
      });
    }
    if (row.type !== "event_msg") return emptyResult();

    const rawType = stringValue(payload.type);
    const sourceTurnId = stringValue(payload.turn_id) || stringValue(payload.turnId) || uniqueActiveTurnId;
    const richTrace = richEventTrace(row, payload, sourceTurnId);
    if (richTrace) return emptyResult({ sourceTurnId, traceEvents: [richTrace] });
    if (rawType === "task_started") {
      const sourceTurnId = stringValue(payload.turn_id) || this.createLegacyTurnId();
      this.activeTurnIds.add(sourceTurnId);
      this.latestStartedTurnId = sourceTurnId;
      const startedAt = unixSecondsToIso(payload.started_at) || stringValue(row.timestamp) || null;
      const attributes: Record<string, unknown> = { rawType };
      if (startedAt) attributes.startedAt = startedAt;
      const traceId = stringValue(payload.trace_id);
      if (traceId) attributes.traceId = traceId;
      const modelContextWindow = nonNegativeNumber(payload.model_context_window);
      if (modelContextWindow !== null) attributes.modelContextWindow = modelContextWindow;
      const collaborationModeKind = stringValue(payload.collaboration_mode_kind);
      if (collaborationModeKind) attributes.collaborationModeKind = collaborationModeKind;
      return emptyResult({
        sourceTurnId,
        traceEvents: [{
          kind: "event",
          source: "codex",
          title: "Turn started",
          detail: "",
          timestamp: rowTimestamp(row, payload.started_at),
          callId: null,
          eventType: "codex.turn.started",
          status: "running",
          sourceTurnId,
          attributes,
        }],
      });
    }

    if (rawType === "task_complete") {
      const sourceTurnId = stringValue(payload.turn_id) || uniqueActiveTurnId;
      this.retireActiveTurnId(sourceTurnId);
      const startedAt = unixSecondsToIso(payload.started_at);
      const endedAt = unixSecondsToIso(payload.completed_at) || stringValue(row.timestamp) || null;
      const durationMs = nonNegativeNumber(payload.duration_ms);
      const timeToFirstTokenMs = nonNegativeNumber(payload.time_to_first_token_ms);
      const error = errorDetail(payload.error);
      const attributes: Record<string, unknown> = { rawType };
      if (startedAt) attributes.startedAt = startedAt;
      if (endedAt) attributes.endedAt = endedAt;
      if (durationMs !== null) attributes.durationMs = durationMs;
      if (timeToFirstTokenMs !== null) attributes.timeToFirstTokenMs = timeToFirstTokenMs;
      if (error) attributes.error = error;
      return emptyResult({
        sourceTurnId,
        traceEvents: [{
          kind: "event",
          source: "codex",
          title: error ? "Turn failed" : "Turn completed",
          detail: error,
          timestamp: stringValue(row.timestamp) || endedAt || "",
          callId: null,
          eventType: "codex.turn.completed",
          status: error ? "failed" : "completed",
          sourceTurnId,
          attributes,
        }],
      });
    }

    if (rawType === "turn_aborted") {
      const sourceTurnId = stringValue(payload.turn_id) || uniqueActiveTurnId;
      this.retireActiveTurnId(sourceTurnId);
      const startedAt = unixSecondsToIso(payload.started_at);
      const endedAt = unixSecondsToIso(payload.completed_at) || stringValue(row.timestamp) || null;
      const durationMs = nonNegativeNumber(payload.duration_ms);
      const abortReason = stringValue(payload.reason);
      const attributes: Record<string, unknown> = { rawType };
      if (startedAt) attributes.startedAt = startedAt;
      if (endedAt) attributes.endedAt = endedAt;
      if (durationMs !== null) attributes.durationMs = durationMs;
      if (abortReason) attributes.abortReason = abortReason;
      return emptyResult({
        sourceTurnId,
        traceEvents: [{
          kind: "event",
          source: "codex",
          title: "Turn aborted",
          detail: abortReason,
          timestamp: stringValue(row.timestamp) || endedAt || "",
          callId: null,
          eventType: "codex.turn.aborted",
          status: "aborted",
          sourceTurnId,
          attributes,
        }],
      });
    }

    return emptyResult({ sourceTurnId });
  }
}
