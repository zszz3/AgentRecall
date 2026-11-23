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
  // incoming -> openai_responses via chat pivot (simple input messages)
  const messages = asArray(chatBody.messages).map(asRecord).filter((m): m is Record<string, unknown> => m !== null);
  const input = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      type: "message",
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: "input_text", text: flattenOpenAiContent(m.content) }],
    }));
  const instructions = messages
    .filter((m) => m.role === "system")
    .map((m) => flattenOpenAiContent(m.content))
    .filter(Boolean)
    .join("\n\n");
  const respBody: Record<string, unknown> = {
    model: targetModel,
    input,
    stream: chatBody.stream === true,
  };
  if (instructions) respBody.instructions = instructions;
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
