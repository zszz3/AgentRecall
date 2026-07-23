import type { AgentEvent } from "../../../shared/types";
import { normalizeOpenAIUsage } from "../../../../../shared/runtime/usage";

export interface CodexStreamState {
  lastText: string;
  lastError: string;
  toolNames: Map<string, string>;
}

export function createCodexStreamState(): CodexStreamState {
  return {
    lastText: "",
    lastError: "",
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

function formatArguments(value: unknown): string {
  const raw = asString(value);
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const command = asString(record.command) || asString(record.cmd);
      if (command) {
        const workdir = asString(record.workdir) || asString(record.cwd);
        return [command, workdir ? `workdir: ${workdir}` : ""].filter(Boolean).join("\n");
      }
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Fall through to raw arguments.
  }

  return raw;
}

function extractToolOutput(item: Record<string, unknown>): string {
  const output = asString(item.output);
  if (output) return output.trim();

  const content = item.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const rec = part as Record<string, unknown>;
        return asString(rec.text) || asString(rec.output_text) || asString(rec.content);
      })
      .join("")
      .trim();
  }

  return "";
}

function normalizeToolItem(item: Record<string, unknown> | undefined, state: CodexStreamState): AgentEvent[] {
  if (!item) return [];

  const itemType = asString(item.type);
  if (itemType === "function_call") {
    const name = asString(item.name) || "tool";
    const callId = asString(item.call_id) || asString(item.callId) || asString(item.id);
    if (callId) state.toolNames.set(callId, name);

    const args = truncate(formatArguments(item.arguments), 600);
    return [{ type: "tool_call", name, content: args }];
  }

  if (itemType === "function_call_output") {
    const callId = asString(item.call_id) || asString(item.callId) || asString(item.id);
    const name = (callId && state.toolNames.get(callId)) || "tool";
    const output = truncate(extractToolOutput(item));
    return [{ type: "tool_result", name, content: output }];
  }

  return [];
}

function extractItemText(item: Record<string, unknown> | undefined): string {
  if (!item) return "";
  const role = asString(item.role);
  if (role && role !== "assistant") return "";

  const itemType = asString(item.type);
  if (itemType && itemType !== "message") return "";

  if (typeof item.text === "string") return item.text;

  const content = item.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const rec = part as Record<string, unknown>;
        const partType = asString(rec.type);
        if (partType && partType !== "output_text" && partType !== "text") return "";
        return asString(rec.text) || asString(rec.output_text) || asString(rec.content);
      })
      .join("")
      .trim();
  }

  return "";
}

function normalizeCodexUsage(value: unknown): ReturnType<typeof normalizeOpenAIUsage> {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const source = (record.last && typeof record.last === "object" ? record.last : record.usage && typeof record.usage === "object" ? record.usage : record) as Record<string, unknown>;
  return normalizeOpenAIUsage({
    input_tokens: source.input_tokens ?? source.prompt_tokens ?? source.inputTokens,
    output_tokens: source.output_tokens ?? source.completion_tokens ?? source.outputTokens,
    total_tokens: source.total_tokens ?? source.totalTokens,
    prompt_tokens_details: source.prompt_tokens_details ?? { cached_tokens: source.cached_tokens ?? source.cachedInputTokens },
    completion_tokens_details: source.completion_tokens_details ?? { reasoning_tokens: source.reasoning_tokens ?? source.reasoningOutputTokens },
  });
}

export function normalizeCodexNotification(
  method: string,
  params: Record<string, unknown>,
  state: CodexStreamState,
): AgentEvent[] {
  if (method === "item/agentMessage/delta") {
    const delta = asString(params.delta);
    if (!delta) return [];
    state.lastText += delta;
    return [{ type: "delta", content: delta }];
  }

  if (method === "rawResponseItem/completed") {
    const item = params.item as Record<string, unknown> | undefined;
    const toolEvents = normalizeToolItem(item, state);
    if (toolEvents.length > 0) return toolEvents;

    const text = extractItemText(item);
    if (!text) return [];
    if (!state.lastText) {
      state.lastText = text;
      return [{ type: "delta", content: text }];
    }
    if (text === state.lastText || state.lastText.startsWith(text)) return [];
    if (text.startsWith(state.lastText)) {
      const delta = text.slice(state.lastText.length);
      state.lastText = text;
      return delta ? [{ type: "delta", content: delta }] : [];
    }
    return [];
  }

  if (method === "turn/started") {
    return [];
  }

  if (method === "turn/completed") {
    const turn = params.turn as Record<string, unknown> | undefined;
    const usage = normalizeCodexUsage(turn?.usage ?? turn?.tokenUsage ?? params.usage ?? params.tokenUsage);
    const usageEvents: AgentEvent[] = usage ? [{ type: "usage", usage }] : [];
    const status = asString(turn?.status) || "completed";
    if (status === "failed") {
      const error = asString(turn?.error) || "Codex turn failed";
      state.lastError = error;
      return [...usageEvents, { type: "error", error }];
    }
    const text = extractItemText(turn);
    if (!state.lastText && text) {
      state.lastText = text;
      return [...usageEvents, { type: "completed", content: text }];
    }
    return [...usageEvents, { type: "completed" }];
  }

  if (method === "thread/tokenUsage/updated" || method === "turn/tokenUsage/updated" || method === "tokenUsage/updated") {
    const usage = normalizeCodexUsage(params.tokenUsage ?? params.usage);
    return usage ? [{ type: "usage", usage }] : [];
  }

  if (method === "error") {
    const message = asString(params.message) || "Codex error";
    state.lastError = message;
    return [{ type: "error", error: message }];
  }

  if (method === "codex/event") {
    const msg = params.msg as Record<string, unknown> | undefined;
    if (!msg) return [];
    const type = asString(msg.type);
    if (type === "agent_message") {
      const text = asString(msg.message) || asString(msg.text);
      if (!text) return [];
      state.lastText += text;
      return [{ type: "delta", content: text }];
    }
  }

  return [];
}
