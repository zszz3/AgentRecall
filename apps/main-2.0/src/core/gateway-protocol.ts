import { randomUUID } from "node:crypto";
import type http from "node:http";
import type { GatewayProviderProtocol } from "../shared/ipc/model-gateway";
import { buildChatCompletionRequest } from "./codex-chat-proxy";

export interface GatewayTelemetry {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  hasToolCall: boolean;
  replyPreview: string;
}

export function emptyGatewayTelemetry(): GatewayTelemetry {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    stopReason: null,
    hasToolCall: false,
    replyPreview: "",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function appendPreview(current: string, delta: string): string {
  if (!delta || current.length >= 160) return current;
  return (current + delta).slice(0, 160);
}

/** Converts an Anthropic `/v1/messages` request into an OpenAI `/v1/chat/completions` payload. */
export function anthropicRequestToOpenAiChat(
  body: Record<string, unknown>,
  targetModel: string,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  if (typeof body.system === "string" && body.system.trim()) {
    messages.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    const text = body.system
      .map((item) => readString(asRecord(item)?.text))
      .filter(Boolean)
      .join("\n");
    if (text) messages.push({ role: "system", content: text });
  }

  for (const rawMsg of asArray(body.messages)) {
    const msg = asRecord(rawMsg);
    if (!msg) continue;
    const role = msg.role === "assistant" ? "assistant" : "user";
    if (typeof msg.content === "string") {
      messages.push({ role, content: msg.content });
      continue;
    }

    const blocks = asArray(msg.content).map(asRecord).filter((b): b is Record<string, unknown> => b !== null);
    if (role === "user") {
      const toolResults = blocks.filter((b) => b.type === "tool_result");
      const otherTexts = blocks
        .filter((b) => b.type === "text")
        .map((b) => readString(b.text))
        .filter(Boolean);
      for (const tr of toolResults) {
        const content = typeof tr.content === "string"
          ? tr.content
          : asArray(tr.content).map((item) => readString(asRecord(item)?.text)).filter(Boolean).join("\n");
        messages.push({
          role: "tool",
          tool_call_id: readString(tr.tool_use_id) || `call_${randomUUID().slice(0, 8)}`,
          content,
        });
      }
      if (otherTexts.length > 0 || toolResults.length === 0) {
        messages.push({ role: "user", content: otherTexts.join("\n") });
      }
    } else {
      const texts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: readString(block.id) || `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: {
              name: readString(block.name) || "tool",
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const assistantMsg: Record<string, unknown> = {
        role: "assistant",
        content: texts.length > 0 ? texts.join("\n") : (toolCalls.length > 0 ? null : ""),
      };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);
    }
  }

  const out: Record<string, unknown> = {
    model: targetModel,
    messages,
    stream: body.stream === true,
  };
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;

  const tools = asArray(body.tools)
    .map(asRecord)
    .filter((tool): tool is Record<string, unknown> => tool !== null && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: readString(tool.description),
        parameters: isObject(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
      },
    }));
  if (tools.length > 0) out.tools = tools;
  if (out.stream === true) out.stream_options = { include_usage: true };
  return out;
}

/** Converts an OpenAI Chat Completions request into an Anthropic `/v1/messages` payload. */
export function openAiChatRequestToAnthropic(
  body: Record<string, unknown>,
  targetModel: string,
): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: Array<Record<string, unknown>> = [];

  for (const rawMsg of asArray(body.messages)) {
    const msg = asRecord(rawMsg);
    if (!msg) continue;
    const role = readString(msg.role);
    if (role === "system" || role === "developer") {
      const text = flattenOpenAiContent(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (role === "tool") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: readString(msg.tool_call_id) || "tool_call",
          content: flattenOpenAiContent(msg.content),
        }],
      });
      continue;
    }
    if (role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      const text = flattenOpenAiContent(msg.content);
      if (text) content.push({ type: "text", text });
      for (const rawCall of asArray(msg.tool_calls)) {
        const call = asRecord(rawCall);
        const fn = asRecord(call?.function);
        if (!fn) continue;
        let parsedInput: unknown = {};
        try {
          parsedInput = typeof fn.arguments === "string" && fn.arguments.trim() ? JSON.parse(fn.arguments) : {};
        } catch {
          parsedInput = { raw: readString(fn.arguments) };
        }
        content.push({
          type: "tool_use",
          id: readString(call?.id) || `toolu_${randomUUID().slice(0, 8)}`,
          name: readString(fn.name) || "tool",
          input: isObject(parsedInput) ? parsedInput : {},
        });
      }
      messages.push({ role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "" }] });
      continue;
    }
    messages.push({ role: "user", content: flattenOpenAiContent(msg.content) });
  }

  const out: Record<string, unknown> = {
    model: targetModel,
    max_tokens: typeof body.max_tokens === "number"
      ? body.max_tokens
      : (typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : 8192),
    messages,
    stream: body.stream === true,
  };
  if (systemParts.length > 0) out.system = systemParts.join("\n\n");
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;

  const tools = asArray(body.tools)
    .map((item) => asRecord(asRecord(item)?.function))
    .filter((fn): fn is Record<string, unknown> => fn !== null && typeof fn.name === "string")
    .map((fn) => ({
      name: fn.name,
      description: readString(fn.description),
      input_schema: isObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
    }));
  if (tools.length > 0) out.tools = tools;
  return out;
}

/** Converts an OpenAI Chat non-streaming JSON response to Anthropic Messages JSON. */
export function openAiChatResponseToAnthropic(
  payload: Record<string, unknown>,
  model: string,
): { body: Record<string, unknown>; telemetry: GatewayTelemetry } {
  const telemetry = extractOpenAiChatTelemetry(payload);
  const choice = asRecord(asArray(payload.choices)[0]);
  const message = asRecord(choice?.message);
  const content: Array<Record<string, unknown>> = [];

  const text = flattenOpenAiContent(message?.content);
  if (text) content.push({ type: "text", text });

  for (const rawCall of asArray(message?.tool_calls)) {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    if (!fn) continue;
    let input: unknown = {};
    try {
      input = typeof fn.arguments === "string" && fn.arguments.trim() ? JSON.parse(fn.arguments) : {};
    } catch {
      input = { raw: readString(fn.arguments) };
    }
    content.push({
      type: "tool_use",
      id: readString(call?.id) || `toolu_${randomUUID().slice(0, 8)}`,
      name: readString(fn.name) || "tool",
      input: isObject(input) ? input : {},
    });
  }

  const finishReason = readString(choice?.finish_reason);
  const stopReason = finishReason === "tool_calls"
    ? "tool_use"
    : finishReason === "length"
      ? "max_tokens"
      : "end_turn";
  telemetry.stopReason = stopReason;
  telemetry.hasToolCall = stopReason === "tool_use" || content.some((b) => b.type === "tool_use");

  return {
    body: {
      id: readString(payload.id) || `msg_${randomUUID().slice(0, 12)}`,
      type: "message",
      role: "assistant",
      model: readString(payload.model) || model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: telemetry.inputTokens,
        output_tokens: telemetry.outputTokens,
        cache_read_input_tokens: telemetry.cachedInputTokens,
      },
    },
    telemetry,
  };
}

/** Converts an Anthropic non-streaming Messages JSON response into OpenAI Chat Completions JSON. */
export function anthropicResponseToOpenAiChat(
  payload: Record<string, unknown>,
  model: string,
): { body: Record<string, unknown>; telemetry: GatewayTelemetry } {
  const telemetry = extractAnthropicTelemetry(payload);
  const blocks = asArray(payload.content).map(asRecord).filter((b): b is Record<string, unknown> => b !== null);
  const texts = blocks.filter((b) => b.type === "text").map((b) => readString(b.text)).filter(Boolean);
  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: readString(b.id) || `call_${randomUUID().slice(0, 8)}`,
      type: "function",
      function: {
        name: readString(b.name) || "tool",
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));

  const stopReason = readString(payload.stop_reason);
  const finishReason = stopReason === "tool_use" ? "tool_calls" : stopReason === "max_tokens" ? "length" : "stop";
  const message: Record<string, unknown> = {
    role: "assistant",
    content: texts.length > 0 ? texts.join("\n") : (toolCalls.length > 0 ? null : ""),
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    body: {
      id: readString(payload.id) || `chatcmpl_${randomUUID().slice(0, 12)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: readString(payload.model) || model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: telemetry.inputTokens + telemetry.cachedInputTokens,
        completion_tokens: telemetry.outputTokens,
        total_tokens: telemetry.inputTokens + telemetry.cachedInputTokens + telemetry.outputTokens,
        prompt_tokens_details: { cached_tokens: telemetry.cachedInputTokens },
      },
    },
    telemetry,
  };
}

/** Converts an OpenAI Chat non-streaming JSON response to OpenAI Responses JSON. */
export function openAiChatResponseToResponses(
  payload: Record<string, unknown>,
  model: string,
): { body: Record<string, unknown>; telemetry: GatewayTelemetry } {
  const telemetry = extractOpenAiChatTelemetry(payload);
  const choice = asRecord(asArray(payload.choices)[0]);
  const message = asRecord(choice?.message);
  const output: Array<Record<string, unknown>> = [];
  const text = flattenOpenAiContent(message?.content);
  if (text) {
    output.push({
      type: "message",
      id: `msg_${randomUUID().slice(0, 10)}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const rawCall of asArray(message?.tool_calls)) {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    if (!fn) continue;
    output.push({
      type: "function_call",
      id: `fc_${randomUUID().slice(0, 10)}`,
      call_id: readString(call?.id) || `call_${randomUUID().slice(0, 8)}`,
      name: readString(fn.name) || "tool",
      arguments: readString(fn.arguments) || "{}",
      status: "completed",
    });
  }
  return {
    body: {
      id: readString(payload.id) || `resp_${randomUUID().slice(0, 12)}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: readString(payload.model) || model,
      output,
      usage: {
        input_tokens: telemetry.inputTokens + telemetry.cachedInputTokens,
        output_tokens: telemetry.outputTokens,
        total_tokens: telemetry.inputTokens + telemetry.cachedInputTokens + telemetry.outputTokens,
        input_tokens_details: { cached_tokens: telemetry.cachedInputTokens },
      },
    },
    telemetry,
  };
}

/** Converts an Anthropic non-streaming Messages JSON response to OpenAI Responses JSON. */
export function anthropicResponseToResponses(
  payload: Record<string, unknown>,
  model: string,
): { body: Record<string, unknown>; telemetry: GatewayTelemetry } {
  const asChat = anthropicResponseToOpenAiChat(payload, model);
  return openAiChatResponseToResponses(asChat.body, model);
}

/** Converts an OpenAI Responses non-streaming JSON response to OpenAI Chat Completions JSON. */
export function openAiResponsesToOpenAiChat(
  payload: Record<string, unknown>,
  model: string,
): { body: Record<string, unknown>; telemetry: GatewayTelemetry } {
  const telemetry = extractOpenAiResponsesTelemetry(payload);
  const texts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const rawItem of asArray(payload.output)) {
    const item = asRecord(rawItem);
    if (!item) continue;
    if (item.type === "message") {
      const text = flattenOpenAiContent(item.content);
      if (text) texts.push(text);
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: readString(item.call_id) || readString(item.id) || `call_${randomUUID().slice(0, 8)}`,
        type: "function",
        function: {
          name: readString(item.name) || "tool",
          arguments: readString(item.arguments) || "{}",
        },
      });
    }
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    content: texts.length > 0 ? texts.join("\n") : (toolCalls.length > 0 ? null : ""),
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
  return {
    body: {
      id: readString(payload.id) || `chatcmpl_${randomUUID().slice(0, 12)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: readString(payload.model) || model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: telemetry.inputTokens + telemetry.cachedInputTokens,
        completion_tokens: telemetry.outputTokens,
        total_tokens: telemetry.inputTokens + telemetry.cachedInputTokens + telemetry.outputTokens,
        prompt_tokens_details: { cached_tokens: telemetry.cachedInputTokens },
      },
    },
    telemetry,
  };
}

/** Converts an OpenAI Responses non-streaming JSON response to Anthropic Messages JSON. */
export function openAiResponsesToAnthropic(
  payload: Record<string, unknown>,
  model: string,
): { body: Record<string, unknown>; telemetry: GatewayTelemetry } {
  const asChat = openAiResponsesToOpenAiChat(payload, model);
  return openAiChatResponseToAnthropic(asChat.body, model);
}

/** Prepares the upstream request body + target path given incoming and upstream protocols. */
export function translateRequestBody(
  incoming: GatewayProviderProtocol,
  upstream: GatewayProviderProtocol,
  body: Record<string, unknown>,
  targetModel: string,
): { pathSuffix: string; body: Record<string, unknown> } {
  if (incoming === upstream) {
    const next: Record<string, unknown> = { ...body, model: targetModel };
    if (upstream === "openai_chat" && next.stream === true) {
      next.stream_options = { ...(asRecord(next.stream_options) ?? {}), include_usage: true };
    }
    return { pathSuffix: endpointPathForProtocol(upstream), body: next };
  }

  // Convert incoming -> OpenAI Chat as common pivot, then to upstream if needed.
  let chatBody: Record<string, unknown>;
  if (incoming === "openai_chat") {
    chatBody = { ...body, model: targetModel };
  } else if (incoming === "openai_responses") {
    chatBody = buildChatCompletionRequest(body, targetModel);
  } else {
    chatBody = anthropicRequestToOpenAiChat(body, targetModel);
  }

  if (upstream === "openai_chat") {
    if (chatBody.stream === true) chatBody.stream_options = { include_usage: true };
    return { pathSuffix: "/chat/completions", body: chatBody };
  }
  if (upstream === "anthropic") {
    return { pathSuffix: "/messages", body: openAiChatRequestToAnthropic(chatBody, targetModel) };
  }

  // incoming -> openai_responses via chat pivot (preserving messages, tool calls, tool outputs, and tool definitions).
  const messages = asArray(chatBody.messages).map(asRecord).filter((m): m is Record<string, unknown> => m !== null);
  const input: Array<Record<string, unknown>> = [];
  const instructionParts: string[] = [];

  for (const m of messages) {
    const role = readString(m.role);
    if (role === "system" || role === "developer") {
      const text = flattenOpenAiContent(m.content);
      if (text) instructionParts.push(text);
      continue;
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: readString(m.tool_call_id) || `call_${randomUUID().slice(0, 8)}`,
        output: flattenOpenAiContent(m.content),
      });
      continue;
    }
    const text = flattenOpenAiContent(m.content);
    if (text) {
      input.push({
        type: "message",
        role: role === "assistant" ? "assistant" : "user",
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
      });
    }
    if (role === "assistant") {
      for (const rawCall of asArray(m.tool_calls)) {
        const call = asRecord(rawCall);
        const fn = asRecord(call?.function);
        if (!fn) continue;
        input.push({
          type: "function_call",
          call_id: readString(call?.id) || `call_${randomUUID().slice(0, 8)}`,
          name: readString(fn.name) || "tool",
          arguments: readString(fn.arguments) || "{}",
        });
      }
    }
  }

  const respBody: Record<string, unknown> = {
    model: targetModel,
    input,
    stream: chatBody.stream === true,
  };
  if (instructionParts.length > 0) respBody.instructions = instructionParts.join("\n\n");
  if (typeof chatBody.temperature === "number") respBody.temperature = chatBody.temperature;
  if (typeof chatBody.top_p === "number") respBody.top_p = chatBody.top_p;
  if (typeof chatBody.max_tokens === "number") respBody.max_output_tokens = chatBody.max_tokens;
  const tools = asArray(chatBody.tools)
    .map((item) => asRecord(asRecord(item)?.function))
    .filter((fn): fn is Record<string, unknown> => fn !== null && typeof fn.name === "string")
    .map((fn) => ({
      type: "function",
      name: fn.name,
      description: readString(fn.description),
      parameters: isObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
    }));
  if (tools.length > 0) respBody.tools = tools;
  return { pathSuffix: "/responses", body: respBody };
}

export function endpointPathForProtocol(protocol: GatewayProviderProtocol): string {
  if (protocol === "anthropic") return "/messages";
  if (protocol === "openai_responses") return "/responses";
  return "/chat/completions";
}

export function extractTelemetryFromNonStreaming(
  protocol: GatewayProviderProtocol,
  payload: Record<string, unknown>,
): GatewayTelemetry {
  if (protocol === "anthropic") return extractAnthropicTelemetry(payload);
  if (protocol === "openai_responses") return extractOpenAiResponsesTelemetry(payload);
  return extractOpenAiChatTelemetry(payload);
}

/**
 * Pipes an upstream SSE stream directly to the client while inspecting each JSON data event
 * for token usage, stop reason and reply preview (used for same-protocol passthrough).
 */
export async function pipePassthroughSse(
  stream: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  protocol: GatewayProviderProtocol,
  onFirstToken?: () => void,
): Promise<GatewayTelemetry> {
  const telemetry = emptyGatewayTelemetry();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunk = true;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstChunk) {
        firstChunk = false;
        onFirstToken?.();
      }
      if (!res.destroyed && !res.writableEnded) {
        res.write(Buffer.from(value));
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        inspectSseLine(line, protocol, telemetry);
      }
    }
    if (buffer) inspectSseLine(buffer, protocol, telemetry);
  } finally {
    reader.releaseLock();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
  return telemetry;
}

/**
 * Translates an upstream OpenAI Chat SSE stream into an Anthropic Messages SSE stream.
 */
export async function pipeOpenAiChatSseAsAnthropic(
  stream: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  model: string,
  onFirstToken?: () => void,
): Promise<GatewayTelemetry> {
  const telemetry = emptyGatewayTelemetry();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const messageId = `msg_${randomUUID().slice(0, 12)}`;
  let buffer = "";
  let started = false;
  let textBlockIndex: number | null = null;
  let nextBlockIndex = 0;
  const toolBlocks = new Map<number, { blockIndex: number; id: string; name: string }>();

  const emit = (event: string, data: unknown): void => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const ensureStarted = () => {
    if (started) return;
    started = true;
    onFirstToken?.();
    emit("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const closeOpenTextBlock = () => {
    if (textBlockIndex !== null) {
      emit("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
      textBlockIndex = null;
    }
  };

  const handleData = (raw: string) => {
    if (!raw || raw === "[DONE]") return;
    let chunk: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      chunk = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const usage = asRecord(chunk.usage);
    if (usage) {
      const cached = readNum(asRecord(usage.prompt_tokens_details)?.cached_tokens);
      const prompt = readNum(usage.prompt_tokens);
      telemetry.inputTokens = Math.max(0, prompt - cached);
      telemetry.cachedInputTokens = cached;
      telemetry.outputTokens = readNum(usage.completion_tokens);
    }

    const choice = asRecord(asArray(chunk.choices)[0]);
    if (!choice) return;
    const delta = asRecord(choice.delta);

    const text = readString(delta?.content);
    if (text) {
      ensureStarted();
      if (textBlockIndex === null) {
        textBlockIndex = nextBlockIndex++;
        emit("content_block_start", {
          type: "content_block_start",
          index: textBlockIndex,
          content_block: { type: "text", text: "" },
        });
      }
      telemetry.replyPreview = appendPreview(telemetry.replyPreview, text);
      emit("content_block_delta", {
        type: "content_block_delta",
        index: textBlockIndex,
        delta: { type: "text_delta", text },
      });
    }

    for (const rawTool of asArray(delta?.tool_calls)) {
      const tc = asRecord(rawTool);
      if (!tc) continue;
      ensureStarted();
      closeOpenTextBlock();
      const idx = typeof tc.index === "number" ? tc.index : 0;
      const fn = asRecord(tc.function);
      let state = toolBlocks.get(idx);
      if (!state) {
        state = {
          blockIndex: nextBlockIndex++,
          id: readString(tc.id) || `toolu_${randomUUID().slice(0, 8)}`,
          name: readString(fn?.name) || "tool",
        };
        toolBlocks.set(idx, state);
        telemetry.hasToolCall = true;
        emit("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "tool_use", id: state.id, name: state.name, input: {} },
        });
      }
      const argsDelta = readString(fn?.arguments);
      if (argsDelta) {
        emit("content_block_delta", {
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "input_json_delta", partial_json: argsDelta },
        });
      }
    }

    const finish = readString(choice.finish_reason);
    if (finish) {
      telemetry.stopReason = finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";
      if (telemetry.stopReason === "tool_use") telemetry.hasToolCall = true;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) handleData(trimmed.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith("data:")) handleData(buffer.trim().slice(5).trim());

    ensureStarted();
    closeOpenTextBlock();
    for (const state of toolBlocks.values()) {
      emit("content_block_stop", { type: "content_block_stop", index: state.blockIndex });
    }
    const stopReason = telemetry.stopReason ?? (telemetry.hasToolCall ? "tool_use" : "end_turn");
    telemetry.stopReason = stopReason;
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: telemetry.outputTokens },
    });
    emit("message_stop", { type: "message_stop" });
  } finally {
    reader.releaseLock();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
  return telemetry;
}

/**
 * Translates an upstream Anthropic SSE stream into an OpenAI Chat Completions SSE stream.
 */
export async function pipeAnthropicSseAsOpenAiChat(
  stream: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  model: string,
  onFirstToken?: () => void,
): Promise<GatewayTelemetry> {
  const telemetry = emptyGatewayTelemetry();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const completionId = `chatcmpl_${randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let first = true;
  let toolIndex = -1;

  const emitChunk = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    const chunk: Record<string, unknown> = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) chunk.usage = usage;
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const handleData = (raw: string) => {
    if (!raw) return;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      payload = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = readString(payload.type);
    if (type === "message_start") {
      const usage = asRecord(asRecord(payload.message)?.usage);
      if (usage) {
        telemetry.inputTokens = readNum(usage.input_tokens);
        telemetry.cachedInputTokens = readNum(usage.cache_read_input_tokens);
      }
    } else if (type === "content_block_start") {
      const block = asRecord(payload.content_block);
      if (block?.type === "tool_use") {
        if (first) { first = false; onFirstToken?.(); }
        toolIndex += 1;
        telemetry.hasToolCall = true;
        emitChunk({
          tool_calls: [{
            index: toolIndex,
            id: readString(block.id) || `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: { name: readString(block.name) || "tool", arguments: "" },
          }],
        });
      }
    } else if (type === "content_block_delta") {
      const delta = asRecord(payload.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        if (first) { first = false; onFirstToken?.(); }
        telemetry.replyPreview = appendPreview(telemetry.replyPreview, delta.text);
        emitChunk({ content: delta.text });
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        emitChunk({
          tool_calls: [{
            index: Math.max(0, toolIndex),
            function: { arguments: delta.partial_json },
          }],
        });
      }
    } else if (type === "message_delta") {
      const usage = asRecord(payload.usage);
      if (usage) telemetry.outputTokens = readNum(usage.output_tokens);
      const stopReason = readString(asRecord(payload.delta)?.stop_reason);
      if (stopReason) {
        telemetry.stopReason = stopReason;
        if (stopReason === "tool_use") telemetry.hasToolCall = true;
      }
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) handleData(trimmed.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith("data:")) handleData(buffer.trim().slice(5).trim());

    const finishReason = telemetry.stopReason === "tool_use" || telemetry.hasToolCall
      ? "tool_calls"
      : telemetry.stopReason === "max_tokens"
        ? "length"
        : "stop";
    emitChunk({}, finishReason, {
      prompt_tokens: telemetry.inputTokens + telemetry.cachedInputTokens,
      completion_tokens: telemetry.outputTokens,
      total_tokens: telemetry.inputTokens + telemetry.cachedInputTokens + telemetry.outputTokens,
    });
    if (!res.destroyed && !res.writableEnded) res.write("data: [DONE]\n\n");
  } finally {
    reader.releaseLock();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
  return telemetry;
}

class GatewayResponsesSseWriter {
  private readonly responseId = `resp_${randomUUID().slice(0, 12)}`;
  private readonly output: Array<{ outputIndex: number; item: Record<string, unknown> }> = [];
  private nextOutputIndex = 0;
  private textItem: { id: string; outputIndex: number; text: string; started: boolean; done: boolean } | null = null;
  private readonly toolCalls = new Map<number, {
    outputIndex: number;
    itemId: string;
    callId: string;
    name: string;
    arguments: string;
    started: boolean;
    done: boolean;
  }>();
  private createdSent = false;
  private completedSent = false;

  constructor(
    private readonly res: http.ServerResponse,
    private readonly model: string,
  ) {}

  private send(event: string, data: Record<string, unknown>): void {
    if (this.res.destroyed || this.res.writableEnded) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  ensureCreated(): void {
    if (this.createdSent) return;
    this.createdSent = true;
    this.send("response.created", {
      type: "response.created",
      response: { id: this.responseId, object: "response", status: "in_progress", model: this.model, output: [] },
    });
  }

  addText(delta: string): void {
    if (!delta) return;
    this.ensureCreated();
    if (!this.textItem) {
      this.textItem = { id: `msg_${randomUUID().slice(0, 10)}`, outputIndex: this.nextOutputIndex++, text: "", started: false, done: false };
    }
    if (!this.textItem.started) {
      this.textItem.started = true;
      this.send("response.output_item.added", {
        type: "response.output_item.added",
        output_index: this.textItem.outputIndex,
        item: { id: this.textItem.id, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      this.send("response.content_part.added", {
        type: "response.content_part.added",
        item_id: this.textItem.id,
        output_index: this.textItem.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.textItem.text += delta;
    this.send("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.textItem.id,
      output_index: this.textItem.outputIndex,
      content_index: 0,
      delta,
    });
  }

  addToolDelta(index: number, callId: string | undefined, name: string | undefined, argsDelta: string | undefined): void {
    this.ensureCreated();
    let state = this.toolCalls.get(index);
    if (!state) {
      state = {
        outputIndex: this.nextOutputIndex++,
        itemId: `fc_${randomUUID().slice(0, 10)}`,
        callId: callId || `call_${randomUUID().slice(0, 8)}`,
        name: name || "tool_call",
        arguments: "",
        started: false,
        done: false,
      };
      this.toolCalls.set(index, state);
    }
    if (callId) state.callId = callId;
    if (name) state.name = name;
    if (!state.started) {
      state.started = true;
      this.send("response.output_item.added", {
        type: "response.output_item.added",
        output_index: state.outputIndex,
        item: {
          id: state.itemId,
          type: "function_call",
          status: "in_progress",
          call_id: state.callId,
          name: state.name,
          arguments: "",
        },
      });
    }
    if (argsDelta) {
      state.arguments += argsDelta;
      this.send("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta: argsDelta,
      });
    }
  }

  finish(telemetry: GatewayTelemetry): void {
    if (this.completedSent) return;
    this.completedSent = true;
    this.ensureCreated();

    if (this.textItem?.started && !this.textItem.done) {
      this.textItem.done = true;
      const item = {
        id: this.textItem.id,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: this.textItem.text, annotations: [] }],
      };
      this.send("response.output_text.done", {
        type: "response.output_text.done",
        item_id: this.textItem.id,
        output_index: this.textItem.outputIndex,
        content_index: 0,
        text: this.textItem.text,
      });
      this.send("response.content_part.done", {
        type: "response.content_part.done",
        item_id: this.textItem.id,
        output_index: this.textItem.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: this.textItem.text, annotations: [] },
      });
      this.send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: this.textItem.outputIndex,
        item,
      });
      this.output.push({ outputIndex: this.textItem.outputIndex, item });
    }

    for (const tool of this.toolCalls.values()) {
      if (!tool.started || tool.done) continue;
      tool.done = true;
      const item = {
        id: tool.itemId,
        type: "function_call",
        status: "completed",
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.arguments,
      };
      this.send("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        arguments: tool.arguments,
      });
      this.send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: tool.outputIndex,
        item,
      });
      this.output.push({ outputIndex: tool.outputIndex, item });
    }

    const sortedOutput = [...this.output].sort((a, b) => a.outputIndex - b.outputIndex).map((e) => e.item);
    this.send("response.completed", {
      type: "response.completed",
      response: {
        id: this.responseId,
        object: "response",
        status: "completed",
        model: this.model,
        output: sortedOutput,
        usage: {
          input_tokens: telemetry.inputTokens + telemetry.cachedInputTokens,
          output_tokens: telemetry.outputTokens,
          total_tokens: telemetry.inputTokens + telemetry.cachedInputTokens + telemetry.outputTokens,
          input_tokens_details: { cached_tokens: telemetry.cachedInputTokens },
        },
      },
    });
    if (!this.res.destroyed && !this.res.writableEnded) {
      this.res.write("data: [DONE]\n\n");
    }
  }
}

/**
 * Translates an upstream OpenAI Chat SSE stream into an OpenAI Responses SSE stream
 * (used when Codex speaks `/v1/responses` against DeepSeek/OpenRouter/Ollama Chat upstreams).
 */
export async function pipeOpenAiChatSseAsResponses(
  stream: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  model: string,
  onFirstToken?: () => void,
): Promise<GatewayTelemetry> {
  const telemetry = emptyGatewayTelemetry();
  const writer = new GatewayResponsesSseWriter(res, model);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let first = true;

  const markFirst = () => {
    if (first) { first = false; onFirstToken?.(); }
  };

  const handleData = (raw: string) => {
    if (!raw || raw === "[DONE]") return;
    let chunk: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      chunk = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const usage = asRecord(chunk.usage);
    if (usage) {
      const cached = readNum(asRecord(usage.prompt_tokens_details)?.cached_tokens);
      const prompt = readNum(usage.prompt_tokens);
      telemetry.inputTokens = Math.max(0, prompt - cached);
      telemetry.cachedInputTokens = cached;
      telemetry.outputTokens = readNum(usage.completion_tokens);
    }
    const choice = asRecord(asArray(chunk.choices)[0]);
    if (!choice) return;
    const delta = asRecord(choice.delta);
    const text = readString(delta?.content);
    if (text) {
      markFirst();
      telemetry.replyPreview = appendPreview(telemetry.replyPreview, text);
      writer.addText(text);
    }
    for (const rawTool of asArray(delta?.tool_calls)) {
      const tc = asRecord(rawTool);
      if (!tc) continue;
      markFirst();
      telemetry.hasToolCall = true;
      const idx = typeof tc.index === "number" ? tc.index : 0;
      const fn = asRecord(tc.function);
      writer.addToolDelta(idx, readString(tc.id) || undefined, readString(fn?.name) || undefined, readString(fn?.arguments) || undefined);
    }
    const finish = readString(choice.finish_reason);
    if (finish) {
      telemetry.stopReason = finish;
      if (finish === "tool_calls") telemetry.hasToolCall = true;
    }
  };

  try {
    writer.ensureCreated();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) handleData(trimmed.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith("data:")) handleData(buffer.trim().slice(5).trim());
    if (!telemetry.stopReason) telemetry.stopReason = telemetry.hasToolCall ? "tool_calls" : "completed";
    writer.finish(telemetry);
  } finally {
    reader.releaseLock();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
  return telemetry;
}

/**
 * Translates an upstream Anthropic Messages SSE stream into an OpenAI Responses SSE stream
 * (used when Codex speaks `/v1/responses` against an Anthropic upstream).
 */
export async function pipeAnthropicSseAsResponses(
  stream: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  model: string,
  onFirstToken?: () => void,
): Promise<GatewayTelemetry> {
  const telemetry = emptyGatewayTelemetry();
  const writer = new GatewayResponsesSseWriter(res, model);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let first = true;
  let toolIndex = -1;

  const markFirst = () => {
    if (first) { first = false; onFirstToken?.(); }
  };

  const handleData = (raw: string) => {
    if (!raw) return;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      payload = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = readString(payload.type);
    if (type === "message_start") {
      const usage = asRecord(asRecord(payload.message)?.usage);
      if (usage) {
        telemetry.inputTokens = readNum(usage.input_tokens);
        telemetry.cachedInputTokens = readNum(usage.cache_read_input_tokens);
      }
    } else if (type === "content_block_start") {
      const block = asRecord(payload.content_block);
      if (block?.type === "tool_use") {
        markFirst();
        toolIndex += 1;
        telemetry.hasToolCall = true;
        writer.addToolDelta(toolIndex, readString(block.id) || undefined, readString(block.name) || undefined, undefined);
      }
    } else if (type === "content_block_delta") {
      const delta = asRecord(payload.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        markFirst();
        telemetry.replyPreview = appendPreview(telemetry.replyPreview, delta.text);
        writer.addText(delta.text);
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        writer.addToolDelta(Math.max(0, toolIndex), undefined, undefined, delta.partial_json);
      }
    } else if (type === "message_delta") {
      const usage = asRecord(payload.usage);
      if (usage) telemetry.outputTokens = readNum(usage.output_tokens);
      const stopReason = readString(asRecord(payload.delta)?.stop_reason);
      if (stopReason) {
        telemetry.stopReason = stopReason;
        if (stopReason === "tool_use") telemetry.hasToolCall = true;
      }
    }
  };

  try {
    writer.ensureCreated();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) handleData(trimmed.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith("data:")) handleData(buffer.trim().slice(5).trim());
    if (!telemetry.stopReason) telemetry.stopReason = telemetry.hasToolCall ? "tool_use" : "completed";
    writer.finish(telemetry);
  } finally {
    reader.releaseLock();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
  return telemetry;
}

/**
 * Translates an upstream OpenAI Responses SSE stream into an OpenAI Chat Completions SSE stream.
 */
export async function pipeResponsesSseAsOpenAiChat(
  stream: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  model: string,
  onFirstToken?: () => void,
): Promise<GatewayTelemetry> {
  const telemetry = emptyGatewayTelemetry();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const completionId = `chatcmpl_${randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let first = true;
  const toolIndexByItemId = new Map<string, number>();
  let nextToolIndex = 0;

  const emitChunk = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    const chunk: Record<string, unknown> = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) chunk.usage = usage;
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const handleData = (raw: string) => {
    if (!raw || raw === "[DONE]") return;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      payload = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = readString(payload.type);
    if (type === "response.output_text.delta" && typeof payload.delta === "string") {
      if (first) { first = false; onFirstToken?.(); }
      telemetry.replyPreview = appendPreview(telemetry.replyPreview, payload.delta);
      emitChunk({ content: payload.delta });
    } else if (type === "response.output_item.added") {
      const item = asRecord(payload.item);
      if (item?.type === "function_call") {
        if (first) { first = false; onFirstToken?.(); }
        telemetry.hasToolCall = true;
        const itemId = readString(item.id) || String(payload.output_index ?? nextToolIndex);
        const idx = nextToolIndex++;
        toolIndexByItemId.set(itemId, idx);
        emitChunk({
          tool_calls: [{
            index: idx,
            id: readString(item.call_id) || `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: { name: readString(item.name) || "tool", arguments: "" },
          }],
        });
      }
    } else if (type === "response.function_call_arguments.delta" && typeof payload.delta === "string") {
      const itemId = readString(payload.item_id);
      const idx = toolIndexByItemId.get(itemId) ?? Math.max(0, nextToolIndex - 1);
      emitChunk({ tool_calls: [{ index: idx, function: { arguments: payload.delta } }] });
    } else if (type === "response.completed") {
      const response = asRecord(payload.response);
      if (response) {
        const extracted = extractOpenAiResponsesTelemetry(response);
        telemetry.inputTokens = extracted.inputTokens;
        telemetry.cachedInputTokens = extracted.cachedInputTokens;
        telemetry.outputTokens = extracted.outputTokens;
        telemetry.hasToolCall = telemetry.hasToolCall || extracted.hasToolCall;
        telemetry.stopReason = extracted.stopReason;
        if (!telemetry.replyPreview) telemetry.replyPreview = extracted.replyPreview;
      }
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) handleData(trimmed.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith("data:")) handleData(buffer.trim().slice(5).trim());

    const finishReason = telemetry.hasToolCall ? "tool_calls" : "stop";
    telemetry.stopReason = finishReason;
    emitChunk({}, finishReason, {
      prompt_tokens: telemetry.inputTokens + telemetry.cachedInputTokens,
      completion_tokens: telemetry.outputTokens,
      total_tokens: telemetry.inputTokens + telemetry.cachedInputTokens + telemetry.outputTokens,
    });
    if (!res.destroyed && !res.writableEnded) res.write("data: [DONE]\n\n");
  } finally {
    reader.releaseLock();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
  return telemetry;
}

/**
 * Translates an upstream OpenAI Responses SSE stream into an Anthropic Messages SSE stream.
 */
export async function pipeResponsesSseAsAnthropic(
  stream: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  model: string,
  onFirstToken?: () => void,
): Promise<GatewayTelemetry> {
  const telemetry = emptyGatewayTelemetry();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const messageId = `msg_${randomUUID().slice(0, 12)}`;
  let buffer = "";
  let started = false;
  let textBlockIndex: number | null = null;
  let nextBlockIndex = 0;
  const toolBlocks = new Map<string, number>();

  const emit = (event: string, data: unknown): void => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const ensureStarted = () => {
    if (started) return;
    started = true;
    onFirstToken?.();
    emit("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const closeText = () => {
    if (textBlockIndex !== null) {
      emit("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
      textBlockIndex = null;
    }
  };

  const handleData = (raw: string) => {
    if (!raw || raw === "[DONE]") return;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      payload = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = readString(payload.type);
    if (type === "response.output_text.delta" && typeof payload.delta === "string") {
      ensureStarted();
      if (textBlockIndex === null) {
        textBlockIndex = nextBlockIndex++;
        emit("content_block_start", {
          type: "content_block_start",
          index: textBlockIndex,
          content_block: { type: "text", text: "" },
        });
      }
      telemetry.replyPreview = appendPreview(telemetry.replyPreview, payload.delta);
      emit("content_block_delta", {
        type: "content_block_delta",
        index: textBlockIndex,
        delta: { type: "text_delta", text: payload.delta },
      });
    } else if (type === "response.output_item.added") {
      const item = asRecord(payload.item);
      if (item?.type === "function_call") {
        ensureStarted();
        closeText();
        telemetry.hasToolCall = true;
        const itemId = readString(item.id) || String(payload.output_index ?? nextBlockIndex);
        const blockIndex = nextBlockIndex++;
        toolBlocks.set(itemId, blockIndex);
        emit("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "tool_use",
            id: readString(item.call_id) || `toolu_${randomUUID().slice(0, 8)}`,
            name: readString(item.name) || "tool",
            input: {},
          },
        });
      }
    } else if (type === "response.function_call_arguments.delta" && typeof payload.delta === "string") {
      const blockIndex = toolBlocks.get(readString(payload.item_id));
      if (blockIndex !== undefined) {
        emit("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: payload.delta },
        });
      }
    } else if (type === "response.completed") {
      const response = asRecord(payload.response);
      if (response) {
        const extracted = extractOpenAiResponsesTelemetry(response);
        telemetry.inputTokens = extracted.inputTokens;
        telemetry.cachedInputTokens = extracted.cachedInputTokens;
        telemetry.outputTokens = extracted.outputTokens;
        telemetry.hasToolCall = telemetry.hasToolCall || extracted.hasToolCall;
        if (!telemetry.replyPreview) telemetry.replyPreview = extracted.replyPreview;
      }
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) handleData(trimmed.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith("data:")) handleData(buffer.trim().slice(5).trim());

    ensureStarted();
    closeText();
    for (const blockIndex of toolBlocks.values()) {
      emit("content_block_stop", { type: "content_block_stop", index: blockIndex });
    }
    const stopReason = telemetry.hasToolCall ? "tool_use" : "end_turn";
    telemetry.stopReason = stopReason;
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: telemetry.outputTokens },
    });
    emit("message_stop", { type: "message_stop" });
  } finally {
    reader.releaseLock();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
  return telemetry;
}

function inspectSseLine(line: string, protocol: GatewayProviderProtocol, telemetry: GatewayTelemetry): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return;
  const raw = trimmed.slice(5).trim();
  if (!raw || raw === "[DONE]") return;
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    payload = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  if (protocol === "anthropic") {
    const type = readString(payload.type);
    if (type === "message_start") {
      const usage = asRecord(asRecord(payload.message)?.usage);
      if (usage) {
        telemetry.inputTokens = readNum(usage.input_tokens);
        telemetry.cachedInputTokens = readNum(usage.cache_read_input_tokens);
      }
    } else if (type === "content_block_start" && asRecord(payload.content_block)?.type === "tool_use") {
      telemetry.hasToolCall = true;
    } else if (type === "content_block_delta") {
      const delta = asRecord(payload.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        telemetry.replyPreview = appendPreview(telemetry.replyPreview, delta.text);
      }
    } else if (type === "message_delta") {
      const usage = asRecord(payload.usage);
      if (usage) telemetry.outputTokens = readNum(usage.output_tokens);
      const stopReason = readString(asRecord(payload.delta)?.stop_reason);
      if (stopReason) {
        telemetry.stopReason = stopReason;
        if (stopReason === "tool_use") telemetry.hasToolCall = true;
      }
    }
    return;
  }

  if (protocol === "openai_responses") {
    const type = readString(payload.type);
    if (type === "response.output_text.delta" && typeof payload.delta === "string") {
      telemetry.replyPreview = appendPreview(telemetry.replyPreview, payload.delta);
    } else if (type === "response.output_item.added" && asRecord(payload.item)?.type === "function_call") {
      telemetry.hasToolCall = true;
    } else if (type === "response.completed") {
      const response = asRecord(payload.response);
      if (response) {
        const extracted = extractOpenAiResponsesTelemetry(response);
        telemetry.inputTokens = extracted.inputTokens;
        telemetry.cachedInputTokens = extracted.cachedInputTokens;
        telemetry.outputTokens = extracted.outputTokens;
        telemetry.hasToolCall = telemetry.hasToolCall || extracted.hasToolCall;
        telemetry.stopReason = extracted.stopReason;
        if (!telemetry.replyPreview) telemetry.replyPreview = extracted.replyPreview;
      }
    }
    return;
  }

  // openai_chat
  const usage = asRecord(payload.usage);
  if (usage) {
    const cached = readNum(asRecord(usage.prompt_tokens_details)?.cached_tokens);
    const prompt = readNum(usage.prompt_tokens);
    telemetry.inputTokens = Math.max(0, prompt - cached);
    telemetry.cachedInputTokens = cached;
    telemetry.outputTokens = readNum(usage.completion_tokens);
  }
  const choice = asRecord(asArray(payload.choices)[0]);
  const delta = asRecord(choice?.delta);
  if (typeof delta?.content === "string") {
    telemetry.replyPreview = appendPreview(telemetry.replyPreview, delta.content);
  }
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
    telemetry.hasToolCall = true;
  }
  const finish = readString(choice?.finish_reason);
  if (finish) {
    telemetry.stopReason = finish;
    if (finish === "tool_calls") telemetry.hasToolCall = true;
  }
}

function extractOpenAiChatTelemetry(payload: Record<string, unknown>): GatewayTelemetry {
  const telemetry = emptyGatewayTelemetry();
  const usage = asRecord(payload.usage);
  if (usage) {
    const cached = readNum(asRecord(usage.prompt_tokens_details)?.cached_tokens);
    const prompt = readNum(usage.prompt_tokens);
    telemetry.inputTokens = Math.max(0, prompt - cached);
    telemetry.cachedInputTokens = cached;
    telemetry.outputTokens = readNum(usage.completion_tokens);
  }
  const choice = asRecord(asArray(payload.choices)[0]);
  const message = asRecord(choice?.message);
  telemetry.replyPreview = flattenOpenAiContent(message?.content).slice(0, 160);
  telemetry.stopReason = readString(choice?.finish_reason) || null;
  telemetry.hasToolCall = telemetry.stopReason === "tool_calls" || asArray(message?.tool_calls).length > 0;
  return telemetry;
}

function extractAnthropicTelemetry(payload: Record<string, unknown>): GatewayTelemetry {
  const telemetry = emptyGatewayTelemetry();
  const usage = asRecord(payload.usage);
  if (usage) {
    telemetry.inputTokens = readNum(usage.input_tokens);
    telemetry.cachedInputTokens = readNum(usage.cache_read_input_tokens);
    telemetry.outputTokens = readNum(usage.output_tokens);
  }
  const blocks = asArray(payload.content).map(asRecord);
  const text = blocks.filter((b) => b?.type === "text").map((b) => readString(b?.text)).join(" ");
  telemetry.replyPreview = text.slice(0, 160);
  telemetry.stopReason = readString(payload.stop_reason) || null;
  telemetry.hasToolCall = telemetry.stopReason === "tool_use" || blocks.some((b) => b?.type === "tool_use");
  return telemetry;
}

function extractOpenAiResponsesTelemetry(payload: Record<string, unknown>): GatewayTelemetry {
  const telemetry = emptyGatewayTelemetry();
  const usage = asRecord(payload.usage);
  if (usage) {
    const cached = readNum(asRecord(usage.input_tokens_details)?.cached_tokens);
    const input = readNum(usage.input_tokens);
    telemetry.inputTokens = Math.max(0, input - cached);
    telemetry.cachedInputTokens = cached;
    telemetry.outputTokens = readNum(usage.output_tokens);
  }
  const outputs = asArray(payload.output).map(asRecord);
  for (const item of outputs) {
    if (item?.type === "function_call") telemetry.hasToolCall = true;
    if (item?.type === "message") {
      const text = asArray(item.content).map((part) => readString(asRecord(part)?.text)).join(" ");
      if (text) telemetry.replyPreview = appendPreview(telemetry.replyPreview, text);
    }
  }
  telemetry.stopReason = telemetry.hasToolCall ? "tool_calls" : (readString(payload.status) || "completed");
  return telemetry;
}

function flattenOpenAiContent(content: unknown): string {
  if (typeof content === "string") return content;
  return asArray(content)
    .map((item) => {
      const part = asRecord(item);
      if (!part) return "";
      if (part.type === "text" || part.type === "output_text" || part.type === "input_text") {
        return readString(part.text);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
