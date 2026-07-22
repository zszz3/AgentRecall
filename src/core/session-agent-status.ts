import type { SessionMessage, SessionSearchResult, SessionTraceEvent } from "./types";

export type SessionAgentState =
  | "running"
  | "waiting_agent"
  | "waiting_user"
  | "failed"
  | "interrupted"
  | "unknown";

export type SessionAgentTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface SessionAgentTodo {
  id: string;
  content: string;
  status: SessionAgentTodoStatus;
}

export interface SessionAgentToolUsage {
  name: string;
  count: number;
  failureCount: number;
  unknownCount: number;
}

export interface SessionAgentFailure {
  title: string;
  detail: string;
  timestamp: string;
}

export interface SessionAgentStatus {
  state: SessionAgentState;
  latestUserRequest: string | null;
  todos: SessionAgentTodo[];
  toolCallCount: number;
  tools: SessionAgentToolUsage[];
  failureCount: number;
  latestFailure: SessionAgentFailure | null;
  compactionCount: number;
  abortedCount: number;
  projectPath: string;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  messageCount: number;
  traceEventCount: number;
  analyzedAt: string;
}

export interface AnalyzeSessionAgentStatusInput {
  session: { projectPath: string; messageCount?: number };
  messages: SessionMessage[];
  traceEvents: SessionTraceEvent[];
  live: boolean;
  analyzedAt?: Date;
}

export interface SessionAgentStatusDataSource {
  getSession(sessionKey: string): SessionSearchResult | null;
  getMessageCount(sessionKey: string): number;
  getMessages(sessionKey: string, offset?: number, limit?: number): SessionMessage[];
  getTraceEvents(sessionKey: string): SessionTraceEvent[];
}

export const SESSION_AGENT_STATUS_MESSAGE_WINDOW = 200;

type ObservedStatus = "success" | "failure" | "unknown";

interface ToolInvocation {
  key: string;
  name: string;
  namePriority: number;
  status: ObservedStatus;
  detail: string;
  timestamp: string;
  order: number;
}

interface FailureEvidence extends SessionAgentFailure {
  key: string;
  timestampMs: number | null;
  order: number;
}

const FULL_PLAN_TOOLS = new Set(["update_plan", "todowrite", "rewrite_todo_list", "write_todos"]);
const PLAN_UPDATE_TOOLS = new Set(["update_todo_status", "update_plan_item", "todo_update"]);
const FRAMEWORK_META_MESSAGE = /^<(agent_status|system-reminder)\b/i;
const TEXT_PREVIEW_LIMIT = 240;

function compactText(value: string, limit = TEXT_PREVIEW_LIMIT): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function parseTimestamp(timestamp: string): number | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toolName(title: string): string {
  return title.split(" ·", 1)[0]?.trim() || "tool";
}

function eventType(event: SessionTraceEvent): string {
  return (event.eventType || event.title).trim().toLocaleLowerCase();
}

function isStateEvent(event: SessionTraceEvent): boolean {
  const type = eventType(event);
  return type === "error" || type === "context_compacted" || type === "turn_aborted";
}

function mergeStatus(current: ObservedStatus, next: SessionTraceEvent["status"]): ObservedStatus {
  if (current === "failure" || next === "failure") return "failure";
  if (current === "success" || next === "success") return "success";
  return "unknown";
}

function newerObservation(current: ToolInvocation, event: SessionTraceEvent): boolean {
  const currentTime = parseTimestamp(current.timestamp);
  const eventTime = parseTimestamp(event.timestamp);
  if (currentTime !== null && eventTime !== null) return eventTime >= currentTime;
  return event.index >= current.order;
}

function aggregateInvocations(traceEvents: SessionTraceEvent[]): ToolInvocation[] {
  const invocations = new Map<string, ToolInvocation>();

  for (const event of traceEvents) {
    if (event.kind === "tool_result" || isStateEvent(event)) continue;
    if (event.kind !== "tool_call" && event.kind !== "event") continue;

    const key = event.callId ? `call:${event.callId}` : `event:${event.index}`;
    const priority = event.kind === "tool_call" ? 2 : 1;
    const existing = invocations.get(key);
    if (!existing) {
      invocations.set(key, {
        key,
        name: toolName(event.title),
        namePriority: priority,
        status: event.status || "unknown",
        detail: compactText(event.detail),
        timestamp: event.timestamp,
        order: event.index,
      });
      continue;
    }

    existing.status = mergeStatus(existing.status, event.status);
    if (priority > existing.namePriority) {
      existing.name = toolName(event.title);
      existing.namePriority = priority;
    }
    if (event.status === "failure" || newerObservation(existing, event)) {
      existing.detail = compactText(event.detail);
      existing.timestamp = event.timestamp;
      existing.order = event.index;
    }
  }

  return [...invocations.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstString(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function todoStatus(value: unknown): SessionAgentTodoStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLocaleLowerCase().replaceAll("-", "_");
  if (normalized === "pending") return "pending";
  if (normalized === "in_progress" || normalized === "active") return "in_progress";
  if (normalized === "completed" || normalized === "complete" || normalized === "done") return "completed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return null;
}

function todoId(value: Record<string, unknown>, fallback: string): string {
  const raw = value.id ?? value.todo_id ?? value.todoId;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return fallback;
}

function todoFromValue(value: unknown, fallbackId: string): SessionAgentTodo | null {
  if (!isRecord(value)) return null;
  const content = compactText(firstString(value, ["step", "content", "task", "title"]));
  const status = todoStatus(value.status);
  if (!content || !status) return null;
  return { id: todoId(value, fallbackId), content, status };
}

function extractStructuredTodos(traceEvents: SessionTraceEvent[]): SessionAgentTodo[] {
  const todos = new Map<string, SessionAgentTodo>();
  let order: string[] = [];

  for (const event of traceEvents) {
    if (event.kind !== "tool_call") continue;
    const name = toolName(event.title).toLocaleLowerCase();
    if (!FULL_PLAN_TOOLS.has(name) && !PLAN_UPDATE_TOOLS.has(name)) continue;
    const payload = parseObject(event.detail);
    if (!payload) continue;

    if (FULL_PLAN_TOOLS.has(name)) {
      const rawItems = Array.isArray(payload.plan) ? payload.plan : Array.isArray(payload.todos) ? payload.todos : null;
      if (!rawItems) continue;
      const nextTodos = new Map<string, SessionAgentTodo>();
      const nextOrder: string[] = [];
      rawItems.forEach((item, index) => {
        const parsed = todoFromValue(item, `${event.index}:${index}`);
        if (!parsed) return;
        nextTodos.set(parsed.id, parsed);
        nextOrder.push(parsed.id);
      });
      todos.clear();
      for (const [id, todo] of nextTodos) todos.set(id, todo);
      order = nextOrder;
      continue;
    }

    const id = todoId(payload, "");
    const status = todoStatus(payload.status);
    if (!id || !status) continue;
    const existing = todos.get(id);
    if (existing) {
      todos.set(id, { ...existing, status });
      continue;
    }
    const created = todoFromValue(payload, id);
    if (created) {
      todos.set(id, created);
      order.push(id);
    }
  }

  return order.flatMap((id) => {
    const todo = todos.get(id);
    return todo ? [todo] : [];
  });
}

function meaningfulMessages(messages: SessionMessage[]): SessionMessage[] {
  return messages.filter((message) => {
    if (!message.content.trim()) return false;
    return message.role !== "user" || !FRAMEWORK_META_MESSAGE.test(message.content.trim());
  });
}

function latestUserRequest(messages: SessionMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const content = message.content.trim();
    if (!content || FRAMEWORK_META_MESSAGE.test(content)) continue;
    return compactText(content);
  }
  return null;
}

function latestTerminalState(
  messages: SessionMessage[],
  traceEvents: SessionTraceEvent[],
): Exclude<SessionAgentState, "running" | "waiting_agent" | "waiting_user" | "unknown"> | null {
  const lastMessage = messages.at(-1);
  const lastMessageTime = lastMessage ? parseTimestamp(lastMessage.timestamp) : null;
  const candidates = traceEvents.flatMap((event) => {
    const type = eventType(event);
    const state: "interrupted" | "failed" | null = type === "turn_aborted"
      ? "interrupted"
      : type === "error" || event.status === "failure"
        ? "failed"
        : null;
    const timestampMs = parseTimestamp(event.timestamp);
    return state && timestampMs !== null ? [{ state, timestampMs, order: event.index }] : [];
  });
  candidates.sort((left, right) => left.timestampMs - right.timestampMs || left.order - right.order);
  const latest = candidates.at(-1);
  if (!latest) return null;
  if (lastMessageTime !== null && latest.timestampMs < lastMessageTime) return null;
  return latest.state;
}

function classifyState(
  live: boolean,
  messages: SessionMessage[],
  traceEvents: SessionTraceEvent[],
): SessionAgentState {
  if (live) return "running";
  const visibleMessages = meaningfulMessages(messages);
  const terminal = latestTerminalState(visibleMessages, traceEvents);
  if (terminal) return terminal;
  const lastMessage = visibleMessages.at(-1);
  if (lastMessage?.role === "user") return "waiting_agent";
  if (lastMessage?.role === "assistant") return "waiting_user";
  return "unknown";
}

function activityRange(
  messages: SessionMessage[],
  traceEvents: SessionTraceEvent[],
): { firstActivityAt: string | null; lastActivityAt: string | null } {
  const observations = [
    ...messages.map((message) => message.timestamp),
    ...traceEvents.map((event) => event.timestamp),
  ].flatMap((timestamp) => {
    const timestampMs = parseTimestamp(timestamp);
    return timestampMs === null ? [] : [{ timestamp, timestampMs }];
  });
  observations.sort((left, right) => left.timestampMs - right.timestampMs);
  return {
    firstActivityAt: observations.at(0)?.timestamp ?? null,
    lastActivityAt: observations.at(-1)?.timestamp ?? null,
  };
}

function failureEvidence(invocations: ToolInvocation[], traceEvents: SessionTraceEvent[]): FailureEvidence[] {
  const evidence = new Map<string, FailureEvidence>();
  for (const invocation of invocations) {
    if (invocation.status !== "failure") continue;
    evidence.set(invocation.key, {
      key: invocation.key,
      title: invocation.name,
      detail: invocation.detail,
      timestamp: invocation.timestamp,
      timestampMs: parseTimestamp(invocation.timestamp),
      order: invocation.order,
    });
  }

  for (const event of traceEvents) {
    if (eventType(event) !== "error") continue;
    const key = event.callId ? `call:${event.callId}` : `error:${event.index}`;
    const candidate: FailureEvidence = {
      key,
      title: toolName(event.title),
      detail: compactText(event.detail),
      timestamp: event.timestamp,
      timestampMs: parseTimestamp(event.timestamp),
      order: event.index,
    };
    const current = evidence.get(key);
    if (!current || (candidate.timestampMs ?? candidate.order) >= (current.timestampMs ?? current.order)) {
      evidence.set(key, candidate);
    }
  }

  return [...evidence.values()].sort((left, right) => {
    if (left.timestampMs !== null && right.timestampMs !== null) return left.timestampMs - right.timestampMs;
    if (left.timestampMs !== null) return 1;
    if (right.timestampMs !== null) return -1;
    return left.order - right.order;
  });
}

function aggregateTools(invocations: ToolInvocation[]): SessionAgentToolUsage[] {
  const tools = new Map<string, SessionAgentToolUsage>();
  for (const invocation of invocations) {
    const current = tools.get(invocation.name) || {
      name: invocation.name,
      count: 0,
      failureCount: 0,
      unknownCount: 0,
    };
    current.count += 1;
    if (invocation.status === "failure") current.failureCount += 1;
    if (invocation.status === "unknown") current.unknownCount += 1;
    tools.set(invocation.name, current);
  }
  return [...tools.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

export function analyzeSessionAgentStatus(input: AnalyzeSessionAgentStatusInput): SessionAgentStatus {
  const invocations = aggregateInvocations(input.traceEvents);
  const failures = failureEvidence(invocations, input.traceEvents);
  const latestFailure = failures.at(-1);
  const analyzedAt = input.analyzedAt && Number.isFinite(input.analyzedAt.getTime()) ? input.analyzedAt : new Date();
  const activity = activityRange(input.messages, input.traceEvents);

  return {
    state: classifyState(input.live, input.messages, input.traceEvents),
    latestUserRequest: latestUserRequest(input.messages),
    todos: extractStructuredTodos(input.traceEvents),
    toolCallCount: invocations.length,
    tools: aggregateTools(invocations),
    failureCount: failures.length,
    latestFailure: latestFailure
      ? { title: latestFailure.title, detail: latestFailure.detail, timestamp: latestFailure.timestamp }
      : null,
    compactionCount: input.traceEvents.filter((event) => eventType(event) === "context_compacted").length,
    abortedCount: input.traceEvents.filter((event) => eventType(event) === "turn_aborted").length,
    projectPath: input.session.projectPath,
    ...activity,
    messageCount: input.session.messageCount ?? input.messages.length,
    traceEventCount: input.traceEvents.length,
    analyzedAt: analyzedAt.toISOString(),
  };
}

export function analyzeIndexedSessionAgentStatus(
  source: SessionAgentStatusDataSource,
  sessionKey: string,
  live: boolean,
  analyzedAt = new Date(),
): SessionAgentStatus | null {
  const session = source.getSession(sessionKey);
  if (!session) return null;
  const messageCount = source.getMessageCount(sessionKey);
  const offset = Math.max(0, messageCount - SESSION_AGENT_STATUS_MESSAGE_WINDOW);
  const messages = source.getMessages(sessionKey, offset, SESSION_AGENT_STATUS_MESSAGE_WINDOW);
  const traceEvents = source.getTraceEvents(sessionKey);
  return analyzeSessionAgentStatus({
    session: { projectPath: session.projectPath, messageCount },
    messages,
    traceEvents,
    live,
    analyzedAt,
  });
}
