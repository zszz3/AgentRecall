import type { IndexedSession, SessionMessage, SessionSearchResult, SessionTraceEvent } from "./types";
import { sessionSourceLabel } from "./session-sources";

export type SessionJsonExportFormat = "openai_chat" | "openai_responses" | "anthropic";

const EXPORTED_MODEL_PLACEHOLDER = "YOUR_MODEL";

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatMessageTime(ts: string): string {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function traceMarker(event: SessionTraceEvent): string {
  if (event.kind === "tool_call") return "→";
  if (event.status === "success") return "✓";
  if (event.status === "failure") return "✗";
  return "•";
}

function traceTitle(event: SessionTraceEvent): string {
  const eventType = event.eventType ? ` · ${event.eventType}` : "";
  const callId = event.callId ? ` · \`${event.callId}\`` : "";
  const time = formatMessageTime(event.timestamp);
  const timeSuffix = time ? ` · *${time}*` : "";
  return `${traceMarker(event)} ${event.title}${eventType}${callId}${timeSuffix}`;
}

function formatTraceMarkdown(traceEvents: SessionTraceEvent[]): string[] {
  if (traceEvents.length === 0) return [];
  return [
    "## Tool Trace",
    "",
    ...traceEvents.flatMap((event) => [
      `### ${traceTitle(event)}`,
      "",
      event.detail ? `\`\`\`text\n${event.detail}\n\`\`\`` : "_No detail captured._",
      "",
      "---",
      "",
    ]),
  ];
}

export function formatSessionMarkdown(
  session: SessionSearchResult | IndexedSession,
  messages: SessionMessage[],
  traceEvents: SessionTraceEvent[] = [],
): string {
  const title = "displayTitle" in session ? session.displayTitle : session.firstQuestion || session.originalTitle;
  const source = sessionSourceLabel(session.source);
  const header = [
    `# ${title}`,
    "",
    `${source} · \`${session.projectPath}\` · ${new Date(session.timestamp).toLocaleString()} · ${messages.length} messages`,
    "",
    "---",
    "",
  ];
  const body = messages.flatMap((message) => {
    const role = message.role === "user" ? "User" : "Assistant";
    const time = formatMessageTime(message.timestamp);
    return [`## ${time ? `${role} (${time})` : role}`, "", message.content, "", "---", ""];
  });
  return [...header, ...body, ...formatTraceMarkdown(traceEvents)].join("\n");
}

export function formatSessionPlainText(
  session: SessionSearchResult | IndexedSession,
  messages: SessionMessage[],
  traceEvents: SessionTraceEvent[] = [],
): string {
  return formatSessionMarkdown(session, messages, traceEvents).replace(/^#+\s/gm, "");
}

export function formatSessionJson(
  messages: SessionMessage[],
  format: SessionJsonExportFormat,
  codexResponsesRequest?: Record<string, unknown> | null,
): string {
  if (codexResponsesRequest) {
    const body = format === "openai_responses"
      ? codexResponsesRequest
      : format === "anthropic"
        ? responsesToAnthropic(codexResponsesRequest)
        : responsesToChatCompletions(codexResponsesRequest);
    return `${JSON.stringify(body, null, 2)}\n`;
  }

  const conversation = messages.map(({ role, content }) => ({ role, content }));
  const body = format === "openai_responses"
    ? {
        model: EXPORTED_MODEL_PLACEHOLDER,
        input: conversation,
        stream: false,
      }
    : format === "anthropic"
      ? {
          model: EXPORTED_MODEL_PLACEHOLDER,
          max_tokens: 4096,
          messages: conversation,
          stream: false,
        }
      : {
          model: EXPORTED_MODEL_PLACEHOLDER,
          messages: conversation,
          stream: false,
        };

  return `${JSON.stringify(body, null, 2)}\n`;
}

function responsesToChatCompletions(request: Record<string, unknown>): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (typeof request.instructions === "string" && request.instructions) {
    messages.push({ role: "developer", content: request.instructions });
  }
  let pendingToolCalls: Record<string, unknown>[] = [];
  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
    pendingToolCalls = [];
  };
  for (const item of Array.isArray(request.input) ? request.input : []) {
    if (!isObject(item)) continue;
    if (item.type === "message") {
      flushToolCalls();
      messages.push({ role: item.role, content: responseContentText(item.content) });
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const custom = item.type === "custom_tool_call";
      pendingToolCalls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: qualifiedToolName(item.namespace, item.name),
          arguments: custom
            ? safeJsonStringify({ input: item.input ?? "" })
            : typeof item.arguments === "string" ? item.arguments : safeJsonStringify(item.arguments ?? {}),
        },
      });
    } else if (item.type === "function_call_output") {
      flushToolCalls();
      messages.push({ role: "tool", tool_call_id: item.call_id, content: serializeToolOutput(item.output) });
    } else if (item.type === "custom_tool_call_output") {
      flushToolCalls();
      messages.push({ role: "tool", tool_call_id: item.call_id, content: serializeToolOutput(item.output) });
    }
  }
  flushToolCalls();

  const body: Record<string, unknown> = {
    model: request.model ?? EXPORTED_MODEL_PLACEHOLDER,
    messages,
    stream: request.stream ?? false,
  };
  const tools = responseToolsToChat(request.tools);
  if (tools.length > 0) body.tools = tools;
  if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
  if (request.parallel_tool_calls !== undefined) body.parallel_tool_calls = request.parallel_tool_calls;
  if (request.metadata !== undefined) body.metadata = request.metadata;
  return body;
}

function responsesToAnthropic(request: Record<string, unknown>): Record<string, unknown> {
  const systemParts: string[] = typeof request.instructions === "string" && request.instructions
    ? [request.instructions]
    : [];
  const messages: Record<string, unknown>[] = [];
  for (const item of Array.isArray(request.input) ? request.input : []) {
    if (!isObject(item)) continue;
    if (item.type === "message") {
      const text = responseContentText(item.content);
      if (item.role === "system" || item.role === "developer") {
        if (text) systemParts.push(text);
      } else if (text) {
        appendAnthropicContent(messages, item.role === "assistant" ? "assistant" : "user", [{ type: "text", text }]);
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const custom = item.type === "custom_tool_call";
      const rawInput = custom ? { input: item.input ?? "" } : parseToolInput(item.arguments);
      appendAnthropicContent(messages, "assistant", [{
        type: "tool_use",
        id: item.call_id,
        name: qualifiedToolName(item.namespace, item.name),
        input: rawInput,
      }]);
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      appendAnthropicContent(messages, "user", [{
        type: "tool_result",
        tool_use_id: item.call_id,
        content: anthropicToolResultContent(item.output),
      }]);
    }
  }

  const body: Record<string, unknown> = {
    model: request.model ?? EXPORTED_MODEL_PLACEHOLDER,
    max_tokens: 4096,
    messages,
    stream: request.stream ?? false,
  };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");
  const tools = responseToolsToAnthropic(request.tools);
  if (tools.length > 0) body.tools = tools;
  if (request.metadata !== undefined) body.metadata = request.metadata;
  return body;
}

function responseToolsToChat(value: unknown): Record<string, unknown>[] {
  return flattenResponseTools(value).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  }));
}

function responseToolsToAnthropic(value: unknown): Record<string, unknown>[] {
  return flattenResponseTools(value).map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
  }));
}

function flattenResponseTools(value: unknown, namespace?: string): Array<{
  name: string;
  description: string;
  parameters: unknown;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tool) => {
    if (!isObject(tool) || typeof tool.name !== "string") return [];
    if (tool.type === "namespace") {
      return flattenResponseTools(tool.tools, namespace ? `${namespace}/${tool.name}` : tool.name);
    }
    if (tool.type === "function") {
      return [{
        name: qualifiedToolName(namespace ?? tool.namespace, tool.name),
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.parameters ?? { type: "object", properties: {} },
      }];
    }
    if (tool.type === "custom") {
      return [{
        name: qualifiedToolName(namespace ?? tool.namespace, tool.name),
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
      }];
    }
    return [];
  });
}

function appendAnthropicContent(
  messages: Record<string, unknown>[],
  role: "user" | "assistant",
  blocks: Record<string, unknown>[],
): void {
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    previous.content.push(...blocks);
    return;
  }
  messages.push({ role, content: blocks });
}

function qualifiedToolName(namespace: unknown, name: unknown): string {
  const toolName = typeof name === "string" && name ? name : "tool";
  if (typeof namespace !== "string" || !namespace) return sanitizeToolName(toolName);
  const namespaceParts = namespace.split(/[/.]+/).filter(Boolean).map(sanitizeToolName);
  return [...namespaceParts, sanitizeToolName(toolName)].join("__");
}

function sanitizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function serializeToolOutput(value: unknown): string {
  return typeof value === "string" ? value : safeJsonStringify(value ?? "");
}

function anthropicToolResultContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  const blocks = isObject(value) && Array.isArray(value.content) ? value.content : value;
  if (Array.isArray(blocks) && blocks.every((item) => isObject(item) && typeof item.type === "string")) {
    return blocks.map((item) => {
      if (!isObject(item)) return item;
      return item.type === "input_text" || item.type === "output_text" ? { ...item, type: "text" } : item;
    });
  }
  return safeJsonStringify(value ?? "");
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function responseContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!isObject(part)) return [];
    return typeof part.text === "string" ? [part.text] : [];
  }).join("\n");
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { input: value };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
