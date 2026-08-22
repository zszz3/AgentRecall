// Unified tool-call extraction for Codex session rollouts.
//
// Codex can record the same logical tool call in several shapes: top-level
// response_item call records (the request), paginated item_completed runtime
// records (the authoritative outcome) and, in later phases, Code Mode
// JavaScript containers. This module turns those raw records into
// ToolCallObservation evidence and correlates the evidence into
// StructuredToolCall entries so downstream features (skill usage, session
// traces, eval) share one view of which tool calls a session actually made.

export type ToolCallObservationStatus =
  | "requested"
  | "completed"
  | "failed"
  | "declined"
  | "unknown";

export type ToolCallEvidenceKind =
  | "response-item"
  | "item-completed"
  | "executed-tool-metadata"
  | "code-mode-ast";

export interface ToolCallObservation {
  callId: string | null;
  parentCallId: string | null;
  turnId: string | null;
  namespace: string | null;
  rawName: string;
  input: unknown;
  cwd: string | null;
  status: ToolCallObservationStatus;
  evidence: ToolCallEvidenceKind;
  timestamp: number;
}

export type StructuredToolCallStatus = "completed" | "failed" | "declined" | "unknown";

export type StructuredExecutionEvidence = "runtime-confirmed" | "recorded-request" | "static-only";

export interface StructuredToolCall {
  callId: string | null;
  parentCallId: string | null;
  turnId: string | null;
  canonicalName: string;
  input: unknown;
  cwd: string | null;
  status: StructuredToolCallStatus;
  executionEvidence: StructuredExecutionEvidence;
  evidence: ToolCallObservation[];
}

const RESPONSE_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "tool_search_call",
]);

// Higher wins when observations of the same call disagree.
const EVIDENCE_PRIORITY: Record<ToolCallEvidenceKind, number> = {
  "item-completed": 3,
  "executed-tool-metadata": 2,
  "response-item": 1,
  "code-mode-ast": 0,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function rowTimestampMs(row: Record<string, unknown>): number {
  const parsed = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

// Function-call arguments arrive as a JSON string; parse them exactly once at
// the adapter boundary and keep the raw string when it is not valid JSON.
function parseBoundaryJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function canonicalToolName(namespace: string | null, rawName: string): string {
  return namespace ? `${namespace}.${rawName}` : rawName;
}

function completedItemStatus(value: unknown): StructuredToolCallStatus {
  const status = typeof value === "string" ? value.toLocaleLowerCase() : "";
  if (status === "completed" || status === "success" || status === "succeeded") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "declined" || status === "aborted" || status === "cancelled") return "declined";
  return "unknown";
}

// A persisted exit code is runtime truth even when the status field is
// missing or unrecognized; non-zero means the command failed.
function commandExecutionStatus(item: Record<string, unknown>): StructuredToolCallStatus {
  const status = completedItemStatus(item.status);
  if (status !== "unknown") return status;
  if (typeof item.exit_code === "number" && Number.isFinite(item.exit_code)) {
    return item.exit_code === 0 ? "completed" : "failed";
  }
  return "unknown";
}

function responseItemObservation(row: Record<string, unknown>): ToolCallObservation | null {
  if (row.type !== "response_item") return null;
  const payload = record(row.payload);
  if (!payload || typeof payload.type !== "string" || !RESPONSE_CALL_TYPES.has(payload.type)) return null;
  const payloadType = payload.type;
  const namespace = text(payload.namespace);
  const fallbackName =
    payloadType === "local_shell_call" ? "shell"
      : payloadType === "tool_search_call" ? text(payload.execution) ?? "tool_search"
        : "tool";
  const rawName = text(payload.name) ?? fallbackName;
  const input = payloadType === "custom_tool_call" ? payload.input
    : payloadType === "local_shell_call" ? payload.action
      : payloadType === "tool_search_call" ? payload.arguments
        : parseBoundaryJson(payload.arguments);
  const metadata = record(payload.internal_chat_message_metadata_passthrough);
  return {
    callId: text(payload.call_id) ?? text(payload.id),
    parentCallId: null,
    turnId: text(payload.turn_id) ?? text(metadata?.turn_id),
    namespace,
    rawName,
    input,
    cwd: null,
    status: "requested",
    evidence: "response-item",
    timestamp: rowTimestampMs(row),
  };
}

// item_completed records appear either as a bare rollout record or wrapped in
// an event_msg payload; in both shapes the turn id, timing and item live on
// row.payload, and the item itself is either tagged with a `type` or a
// single-key { ItemType: {...} } wrapper.
function itemCompletedWrapper(row: Record<string, unknown>): Record<string, unknown> | null {
  if (row.type !== "item_completed" && row.type !== "event_msg") return null;
  const payload = record(row.payload);
  if (!payload) return null;
  if (row.type === "item_completed") return payload;
  return payload.type === "item_completed" ? payload : null;
}

function normalizeItemTypeName(value: unknown): string {
  return typeof value === "string" ? value.replaceAll(/[^a-z0-9]/giu, "").toLocaleLowerCase() : "";
}

function completedItemShape(value: unknown): { type: string; item: Record<string, unknown> } | null {
  const item = record(value);
  if (!item) return null;
  const tagged = normalizeItemTypeName(item.type);
  if (tagged) return { type: tagged, item };
  for (const [key, nested] of Object.entries(item)) {
    const object = record(nested);
    if (object) return { type: normalizeItemTypeName(key), item: object };
  }
  return null;
}

function itemCompletedObservation(row: Record<string, unknown>): ToolCallObservation | null {
  const wrapper = itemCompletedWrapper(row);
  if (!wrapper) return null;
  const decoded = completedItemShape(wrapper.item);
  if (!decoded) return null;
  const { type, item } = decoded;
  const callId = text(item.id);
  const turnId = text(wrapper.turn_id);
  const completedAt = typeof wrapper.completed_at_ms === "number"
    && Number.isFinite(wrapper.completed_at_ms)
    && wrapper.completed_at_ms > 0
    ? wrapper.completed_at_ms
    : null;
  const timestamp = completedAt ?? rowTimestampMs(row);
  const base = {
    callId,
    parentCallId: null,
    turnId,
    cwd: null,
    evidence: "item-completed" as const,
    timestamp,
  };

  if (type === "commandexecution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
    return {
      ...base,
      namespace: null,
      rawName: "shell",
      input: {
        command,
        cwd: item.cwd ?? null,
        parsedCommand: item.parsed_cmd ?? null,
        exitCode: item.exit_code ?? null,
      },
      cwd: text(item.cwd),
      status: commandExecutionStatus(item),
    };
  }
  if (type === "dynamictoolcall") {
    return {
      ...base,
      namespace: text(item.namespace),
      rawName: text(item.tool) ?? "dynamic_tool",
      input: item.arguments,
      status: item.success === false ? "failed" : completedItemStatus(item.status),
    };
  }
  if (type === "mcptoolcall") {
    const server = text(item.server);
    return {
      ...base,
      namespace: server ? `mcp__${server}` : null,
      rawName: text(item.tool) ?? "tool",
      input: item.arguments,
      status: completedItemStatus(item.status),
    };
  }
  return null;
}

/** Extract raw tool-call evidence from parsed Codex session JSONL records. */
export function collectCodexToolCallObservations(rows: readonly unknown[]): ToolCallObservation[] {
  const observations: ToolCallObservation[] = [];
  for (const row of rows) {
    const value = record(row);
    if (!value) continue;
    const observation = responseItemObservation(value) ?? itemCompletedObservation(value);
    if (observation) observations.push(observation);
  }
  return observations;
}

/** Correlate observations of the same call into deduplicated structured calls. */
export function correlateCodexToolCalls(observations: readonly ToolCallObservation[]): StructuredToolCall[] {
  const keyed = new Map<string, ToolCallObservation[]>();
  const unkeyed: ToolCallObservation[][] = [];
  for (const observation of observations) {
    if (observation.callId === null) {
      unkeyed.push([observation]);
      continue;
    }
    const existing = keyed.get(observation.callId);
    if (existing) existing.push(observation);
    else keyed.set(observation.callId, [observation]);
  }

  const calls: StructuredToolCall[] = [];
  for (const merged of [...keyed.values(), ...unkeyed]) {
    // The highest-priority record is authoritative; earlier records win ties
    // so a request keeps its identity when no stronger evidence exists.
    let authoritative = merged[0];
    for (const observation of merged) {
      if (EVIDENCE_PRIORITY[observation.evidence] > EVIDENCE_PRIORITY[authoritative.evidence]) {
        authoritative = observation;
      }
    }
    const runtimeConfirmed = merged.some(
      (observation) => observation.evidence === "item-completed"
        || observation.evidence === "executed-tool-metadata",
    );
    const recordedRequest = merged.some((observation) => observation.evidence === "response-item");
    calls.push({
      callId: authoritative.callId,
      parentCallId: merged.map((observation) => observation.parentCallId).find(Boolean) ?? null,
      turnId: merged.map((observation) => observation.turnId).find(Boolean) ?? null,
      canonicalName: canonicalToolName(authoritative.namespace, authoritative.rawName),
      input: authoritative.input,
      cwd: authoritative.cwd ?? merged.map((observation) => observation.cwd).find(Boolean) ?? null,
      status: runtimeConfirmed && authoritative.status !== "requested" ? authoritative.status : "unknown",
      executionEvidence: runtimeConfirmed
        ? "runtime-confirmed"
        : recordedRequest
          ? "recorded-request"
          : "static-only",
      evidence: merged,
    });
  }
  return calls;
}

/** Extract correlated structured tool calls from parsed Codex session records. */
export function extractCodexStructuredToolCalls(rows: readonly unknown[]): StructuredToolCall[] {
  return correlateCodexToolCalls(collectCodexToolCallObservations(rows));
}
