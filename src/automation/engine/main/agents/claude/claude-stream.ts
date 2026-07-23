import type { AgentEvent } from "../../../shared/types";
import { normalizeAnthropicUsage } from "../../../../../shared/runtime/usage";

export interface ClaudeStreamState {
  lastText: string;
  toolNames: Map<string, string>;
}

export function createClaudeStreamState(): ClaudeStreamState {
  return {
    lastText: "",
    toolNames: new Map(),
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(value: string, maxLength = 1600): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trimEnd()}\n...`;
}

function formatToolInput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractToolResultContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const item = part as Record<string, unknown>;
        return asString(item.text) || asString(item.output_text) || asString(item.content);
      })
      .join("")
      .trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return asString(record.text) || asString(record.output_text) || asString(record.content);
  }
  return "";
}

function extractContentBlocks(message: unknown): Record<string, unknown>[] {
  if (!message || typeof message !== "object") return [];
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object");
}

function normalizeClaudeToolEvents(message: unknown, state?: ClaudeStreamState): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const block of extractContentBlocks(message)) {
    const blockType = asString(block.type);
    if (blockType === "tool_use" || blockType === "server_tool_use" || blockType === "mcp_tool_use" || blockType === "custom_tool_use") {
      const id = asString(block.id) || asString(block.tool_use_id) || asString(block.toolUseId);
      const name = asString(block.name) || asString(block.tool_name) || asString(block.toolName) || "tool";
      if (id && state) state.toolNames.set(id, name);
      events.push({
        type: "tool_call",
        name,
        content: name.toLowerCase().includes("workflow_node_complete")
          ? formatToolInput(block.input)
          : truncate(formatToolInput(block.input), 600),
        ...(id ? { metadata: { id } } : {}),
      });
    } else if (blockType === "tool_result" || blockType === "mcp_tool_result" || blockType === "custom_tool_result") {
      const id = asString(block.tool_use_id) || asString(block.toolUseId) || asString(block.id);
      const name = (id && state?.toolNames.get(id)) || asString(block.name) || asString(block.tool_name) || "tool";
      events.push({
        type: "tool_result",
        name,
        content: truncate(extractToolResultContent(block.content)),
        ...(id ? { metadata: { id } } : {}),
      });
    }
  }
  return events;
}

function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const content = record.content;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const item = part as Record<string, unknown>;
        const partType = asString(item.type);
        if (partType && partType !== "text" && partType !== "output_text") return "";
        return asString(item.text) || asString(item.output_text);
      })
      .join("")
      .trim();
  }

  return "";
}

function consumeTextDelta(text: string, state: ClaudeStreamState): string {
  if (!text) return "";
  if (!state.lastText) {
    state.lastText = text;
    return text;
  }
  if (text === state.lastText || state.lastText.endsWith(text)) return "";
  if (text.startsWith(state.lastText)) {
    const delta = text.slice(state.lastText.length);
    state.lastText = text;
    return delta;
  }

  state.lastText += text;
  return text;
}

function normalizeClaudeUsage(record: Record<string, unknown>): ReturnType<typeof normalizeAnthropicUsage> {
  const usage = normalizeAnthropicUsage(record.usage);
  const modelUsage = record.modelUsage && typeof record.modelUsage === "object" ? record.modelUsage as Record<string, unknown> : undefined;
  const estimatedCost: number | undefined = modelUsage
    ? Object.values(modelUsage).reduce<number>((total, value) => {
        if (!value || typeof value !== "object") return total;
        const cost = (value as Record<string, unknown>).costUSD;
        return total + (typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0);
      }, 0)
    : undefined;
  if (!usage && estimatedCost === undefined) return undefined;
  return {
    ...(usage ?? { provider: "anthropic" }),
    ...(estimatedCost !== undefined ? { estimatedCost } : {}),
  };
}

export function normalizeClaudeStreamEvent(raw: unknown, state?: ClaudeStreamState): AgentEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const type = asString(record.type);

  if (type === "stream_event") {
    const event = record.event;
    if (!event || typeof event !== "object") return [];
    const eventRecord = event as Record<string, unknown>;
    if (asString(eventRecord.type) !== "content_block_delta") return [];
    const delta = eventRecord.delta;
    if (!delta || typeof delta !== "object") return [];
    const deltaRecord = delta as Record<string, unknown>;
    if (asString(deltaRecord.type) !== "text_delta") return [];
    const text = asString(deltaRecord.text);
    if (!text) return [];
    if (state) state.lastText += text;
    return [{ type: "delta", content: text }];
  }

  if (type === "assistant" || type === "message") {
    const message = record.message ?? record;
    const events = normalizeClaudeToolEvents(message, state);
    const text = extractText(message);
    const delta = state ? consumeTextDelta(text, state) : text;
    if (delta) events.push({ type: "delta", content: delta });
    return events;
  }

  if (type === "result") {
    const events: AgentEvent[] = [];
    const usage = normalizeClaudeUsage(record);
    if (usage) events.push({ type: "usage", usage });
    const sessionId = asString(record.session_id);
    if (sessionId) {
      events.push({
        type: "runtime_conversation",
        runtimeConversation: {
          runtimeId: "claude",
          codecVersion: "v1",
          payload: { native: { sessionId } },
        },
      });
    }

    const text = asString(record.result) || extractText(record);
    if (text && state?.lastText && text.startsWith(state.lastText) && text !== state.lastText) {
      const delta = consumeTextDelta(text, state);
      if (delta) events.push({ type: "delta", content: delta });
      events.push({ type: "completed" });
    } else if (text && !state?.lastText) {
      if (state) state.lastText = text;
      events.push({ type: "completed", content: text });
    } else {
      events.push({ type: "completed" });
    }
    return events;
  }

  if (type === "system") {
    return [];
  }

  if (type === "error") {
    const text = asString(record.message) || asString(record.error) || "Claude Code error";
    return [{ type: "error", error: text }];
  }

  return [];
}
