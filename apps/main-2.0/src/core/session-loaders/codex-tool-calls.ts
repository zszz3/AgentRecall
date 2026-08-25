import { parse as parseJavaScript } from "@babel/parser";

import { sanitizeCodexTraceValue } from "./codex-trace-value";

export type ToolCallStatus = "requested" | "completed" | "failed" | "declined" | "unknown";
export type CodexSessionFormat = "legacy" | "paginated";
export type ToolCallEvidence =
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
  status: ToolCallStatus;
  evidence: ToolCallEvidence;
  pluginId?: string | null;
  scriptPath?: string | null;
  durationMs: number | null;
  timestamp: number;
}

export interface StructuredToolCall {
  callId: string | null;
  parentCallId: string | null;
  turnId: string | null;
  canonicalName: string;
  input: unknown;
  cwd: string | null;
  status: Exclude<ToolCallStatus, "requested">;
  executionEvidence: "runtime-confirmed" | "recorded-request" | "static-only";
  evidence: ToolCallObservation[];
  pluginId: string | null;
  scriptPath: string | null;
  durationMs: number | null;
  timestamp: number;
}

interface SequencedObservation extends ToolCallObservation {
  sequence: number;
}

interface SequencedCall extends StructuredToolCall {
  sequence: number;
}

export interface CodexToolCallCollectorState {
  observations: ToolCallObservation[];
  cwd: string | null;
  declaredSessionFormat: CodexSessionFormat | null;
  sawToolCompletion: boolean;
}

const EVIDENCE_PRIORITY: Record<ToolCallEvidence, number> = {
  "code-mode-ast": 0,
  "response-item": 1,
  "executed-tool-metadata": 2,
  "item-completed": 3,
};
const MAX_PERSISTED_OBSERVATION_CHARS = 256_000;

/**
 * Session-scoped Codex adapter. It collects evidence first because paginated
 * rollouts can record one call both as a request and as a completed TurnItem.
 */
export class CodexToolCallCollector {
  private readonly observations: SequencedObservation[] = [];
  private sequence = 0;
  private cwd: string | null = null;
  private declaredSessionFormat: CodexSessionFormat | null = null;
  private sawToolCompletion = false;

  constructor(state?: CodexToolCallCollectorState) {
    this.cwd = state?.cwd ?? null;
    this.declaredSessionFormat = state?.declaredSessionFormat ?? null;
    this.sawToolCompletion = state?.sawToolCompletion ?? false;
    for (const observation of state?.observations ?? []) this.add({ ...observation });
  }

  get sessionFormat(): CodexSessionFormat {
    return this.declaredSessionFormat ?? (this.sawToolCompletion ? "paginated" : "legacy");
  }

  get state(): CodexToolCallCollectorState {
    const observations: ToolCallObservation[] = [];
    let serializedChars = 2;
    const groups = this.finish().map((call) => call.evidence.map((observation) => ({
      ...observation,
      input: sanitizeCodexTraceValue(observation.input),
    })));
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      const groupChars = group.reduce((total, observation) => total + JSON.stringify(observation).length, 0)
        + Math.max(0, group.length - 1);
      const additionalChars = groupChars + (observations.length > 0 ? 1 : 0);
      if (serializedChars + additionalChars > MAX_PERSISTED_OBSERVATION_CHARS) continue;
      observations.unshift(...group);
      serializedChars += additionalChars;
    }
    return {
      observations,
      cwd: this.cwd,
      declaredSessionFormat: this.declaredSessionFormat,
      sawToolCompletion: this.sawToolCompletion,
    };
  }

  discardCallIds(callIds: ReadonlySet<string>): void {
    if (callIds.size === 0) return;
    for (let index = this.observations.length - 1; index >= 0; index -= 1) {
      const observation = this.observations[index];
      if (
        (observation.callId && callIds.has(observation.callId))
        || (observation.parentCallId && callIds.has(observation.parentCallId))
      ) {
        this.observations.splice(index, 1);
      }
    }
  }

  consume(row: unknown): void {
    if (!isRecord(row)) return;
    this.readSessionMeta(row);
    this.readResponseItem(row);
    this.readCompletedItem(row);
  }

  finish(): StructuredToolCall[] {
    const exact = this.mergeExactCallIds();
    this.mergeNestedEvidence(exact);
    return exact
      .filter((call) => call.evidence.length > 0)
      .sort((a, b) => a.sequence - b.sequence)
      .map(({ sequence: _sequence, ...call }) => call);
  }

  private readSessionMeta(row: Record<string, unknown>): void {
    if (row.type !== "session_meta") return;
    const payload = record(row.payload) ?? row;
    this.cwd = text(payload.cwd) || this.cwd;
    const historyMode = text(payload.history_mode).toLowerCase();
    if (historyMode === "legacy" || historyMode === "paginated") {
      this.declaredSessionFormat = historyMode;
    }
  }

  private readResponseItem(row: Record<string, unknown>): void {
    if (row.type !== "response_item") return;
    const payload = record(row.payload);
    if (!payload) return;
    const timestamp = timestampFrom(row.timestamp ?? payload.timestamp);
    const metadata = record(payload.internal_chat_message_metadata_passthrough);
    const turnId = text(metadata?.turn_id) || text(payload.turn_id) || null;
    const payloadType = normalizeType(payload.type);

    if (payloadType === "functioncall" || payloadType === "customtoolcall") {
      const rawName = text(payload.name);
      if (rawName) {
        const namespace = text(payload.namespace) || null;
        const callId = text(payload.call_id ?? payload.id) || null;
        const input = parseMaybeJson(payloadType === "customtoolcall" ? payload.input : payload.arguments);
        this.add({
          callId,
          parentCallId: null,
          turnId,
          namespace,
          rawName,
          input,
          cwd: this.cwd,
          status: "requested",
          evidence: "response-item",
          durationMs: null,
          timestamp,
        });
        if (payloadType === "customtoolcall" && canonicalToolName(namespace, rawName) === "exec" && typeof payload.input === "string") {
          this.readCodeModeAst(payload.input, callId, turnId, timestamp);
        }
      }
    } else if (payloadType === "localshellcall") {
      this.add({
        callId: text(payload.call_id ?? payload.id) || null,
        parentCallId: null,
        turnId,
        namespace: null,
        rawName: "exec_command",
        input: parseMaybeJson(payload.action ?? payload.command ?? payload),
        cwd: this.cwd,
        status: "requested",
        evidence: "response-item",
        durationMs: null,
        timestamp,
      });
    } else if (payloadType === "toolsearchcall") {
      this.add({
        callId: text(payload.call_id ?? payload.id) || null,
        parentCallId: null,
        turnId,
        namespace: text(payload.namespace) || null,
        rawName: text(payload.name ?? payload.tool) || "tool_search",
        input: parseMaybeJson(payload.arguments ?? payload.input),
        cwd: this.cwd,
        status: "requested",
        evidence: "response-item",
        durationMs: null,
        timestamp,
      });
    }

    this.readExecutedToolMetadata(payload, turnId, timestamp);
  }

  private readCompletedItem(row: Record<string, unknown>): void {
    const payload = record(row.payload) ?? row;
    if (!(row.type === "item_completed" || (row.type === "event_msg" && payload.type === "item_completed"))) return;
    const decoded = completedItemShape(payload.item);
    if (!decoded) return;
    const { type, item } = decoded;
    const timestamp = timestampFrom(payload.completed_at_ms ?? row.timestamp ?? payload.timestamp);
    const turnId = text(payload.turn_id ?? payload.turnId) || null;
    const callId = text(item.id ?? item.call_id) || null;
    const cwd = pathText(item.cwd) || this.cwd;

    if (type === "commandexecution") {
      this.sawToolCompletion = true;
      const command = item.command;
      this.add({
        callId,
        parentCallId: null,
        turnId,
        namespace: null,
        rawName: "exec_command",
        input: {
          cmd: shellCommand(command),
          command,
          commandActions: item.command_actions ?? item.parsed_cmd,
          exitCode: item.exit_code,
        },
        cwd,
        status: commandExecutionStatus(item),
        evidence: "item-completed",
        pluginId: text(item.plugin_id) || null,
        scriptPath: pathText(item.script_path),
        durationMs: durationMilliseconds(item.duration_ms, item.duration),
        timestamp,
      });
      return;
    }

    if (type === "dynamictoolcall") {
      this.sawToolCompletion = true;
      this.add({
        callId,
        parentCallId: null,
        turnId,
        namespace: text(item.namespace) || null,
        rawName: text(item.tool ?? item.name) || "dynamic_tool",
        input: parseMaybeJson(item.arguments ?? item.input),
        cwd,
        status: dynamicToolStatus(item),
        evidence: "item-completed",
        durationMs: durationMilliseconds(item.duration_ms, item.duration),
        timestamp,
      });
      return;
    }

    if (type === "mcptoolcall") {
      this.sawToolCompletion = true;
      const server = text(item.server);
      this.add({
        callId,
        parentCallId: null,
        turnId,
        namespace: server ? `mcp__${server}` : "mcp",
        rawName: text(item.tool ?? item.name) || "unknown",
        input: parseMaybeJson(item.arguments ?? item.input),
        cwd,
        status: mcpToolStatus(item),
        evidence: "item-completed",
        pluginId: text(item.plugin_id) || null,
        durationMs: durationMilliseconds(item.duration_ms, item.duration),
        timestamp,
      });
    }
  }

  private readExecutedToolMetadata(
    payload: Record<string, unknown>,
    turnId: string | null,
    timestamp: number,
  ): void {
    const metadata = record(payload.internal_chat_message_metadata_passthrough);
    const calls = metadata?.executed_tool_calls;
    if (!Array.isArray(calls)) return;
    const parentCallId = text(payload.call_id ?? payload.id) || null;
    calls.forEach((value, ordinal) => {
      const call = record(value);
      const rawName = text(call?.name);
      if (!call || !rawName) return;
      const normalized = splitToolName(rawName);
      const isOuterCall = canonicalToolName(normalized.namespace, normalized.name) === "exec";
      this.add({
        callId: isOuterCall && parentCallId ? parentCallId : syntheticId(parentCallId, "metadata", ordinal),
        parentCallId: isOuterCall ? null : parentCallId,
        turnId,
        namespace: normalized.namespace,
        rawName: normalized.name,
        input: parseMaybeJson(call.arguments ?? call.input),
        cwd: this.cwd,
        status: "unknown",
        evidence: "executed-tool-metadata",
        pluginId: text(call.plugin_id) || null,
        scriptPath: pathText(call.script_path),
        durationMs: null,
        timestamp,
      });
    });
  }

  private readCodeModeAst(source: string, parentCallId: string | null, turnId: string | null, timestamp: number): void {
    let root: unknown;
    try {
      root = parseJavaScript(source, {
        sourceType: "script",
        allowAwaitOutsideFunction: true,
      });
    } catch {
      return;
    }
    let ordinal = 0;
    walkAst(root, (node) => {
      if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return;
      const callee = record(node.callee);
      if (!callee || (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression")) return;
      const object = record(callee.object);
      if (!object || object.type !== "Identifier" || object.name !== "tools") return;
      const propertyName = memberPropertyName(callee);
      if (!propertyName) return;
      const normalized = splitToolName(propertyName);
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      const evaluated = args.length === 0 ? { resolved: true, value: {} } : staticArgumentValue(args[0]);
      const currentOrdinal = ordinal++;
      this.add({
        callId: syntheticId(parentCallId, "ast", currentOrdinal),
        parentCallId,
        turnId,
        namespace: normalized.namespace,
        rawName: normalized.name,
        input: evaluated.resolved ? evaluated.value : null,
        cwd: this.cwd,
        status: "unknown",
        evidence: "code-mode-ast",
        durationMs: null,
        timestamp,
      });
    });
  }

  private add(observation: ToolCallObservation): void {
    this.observations.push({ ...observation, sequence: this.sequence++ });
  }

  private mergeExactCallIds(): SequencedCall[] {
    const calls: SequencedCall[] = [];
    const byCallId = new Map<string, SequencedCall>();
    for (const observation of this.observations) {
      const existing = observation.callId ? byCallId.get(observation.callId) : undefined;
      if (existing) {
        mergeObservation(existing, observation);
        continue;
      }
      const call = callFromObservation(observation);
      calls.push(call);
      if (observation.callId) byCallId.set(observation.callId, call);
    }
    return calls;
  }

  private mergeNestedEvidence(calls: SequencedCall[]): void {
    const removed = new Set<SequencedCall>();
    const nested = calls.filter((call) => call.parentCallId && !hasCompletionEvidence(call));

    // The recorder attaches `executed_tool_calls` to the output identified by
    // `parentCallId`. For a direct call that output id is the call's own id;
    // for Code Mode it is the outer `exec` id. Resolve the direct form first so
    // its metadata cannot survive as a second, apparently nested invocation.
    for (const recorded of nested.filter(hasExecutedMetadata)) {
      const direct = calls.find((candidate) =>
        candidate !== recorded &&
        !candidate.parentCallId &&
        candidate.callId === recorded.parentCallId &&
        candidate.canonicalName === recorded.canonicalName,
      );
      if (!direct) continue;
      direct.turnId = direct.turnId ?? recorded.turnId;
      direct.cwd = direct.cwd ?? recorded.cwd;
      direct.evidence.push(...recorded.evidence);
      direct.executionEvidence = executionEvidence(direct.evidence);
      removed.add(recorded);
    }

    {
      for (const call of nested) {
        if (call.turnId || !call.parentCallId) continue;
        const parent = calls.find((candidate) => !candidate.parentCallId && candidate.callId === call.parentCallId);
        call.turnId = parent?.turnId ?? null;
      }

      const recordedMatchedStatic = new Set<SequencedCall>();
      for (const staticCall of nested) {
        if (removed.has(staticCall) || staticCall.executionEvidence !== "static-only") continue;
        const candidates = nested.filter((other) =>
          other !== staticCall &&
          !removed.has(other) &&
          !recordedMatchedStatic.has(other) &&
          hasExecutedMetadata(other) &&
          other.parentCallId === staticCall.parentCallId &&
          other.turnId === staticCall.turnId &&
          other.canonicalName === staticCall.canonicalName,
        );
        const exact = candidates.filter((candidate) => inputFingerprint(candidate) === inputFingerprint(staticCall));
        const selected = exact.length > 0
          ? exact[0]
          : exact.length === 0 && inputFingerprint(staticCall) === "input:null" && candidates.length === 1
            ? candidates[0]
            : null;
        if (!selected) continue;
        mergeCall(selected, staticCall);
        recordedMatchedStatic.add(selected);
        removed.add(staticCall);
      }

      for (const runtime of calls.filter(hasCompletionEvidence)) {
        if (!runtime.callId || runtime.parentCallId || !runtime.turnId) continue;
        const candidates = nested.filter((candidate) =>
          !removed.has(candidate) &&
          candidate.sequence < runtime.sequence &&
          candidate.turnId === runtime.turnId &&
          compatibleToolName(candidate.canonicalName, runtime.canonicalName),
        );
        const exact = candidates.filter((candidate) => inputFingerprint(candidate) === inputFingerprint(runtime));
        let selected: SequencedCall | null = exact.length === 1 ? exact[0] : null;
        if (exact.length > 1) {
          const parents = new Set(exact.map((candidate) => candidate.parentCallId));
          if (parents.size === 1) selected = exact[0];
        } else if (exact.length === 0) {
          const unresolved = candidates.filter((candidate) => inputFingerprint(candidate) === "input:null");
          if (unresolved.length === 1) selected = unresolved[0];
        }
        if (!selected) continue;
        mergeCall(runtime, selected);
        removed.add(selected);
      }
    }

    for (let index = calls.length - 1; index >= 0; index -= 1) {
      if (removed.has(calls[index])) calls.splice(index, 1);
    }
  }
}

export function canonicalToolName(namespace: string | null, rawName: string): string {
  const normalizedName = rawName.trim().toLowerCase();
  const normalizedNamespace = namespace?.trim().toLowerCase() || null;
  if (normalizedNamespace) return `${normalizedNamespace}.${normalizedName}`;
  const split = splitToolName(normalizedName);
  return split.namespace ? `${split.namespace}.${split.name}` : split.name;
}

function callFromObservation(observation: SequencedObservation): SequencedCall {
  return {
    callId: observation.callId,
    parentCallId: observation.parentCallId,
    turnId: observation.turnId,
    canonicalName: canonicalToolName(observation.namespace, observation.rawName),
    input: observation.input,
    cwd: observation.cwd,
    status: publicStatus(observation.status),
    executionEvidence: executionEvidence([observation]),
    evidence: [withoutSequence(observation)],
    pluginId: observation.pluginId ?? null,
    scriptPath: observation.scriptPath ?? null,
    durationMs: observation.durationMs,
    timestamp: observation.timestamp,
    sequence: observation.sequence,
  };
}

function mergeObservation(call: SequencedCall, observation: SequencedObservation): void {
  const currentPriority = Math.max(...call.evidence.map((item) => EVIDENCE_PRIORITY[item.evidence]));
  const nextPriority = EVIDENCE_PRIORITY[observation.evidence];
  if (nextPriority >= currentPriority) {
    call.canonicalName = canonicalToolName(observation.namespace, observation.rawName);
    call.input = observation.input;
    call.cwd = observation.cwd ?? call.cwd;
    call.turnId = observation.turnId ?? call.turnId;
    call.status = publicStatus(observation.status);
    call.pluginId = observation.pluginId ?? call.pluginId;
    call.scriptPath = observation.scriptPath ?? call.scriptPath;
    call.durationMs = observation.durationMs ?? call.durationMs;
    call.timestamp = observation.timestamp;
  }
  call.parentCallId = call.parentCallId ?? observation.parentCallId;
  call.evidence.push(withoutSequence(observation));
  call.executionEvidence = executionEvidence(call.evidence);
}

function mergeCall(target: SequencedCall, source: SequencedCall): void {
  const runtimeTarget = hasRuntimeEvidence(target);
  target.parentCallId = target.parentCallId ?? source.parentCallId;
  target.turnId = target.turnId ?? source.turnId;
  target.cwd = target.cwd ?? source.cwd;
  target.pluginId = target.pluginId ?? source.pluginId;
  target.scriptPath = target.scriptPath ?? source.scriptPath;
  target.durationMs = target.durationMs ?? source.durationMs;
  target.evidence.push(...source.evidence);
  target.executionEvidence = executionEvidence(target.evidence);
  if (!runtimeTarget) {
    target.sequence = Math.min(target.sequence, source.sequence);
    target.timestamp = Math.min(target.timestamp, source.timestamp);
  }
}

function withoutSequence({ sequence: _sequence, ...observation }: SequencedObservation): ToolCallObservation {
  return observation;
}

function executionEvidence(evidence: ToolCallObservation[]): StructuredToolCall["executionEvidence"] {
  if (evidence.some((item) =>
    item.evidence === "item-completed" || item.evidence === "executed-tool-metadata"
  )) return "runtime-confirmed";
  if (evidence.some((item) => item.evidence === "response-item")) return "recorded-request";
  return "static-only";
}

function hasRuntimeEvidence(call: SequencedCall): boolean {
  return call.evidence.some((item) =>
    item.evidence === "item-completed" || item.evidence === "executed-tool-metadata"
  );
}

function hasCompletionEvidence(call: SequencedCall): boolean {
  return call.evidence.some((item) => item.evidence === "item-completed");
}

function hasExecutedMetadata(call: SequencedCall): boolean {
  return call.evidence.some((item) => item.evidence === "executed-tool-metadata");
}

function compatibleToolName(left: string, right: string): boolean {
  if (left === right) return true;
  const shellNames = new Set(["exec_command", "shell_command", "local_shell_call"]);
  return shellNames.has(baseName(left)) && shellNames.has(baseName(right));
}

function inputFingerprint(call: StructuredToolCall): string {
  if (["exec_command", "shell_command", "local_shell_call"].includes(baseName(call.canonicalName))) {
    const command = commandFromInput(call.input);
    if (command) return `command:${command}`;
  }
  return `input:${stableJson(call.input)}`;
}

function commandFromInput(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (!isRecord(input)) return "";
  return shellCommand(input.cmd ?? input.command).trim();
}

function shellCommand(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || !command.every((value) => typeof value === "string")) return "";
  const shellFlag = command.findIndex((value) => value === "-c" || value === "-lc" || value.toLowerCase() === "-command");
  if (shellFlag >= 0 && typeof command[shellFlag + 1] === "string") return command[shellFlag + 1];
  return command.join(" ");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function splitToolName(rawName: string): { namespace: string | null; name: string } {
  const value = rawName.trim();
  const parts = value.split("__").filter(Boolean);
  if (parts.length < 2) return { namespace: null, name: value };
  return { namespace: parts.slice(0, -1).join("__"), name: parts.at(-1)! };
}

function memberPropertyName(member: Record<string, unknown>): string | null {
  const property = record(member.property);
  if (!property) return null;
  if (property.type === "Identifier" && member.computed !== true) return text(property.name) || null;
  if (property.type === "StringLiteral") return text(property.value) || null;
  return null;
}

function walkAst(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkAst(item, visit);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.type === "string") visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (["loc", "start", "end", "extra", "errors", "comments", "tokens"].includes(key)) continue;
    walkAst(child, visit);
  }
}

function literalValue(node: unknown): { resolved: boolean; value: unknown } {
  const value = record(node);
  if (!value) return { resolved: false, value: null };
  if (value.type === "StringLiteral" || value.type === "NumericLiteral" || value.type === "BooleanLiteral") {
    return { resolved: true, value: value.value };
  }
  if (value.type === "NullLiteral") return { resolved: true, value: null };
  if (value.type === "TemplateLiteral") {
    const expressions = Array.isArray(value.expressions) ? value.expressions : [];
    const quasis = Array.isArray(value.quasis) ? value.quasis : [];
    if (expressions.length) return { resolved: false, value: null };
    return { resolved: true, value: quasis.map((quasi) => text(record(record(quasi)?.value)?.cooked)).join("") };
  }
  if (value.type === "UnaryExpression" && (value.operator === "+" || value.operator === "-")) {
    const argument = literalValue(value.argument);
    if (argument.resolved && typeof argument.value === "number") {
      return { resolved: true, value: value.operator === "-" ? -argument.value : argument.value };
    }
    return { resolved: false, value: null };
  }
  if (value.type === "ArrayExpression") {
    const elements = Array.isArray(value.elements) ? value.elements : [];
    const result: unknown[] = [];
    for (const element of elements) {
      if (!element || record(element)?.type === "SpreadElement") return { resolved: false, value: null };
      const evaluated = literalValue(element);
      if (!evaluated.resolved) return { resolved: false, value: null };
      result.push(evaluated.value);
    }
    return { resolved: true, value: result };
  }
  if (value.type === "ObjectExpression") {
    const properties = Array.isArray(value.properties) ? value.properties : [];
    const result: Record<string, unknown> = {};
    for (const propertyValue of properties) {
      const property = record(propertyValue);
      if (!property || property.type !== "ObjectProperty" || property.computed === true) return { resolved: false, value: null };
      const key = record(property.key);
      const keyText = key?.type === "Identifier" ? text(key.name) : text(key?.value);
      if (!keyText) return { resolved: false, value: null };
      const evaluated = literalValue(property.value);
      if (!evaluated.resolved) return { resolved: false, value: null };
      result[keyText] = evaluated.value;
    }
    return { resolved: true, value: result };
  }
  return { resolved: false, value: null };
}

function staticArgumentValue(node: unknown): { resolved: boolean; value: unknown } {
  const evaluated = literalValue(node);
  if (evaluated.resolved) return evaluated;

  const value = record(node);
  if (value?.type !== "ObjectExpression") return evaluated;
  const properties = Array.isArray(value.properties) ? value.properties : [];
  const result: Record<string, unknown> = {};
  for (const propertyValue of properties) {
    const property = record(propertyValue);
    if (!property || property.type !== "ObjectProperty" || property.computed === true) return evaluated;
    const key = record(property.key);
    const keyText = key?.type === "Identifier" ? text(key.name) : text(key?.value);
    if (!keyText) return evaluated;
    const propertyResult = literalValue(property.value);
    if (propertyResult.resolved) result[keyText] = propertyResult.value;
    else delete result[keyText];
  }
  return Object.keys(result).length > 0
    ? { resolved: true, value: result }
    : evaluated;
}

function completedStatus(status: unknown): ToolCallStatus {
  const normalized = text(status).toLowerCase();
  if (normalized === "completed" || normalized === "success" || normalized === "succeeded") return "completed";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (
    normalized === "declined"
    || normalized === "rejected"
    || normalized === "aborted"
    || normalized === "cancelled"
  ) return "declined";
  return "unknown";
}

function commandExecutionStatus(item: Record<string, unknown>): ToolCallStatus {
  const status = completedStatus(item.status);
  if (status === "failed" || status === "declined") return status;
  const exitCode = typeof item.exit_code === "number" && Number.isFinite(item.exit_code)
    ? item.exit_code
    : null;
  if (exitCode !== null) return exitCode === 0 ? (status === "unknown" ? "completed" : status) : "failed";
  return status;
}

function dynamicToolStatus(item: Record<string, unknown>): ToolCallStatus {
  if (item.success === false || item.error != null) return "failed";
  return completedStatus(item.status);
}

function mcpToolStatus(item: Record<string, unknown>): ToolCallStatus {
  if (item.error != null) return "failed";
  return completedStatus(item.status);
}

function publicStatus(status: ToolCallStatus): StructuredToolCall["status"] {
  return status === "requested" ? "unknown" : status;
}

function syntheticId(parentCallId: string | null, kind: string, ordinal: number): string | null {
  return parentCallId ? `${parentCallId}#${kind}-${ordinal}` : null;
}

function baseName(name: string): string {
  return name.split(/[.:/]/).filter(Boolean).at(-1) ?? "";
}

function pathText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const object = record(value);
  return text(object?.path ?? object?.value ?? object?.display) || null;
}

function timestampFrom(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1_000;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim()) return numeric > 1e12 ? numeric : numeric * 1_000;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function durationMilliseconds(durationMsValue: unknown, durationValue: unknown): number | null {
  const direct = Number(durationMsValue);
  if (durationMsValue !== null && durationMsValue !== undefined && Number.isFinite(direct) && direct >= 0) {
    return Math.round(direct);
  }
  const duration = record(durationValue);
  if (!duration) return null;
  const secs = Number(duration.secs);
  const nanos = Number(duration.nanos);
  if ((!Number.isFinite(secs) && !Number.isFinite(nanos)) || secs < 0 || nanos < 0) return null;
  return Math.round((Number.isFinite(secs) ? secs : 0) * 1_000 + (Number.isFinite(nanos) ? nanos : 0) / 1_000_000);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function completedItemShape(value: unknown): { type: string; item: Record<string, unknown> } | null {
  const item = record(value);
  if (!item) return null;
  const tagged = normalizeType(item.type);
  if (tagged) return { type: tagged, item };
  for (const [key, nested] of Object.entries(item)) {
    const object = record(nested);
    if (object) return { type: normalizeType(key), item: object };
  }
  return null;
}

function normalizeType(value: unknown): string {
  return text(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


/** Extract raw tool-call evidence from parsed Codex session JSONL records. */
export function collectCodexToolCallObservations(rows: readonly unknown[]): ToolCallObservation[] {
  const collector = new CodexToolCallCollector();
  for (const row of rows) collector.consume(row);
  return collector.state.observations;
}

/** Correlate observations of the same call into deduplicated structured calls. */
export function correlateCodexToolCalls(observations: readonly ToolCallObservation[]): StructuredToolCall[] {
  const collector = new CodexToolCallCollector({
    observations: [...observations],
    cwd: null,
    declaredSessionFormat: null,
    sawToolCompletion: observations.some((item) => item.evidence === "item-completed"),
  });
  return collector.finish();
}

/** Extract correlated structured tool calls from parsed Codex session records. */
export function extractCodexStructuredToolCalls(rows: readonly unknown[]): StructuredToolCall[] {
  const collector = new CodexToolCallCollector();
  for (const row of rows) collector.consume(row);
  return collector.finish();
}
