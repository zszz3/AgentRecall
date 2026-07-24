import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentChannel, AgentModelOption } from "../../shared/types";
import { DEFAULT_MODEL_ID, runtimeModelId } from "../../shared/models";

export interface CodexChatRouterServer {
  host: string;
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

export interface StartCodexChatRouterOptions {
  channels: () => AgentChannel[];
}

type JsonRecord = Record<string, unknown>;
type ChatMessage = JsonRecord & { role: "system" | "user" | "assistant" | "tool" };

interface ResponsesRequestBody {
  model?: unknown;
  instructions?: unknown;
  input?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  max_output_tokens?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  stream_options?: unknown;
  [key: string]: unknown;
}

interface ToolSpec {
  kind: "function" | "custom" | "namespace" | "tool_search";
  name: string;
  namespace?: string;
}

interface ToolContext {
  chatTools: unknown[];
  chatNameToSpec: Map<string, ToolSpec>;
  namespaceToolToChatName: Map<string, string>;
}

interface ChatToolCallState {
  callId: string;
  name: string;
  arguments: string;
  itemId: string;
  outputIndex?: number;
  added: boolean;
  done: boolean;
}

interface ResponsesStreamState {
  responseId: string;
  model: string;
  text: string;
  started: boolean;
  textAdded: boolean;
  nextOutputIndex: number;
  outputItems: Array<{ index: number; item: unknown }>;
  tools: Map<number, ChatToolCallState>;
  usage?: unknown;
  toolContext: ToolContext;
}

const ROUTER_ENV = "AGENT_RECALL_CODEX_ROUTER_BASE_URL";

export function setCodexChatRouterBaseUrl(baseUrl: string): void {
  process.env[ROUTER_ENV] = baseUrl.replace(/\/+$/, "");
}

export function codexChatRouterBaseUrl(): string | undefined {
  return process.env[ROUTER_ENV]?.replace(/\/+$/, "");
}

export function codexChannelNeedsChatRouting(channel: AgentChannel | undefined): boolean {
  return Boolean(
    channel?.agentId === "codex" &&
    channel.modelProvider &&
    channel.modelProvider !== "openai" &&
    channel.baseUrl &&
    channel.apiFormat !== "openai_responses",
  );
}

export function codexChatRouterUrlForChannel(channel: AgentChannel): string | undefined {
  const baseUrl = codexChatRouterBaseUrl();
  if (!baseUrl || !codexChannelNeedsChatRouting(channel)) return undefined;
  return `${baseUrl}/${encodeURIComponent(channel.id)}`;
}

export async function startCodexChatRouter(options: StartCodexChatRouterOptions): Promise<CodexChatRouterServer> {
  const host = "127.0.0.1";
  const server = http.createServer((request, response) => {
    void routeRequest(request, response, options.channels);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}/v1`,
    stop: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function routeRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  channels: () => AgentChannel[],
): Promise<void> {
  try {
    const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const { channel, endpoint } = routeParts(parsedUrl.pathname, channels());
    if (!channel) {
      jsonResponse(response, 404, { error: { message: "Unknown Codex route channel." } });
      return;
    }
    if (request.method === "GET" && endpoint === "models") {
      jsonResponse(response, 200, codexModelsPayload(channel.models));
      return;
    }
    if (request.method === "POST" && (endpoint === "responses" || endpoint === "responses/compact")) {
      const body = (await readJsonBody(request)) as ResponsesRequestBody;
      await proxyResponsesToChat(channel, body, response);
      return;
    }
    jsonResponse(response, 404, { error: { message: `Unsupported Codex route endpoint: ${endpoint}` } });
  } catch (error) {
    jsonResponse(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
  }
}

function routeParts(pathname: string, channels: AgentChannel[]): { channel: AgentChannel | undefined; endpoint: string } {
  const parts = pathname.split("/").filter(Boolean);
  const channelId = parts[0] === "v1" ? parts[1] : parts[0];
  const endpoint = (parts[0] === "v1" ? parts.slice(2) : parts.slice(1)).join("/");
  return {
    channel: channels.find((channel) => channel.id === channelId),
    endpoint,
  };
}

function codexModelsPayload(models: AgentModelOption[]): unknown {
  return {
    models: models
      .filter((model) => model.id !== DEFAULT_MODEL_ID)
      .map((model, index) => ({
        slug: model.id,
        display_name: model.label,
        description: `${model.label} via AgentRecall.`,
        default_reasoning_level: null,
        visibility: "list",
        priority: index + 1,
        supported_reasoning_levels: [],
        supports_reasoning_summaries: false,
        support_verbosity: false,
        default_verbosity: null,
        shell_type: "default",
        supported_in_api: true,
        context_window: 131072,
        effective_context_window_percent: 95,
        truncation_policy: {
          mode: "tokens",
          limit: 10000,
        },
        supports_parallel_tool_calls: true,
        supports_image_detail_original: false,
        input_modalities: ["text"],
        prefer_websockets: false,
        experimental_supported_tools: [],
        // Chat Completions providers cannot reliably participate in Codex's
        // client-side tool_search round trip. Keep the scoped MCP tools eager
        // so workflow_create/workflow_node_complete are sent to the model on
        // the first request instead of depending on model-initiated discovery.
        supports_search_tool: false,
        base_instructions: "",
      })),
  };
}

async function proxyResponsesToChat(channel: AgentChannel, body: ResponsesRequestBody, response: http.ServerResponse): Promise<void> {
  const upstreamUrl = channel.isFullUrl ? channel.baseUrl ?? "" : chatCompletionsUrl(channel.baseUrl ?? "");
  const model = resolveModel(channel, body.model);
  const toolContext = buildToolContext(body);
  const chatBody = {
    ...responsesToChatBody(body, model, toolContext),
    ...(channel.requestOverrides?.body ?? {}),
  };

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(channel.customUserAgent ? { "user-agent": channel.customUserAgent } : {}),
      ...(channel.httpHeaders ?? {}),
      ...(channel.requestOverrides?.headers ?? {}),
    },
    body: JSON.stringify(chatBody),
  });

  if (!upstream.ok) {
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(await upstream.text());
    return;
  }

  if (chatBody.stream) {
    await streamChatAsResponses(upstream, model, response, toolContext);
    return;
  }

  const payload = await upstream.json();
  jsonResponse(response, 200, chatCompletionToResponse(payload, model, toolContext));
}

function responsesToChatBody(body: ResponsesRequestBody, model: string, toolContext: ToolContext): JsonRecord {
  const chatBody: JsonRecord = {
    model,
    messages: responsesMessages(body, toolContext),
    stream: Boolean(body.stream),
    ...optionalNumberField("temperature", body.temperature),
    ...optionalNumberField("top_p", body.top_p),
    ...optionalNumberField("max_tokens", body.max_output_tokens),
    ...optionalNumberField("max_tokens", body.max_tokens),
    ...optionalNumberField("max_completion_tokens", body.max_completion_tokens),
  };

  if (toolContext.chatTools.length > 0) chatBody.tools = toolContext.chatTools;
  if (body.tool_choice !== undefined) chatBody.tool_choice = responsesToolChoiceToChat(body.tool_choice, toolContext);
  if (chatBody.stream) {
    chatBody.stream_options = {
      ...(isRecord(body.stream_options) ? body.stream_options : {}),
      include_usage: true,
    };
  }
  return chatBody;
}

function responsesMessages(body: ResponsesRequestBody, toolContext: ToolContext): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const instructions = instructionText(body.instructions);
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  appendInput(messages, body.input, toolContext);
  if (messages.length === 0) messages.push({ role: "user", content: "" });
  return messages;
}

function appendInput(messages: ChatMessage[], input: unknown, toolContext: ToolContext): void {
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return;
  }
  const items = Array.isArray(input) ? input : isRecord(input) ? [input] : [];
  const pendingToolCalls: unknown[] = [];
  const flushPendingToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls.splice(0),
      reasoning_content: "tool call",
    });
  };

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "function_call") {
      pendingToolCalls.push(responseFunctionCallToChatToolCall(record, toolContext));
      continue;
    }
    if (type === "custom_tool_call") {
      pendingToolCalls.push(responseCustomToolCallToChatToolCall(record));
      continue;
    }
    if (type === "tool_search_call") {
      pendingToolCalls.push(responseToolSearchCallToChatToolCall(record));
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output") {
      flushPendingToolCalls();
      const callId = stringField(record.call_id) || stringField(record.id) || "call_0";
      messages.push({ role: "tool", tool_call_id: callId, content: outputToText(record.output ?? record) });
      continue;
    }
    if (type === "reasoning") continue;

    flushPendingToolCalls();
    const role = normalizeRole(record.role);
    const content = contentToChatContent(record.content ?? record.text ?? record.input);
    if (content !== undefined) messages.push({ role, content });
  }
  flushPendingToolCalls();
}

function normalizeRole(value: unknown): ChatMessage["role"] {
  if (value === "system" || value === "developer") return "system";
  return value === "assistant" || value === "tool" ? value : "user";
}

function contentToChatContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      if (typeof record.refusal === "string") return record.refusal;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return parts || undefined;
}

function buildToolContext(body: ResponsesRequestBody): ToolContext {
  const context: ToolContext = {
    chatTools: [],
    chatNameToSpec: new Map(),
    namespaceToolToChatName: new Map(),
  };
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const tool of tools) addResponseTool(context, tool);
  collectToolSearchOutputTools(context, body.input);
  return context;
}

function addResponseTool(context: ToolContext, tool: unknown): void {
  if (typeof tool === "string") {
    addCustomTool(context, { type: "custom", name: tool });
    return;
  }
  if (!isRecord(tool)) return;
  const type = stringField(tool.type);
  if (type === "function") addFunctionTool(context, tool);
  if (type === "custom") addCustomTool(context, tool);
  if (type === "tool_search") addToolSearchTool(context);
  if (type === "namespace") addNamespaceTool(context, tool);
}

function addFunctionTool(context: ToolContext, tool: JsonRecord, namespace?: string): void {
  const name = responseToolName(tool);
  if (!name) return;
  const chatName = namespace ? flattenNamespaceToolName(namespace, name) : name;
  const functionPayload = isRecord(tool.function)
    ? { ...tool.function, name: chatName }
    : {
        name: chatName,
        description: stringField(tool.description) || "",
        parameters: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
      };
  addChatTool(context, chatName, { kind: namespace ? "namespace" : "function", name, ...(namespace ? { namespace } : {}) }, { type: "function", function: functionPayload });
}

function addCustomTool(context: ToolContext, tool: JsonRecord): void {
  const name = responseToolName(tool);
  if (!name) return;
  addChatTool(
    context,
    name,
    { kind: "custom", name },
    {
      type: "function",
      function: {
        name,
        description: stringField(tool.description) || "Custom Codex tool.",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string", description: "Input to pass to the custom Codex tool." },
          },
          required: ["input"],
        },
      },
    },
  );
}

function addToolSearchTool(context: ToolContext): void {
  addChatTool(
    context,
    "tool_search",
    { kind: "tool_search", name: "tool_search" },
    {
      type: "function",
      function: {
        name: "tool_search",
        description: "Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["query"],
        },
      },
    },
  );
}

function addNamespaceTool(context: ToolContext, tool: JsonRecord): void {
  const namespace = stringField(tool.name);
  const children = Array.isArray(tool.tools) ? tool.tools : Array.isArray(tool.children) ? tool.children : [];
  if (!namespace) return;
  for (const child of children) {
    if (isRecord(child) && stringField(child.type) === "function") addFunctionTool(context, child, namespace);
  }
}

function addChatTool(context: ToolContext, chatName: string, spec: ToolSpec, chatTool: unknown): void {
  if (!chatName || context.chatNameToSpec.has(chatName)) return;
  context.chatNameToSpec.set(chatName, spec);
  if (spec.namespace) context.namespaceToolToChatName.set(`${spec.namespace}\n${spec.name}`, chatName);
  context.chatTools.push(chatTool);
}

function collectToolSearchOutputTools(context: ToolContext, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolSearchOutputTools(context, item);
    return;
  }
  if (!isRecord(value)) return;
  if (stringField(value.type) === "tool_search_output" && Array.isArray(value.tools)) {
    for (const tool of value.tools) addResponseTool(context, tool);
  }
  for (const child of Object.values(value)) collectToolSearchOutputTools(context, child);
}

function responseFunctionCallToChatToolCall(item: JsonRecord, toolContext: ToolContext): unknown {
  const name = stringField(item.name) || "unknown_tool";
  const namespace = stringField(item.namespace);
  const chatName = namespace ? toolContext.namespaceToolToChatName.get(`${namespace}\n${name}`) || flattenNamespaceToolName(namespace, name) : name;
  return {
    id: stringField(item.call_id) || stringField(item.id) || "call_0",
    type: "function",
    function: {
      name: chatName,
      arguments: canonicalJsonString(item.arguments),
    },
  };
}

function responseCustomToolCallToChatToolCall(item: JsonRecord): unknown {
  return {
    id: stringField(item.call_id) || stringField(item.id) || "call_0",
    type: "function",
    function: {
      name: stringField(item.name) || "unknown_tool",
      arguments: JSON.stringify({ input: stringField(item.input) || "" }),
    },
  };
}

function responseToolSearchCallToChatToolCall(item: JsonRecord): unknown {
  return {
    id: stringField(item.call_id) || stringField(item.id) || "call_0",
    type: "function",
    function: {
      name: "tool_search",
      arguments: canonicalJsonString(item.arguments),
    },
  };
}

function responsesToolChoiceToChat(value: unknown, toolContext: ToolContext): unknown {
  if (!isRecord(value)) return value;
  const name = responseToolName(value);
  if (!name) return value;
  const namespace = stringField(value.namespace);
  const chatName = namespace ? toolContext.namespaceToolToChatName.get(`${namespace}\n${name}`) || flattenNamespaceToolName(namespace, name) : name;
  return { type: "function", function: { name: chatName } };
}

function responseToolName(tool: JsonRecord): string | undefined {
  return stringField(isRecord(tool.function) ? tool.function.name : undefined) || stringField(tool.name);
}

function flattenNamespaceToolName(namespace: string, name: string): string {
  return `${namespace}__${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function instructionText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => (typeof part === "string" ? part : isRecord(part) ? stringField(part.text) : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function outputToText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
}

function chatCompletionToResponse(payload: unknown, fallbackModel: string, toolContext: ToolContext): unknown {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const message = first.message && typeof first.message === "object" ? (first.message as Record<string, unknown>) : {};
  const text = typeof message.content === "string" ? message.content : "";
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const id = typeof record.id === "string" ? responseIdFromChatId(record.id) : `resp_${Date.now()}`;
  const model = typeof record.model === "string" ? record.model : fallbackModel;
  const output = [
    ...(text ? [responseMessageItem(text)] : []),
    ...toolCalls.map((toolCall, index) => chatToolCallToResponseItem(toolCall, index, toolContext)),
  ];
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage: chatUsageToResponsesUsage(record.usage),
  };
}

function chatToolCallToResponseItem(toolCall: unknown, index: number, toolContext: ToolContext, status = "completed"): unknown {
  const record = isRecord(toolCall) ? toolCall : {};
  const functionPayload = isRecord(record.function) ? record.function : {};
  const callId = stringField(record.id) || `call_${index}`;
  const chatName = stringField(functionPayload.name) || "unknown_tool";
  const args = canonicalJsonString(functionPayload.arguments);
  const spec = toolContext.chatNameToSpec.get(chatName);
  const itemId = spec?.kind === "custom" ? `ctc_${callId}` : `fc_${callId}`;
  if (spec?.kind === "custom") {
    return {
      id: itemId,
      type: "custom_tool_call",
      status,
      call_id: callId,
      name: spec.name,
      input: customToolInput(args),
    };
  }
  if (spec?.kind === "tool_search") {
    return {
      type: "tool_search_call",
      status,
      call_id: callId,
      execution: "client",
      arguments: parseArgumentsObject(args),
    };
  }
  return {
    id: itemId,
    type: "function_call",
    status,
    call_id: callId,
    name: spec?.name || chatName,
    ...(spec?.namespace ? { namespace: spec.namespace } : {}),
    arguments: args,
  };
}

async function streamChatAsResponses(upstream: Response, fallbackModel: string, response: http.ServerResponse, toolContext: ToolContext): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const state: ResponsesStreamState = {
    responseId: `resp_${Date.now()}`,
    model: fallbackModel,
    text: "",
    started: false,
    textAdded: false,
    nextOutputIndex: 0,
    outputItems: [],
    tools: new Map(),
    toolContext,
  };

  let buffer = "";
  for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += Buffer.from(chunk).toString("utf8");
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      handleChatSseBlock(response, state, block);
      separator = buffer.indexOf("\n\n");
    }
  }
  completeResponsesStream(response, state);
}

function handleChatSseBlock(response: http.ServerResponse, state: ResponsesStreamState, block: string): void {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  for (const data of dataLines) {
    if (!data || data === "[DONE]") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    updateStreamMetadata(state, payload);
    startResponsesStream(response, state);
    const delta = chatDeltaText(payload);
    if (delta) pushStreamTextDelta(response, state, delta);
    for (const toolCall of chatDeltaToolCalls(payload)) pushStreamToolCallDelta(response, state, toolCall);
  }
}

function updateStreamMetadata(state: ResponsesStreamState, payload: unknown): void {
  const record = isRecord(payload) ? payload : {};
  const id = stringField(record.id);
  if (id) state.responseId = responseIdFromChatId(id);
  const model = stringField(record.model);
  if (model) state.model = model;
  if (record.usage) state.usage = chatUsageToResponsesUsage(record.usage);
}

function startResponsesStream(response: http.ServerResponse, state: ResponsesStreamState): void {
  if (state.started) return;
  state.started = true;
  writeSse(response, "response.created", {
    type: "response.created",
    response: {
      id: state.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model: state.model,
      output: [],
      usage: state.usage ?? zeroUsage(),
    },
  });
}

function pushStreamTextDelta(response: http.ServerResponse, state: ResponsesStreamState, delta: string): void {
  startResponsesStream(response, state);
  if (!state.textAdded) {
    state.textAdded = true;
    writeSse(response, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_0", type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    writeSse(response, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: "msg_0",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    state.nextOutputIndex = Math.max(state.nextOutputIndex, 1);
  }
  state.text += delta;
  writeSse(response, "response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: "msg_0",
    output_index: 0,
    content_index: 0,
    delta,
  });
}

function pushStreamToolCallDelta(response: http.ServerResponse, state: ResponsesStreamState, toolCall: unknown): void {
  const record = isRecord(toolCall) ? toolCall : {};
  const index = typeof record.index === "number" ? record.index : 0;
  const functionPayload = isRecord(record.function) ? record.function : {};
  const current =
    state.tools.get(index) ??
    ({
      callId: "",
      name: "",
      arguments: "",
      itemId: "",
      added: false,
      done: false,
    } satisfies ChatToolCallState);
  current.callId = stringField(record.id) || current.callId || `call_${index}`;
  current.name = stringField(functionPayload.name) || current.name;
  current.arguments += stringField(functionPayload.arguments) || "";

  if (!current.added && current.name) {
    startResponsesStream(response, state);
    current.outputIndex = state.nextOutputIndex++;
    current.itemId = responseToolItemId(current.callId, current.name, state.toolContext);
    current.added = true;
    writeSse(response, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: current.outputIndex,
      item: responseToolItem(current.itemId, "in_progress", current.callId, current.name, "", state.toolContext),
    });
  }
  if (current.added && stringField(functionPayload.arguments) && !isCustomToolName(current.name, state.toolContext)) {
    writeSse(response, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: current.itemId,
      output_index: current.outputIndex,
      delta: stringField(functionPayload.arguments),
    });
  }
  state.tools.set(index, current);
}

function completeResponsesStream(response: http.ServerResponse, state: ResponsesStreamState): void {
  startResponsesStream(response, state);
  if (state.textAdded) {
    const item = responseMessageItem(state.text);
    state.outputItems.push({ index: 0, item });
    writeSse(response, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: "msg_0",
      output_index: 0,
      content_index: 0,
      text: state.text,
    });
    writeSse(response, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: "msg_0",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: state.text },
    });
    writeSse(response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    });
  }

  for (const tool of [...state.tools.values()].sort((a, b) => (a.outputIndex ?? 0) - (b.outputIndex ?? 0))) {
    if (!tool.added) {
      tool.outputIndex = state.nextOutputIndex++;
      tool.itemId = responseToolItemId(tool.callId, tool.name || "unknown_tool", state.toolContext);
      tool.added = true;
      writeSse(response, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: tool.outputIndex,
        item: responseToolItem(tool.itemId, "in_progress", tool.callId, tool.name || "unknown_tool", "", state.toolContext),
      });
    }
    const item = responseToolItem(tool.itemId, "completed", tool.callId, tool.name || "unknown_tool", canonicalJsonString(tool.arguments), state.toolContext);
    state.outputItems.push({ index: tool.outputIndex ?? 0, item });
    if (isCustomToolName(tool.name, state.toolContext)) {
      writeSse(response, "response.custom_tool_call_input.done", {
        type: "response.custom_tool_call_input.done",
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        input: customToolInput(tool.arguments),
      });
    } else {
      writeSse(response, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        arguments: canonicalJsonString(tool.arguments),
      });
    }
    writeSse(response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: tool.outputIndex,
      item,
    });
  }

  const output = state.outputItems.sort((a, b) => a.index - b.index).map(({ item }) => item);
  writeSse(response, "response.completed", {
    type: "response.completed",
    response: {
      id: state.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: state.model,
      output,
      usage: state.usage ?? zeroUsage(),
    },
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

function responseMessageItem(text: string): unknown {
  return {
    id: "msg_0",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

function chatDeltaText(payload: unknown): string {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const delta = first.delta && typeof first.delta === "object" ? (first.delta as Record<string, unknown>) : {};
  return typeof delta.content === "string" ? delta.content : "";
}

function chatDeltaToolCalls(payload: unknown): unknown[] {
  const record = isRecord(payload) ? payload : {};
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : {};
  const delta = isRecord(first.delta) ? first.delta : {};
  return Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
}

function responseToolItemId(callId: string, chatName: string, toolContext: ToolContext): string {
  return isCustomToolName(chatName, toolContext) ? `ctc_${callId}` : `fc_${callId}`;
}

function responseToolItem(itemId: string, status: string, callId: string, chatName: string, args: string, toolContext: ToolContext): unknown {
  const spec = toolContext.chatNameToSpec.get(chatName);
  if (spec?.kind === "custom") {
    return {
      id: itemId,
      type: "custom_tool_call",
      status,
      call_id: callId,
      name: spec.name,
      input: customToolInput(args),
    };
  }
  if (spec?.kind === "tool_search") {
    return {
      type: "tool_search_call",
      status,
      call_id: callId,
      execution: "client",
      arguments: parseArgumentsObject(args),
    };
  }
  return {
    id: itemId,
    type: "function_call",
    status,
    call_id: callId,
    name: spec?.name || chatName,
    ...(spec?.namespace ? { namespace: spec.namespace } : {}),
    arguments: args,
  };
}

function isCustomToolName(chatName: string, toolContext: ToolContext): boolean {
  return toolContext.chatNameToSpec.get(chatName)?.kind === "custom";
}

function chatUsageToResponsesUsage(value: unknown): unknown {
  const usage = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
}

function zeroUsage(): unknown {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function resolveModel(channel: AgentChannel, value: unknown): string {
  if (typeof value === "string" && runtimeModelId(value)) return value;
  return channel.models.find((model) => model.id !== DEFAULT_MODEL_ID)?.id ?? "default";
}

function optionalNumberField(key: string, value: unknown): Record<string, number> {
  return typeof value === "number" ? { [key]: value } : {};
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  return `${normalized}/chat/completions`;
}

function responseIdFromChatId(id: string): string {
  return id.startsWith("resp_") ? id : `resp_${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function canonicalJsonString(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return value;
    }
  }
  return JSON.stringify(value ?? {});
}

function customToolInput(argumentsText: string): string {
  if (!argumentsText.trim()) return "";
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (isRecord(parsed) && typeof parsed.input === "string") return parsed.input;
  } catch {
    // Fall through to the raw argument text.
  }
  return argumentsText;
}

function parseArgumentsObject(argumentsText: string): unknown {
  if (!argumentsText.trim()) return {};
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return isRecord(parsed) ? parsed : { query: argumentsText };
  } catch {
    return { query: argumentsText };
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function writeSse(response: http.ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function jsonResponse(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as unknown) : {};
}
