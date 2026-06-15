import http from "node:http";

export interface CodexChatProxyOptions {
  upstreamBaseUrl: string;
  apiKey: string;
  model: string;
  listenHost?: string;
  listenPort?: number;
}

export interface CodexChatProxyStatus {
  running: boolean;
  host: string;
  port: number;
  baseUrl: string;
  upstreamBaseUrl: string;
  model: string;
}

export class CodexChatProxy {
  private server: http.Server | null = null;
  private status: CodexChatProxyStatus | null = null;

  constructor(private readonly options: CodexChatProxyOptions) {}

  async start(): Promise<CodexChatProxyStatus> {
    if (this.status) return this.status;
    const host = this.options.listenHost ?? "127.0.0.1";
    const port = this.options.listenPort ?? 0;
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, host, resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Codex Chat proxy did not bind to a TCP port.");
    this.status = {
      running: true,
      host,
      port: address.port,
      baseUrl: `http://${host}:${address.port}/v1`,
      upstreamBaseUrl: normalizeBaseUrl(this.options.upstreamBaseUrl),
      model: this.options.model,
    };
    return this.status;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.status = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  getStatus(): CodexChatProxyStatus {
    return this.status ?? {
      running: false,
      host: this.options.listenHost ?? "127.0.0.1",
      port: this.options.listenPort ?? 0,
      baseUrl: "",
      upstreamBaseUrl: normalizeBaseUrl(this.options.upstreamBaseUrl),
      model: this.options.model,
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === "GET" && req.url === "/health") {
        writeJson(res, 200, { ok: true, status: this.getStatus() });
        return;
      }
      if (req.method !== "POST" || !isResponsesPath(req.url ?? "")) {
        writeJson(res, 404, { error: { message: "Unsupported Codex proxy route." } });
        return;
      }

      const body = JSON.parse(await readRequestBody(req)) as Record<string, unknown>;
      const upstreamResponse = await fetch(`${normalizeBaseUrl(this.options.upstreamBaseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(buildChatCompletionRequest(body, this.options.model)),
      });

      if (!upstreamResponse.ok || !upstreamResponse.body) {
        const text = await upstreamResponse.text().catch(() => "");
        writeJson(res, upstreamResponse.status || 502, {
          error: { message: text || `Upstream request failed with status ${upstreamResponse.status}.` },
        });
        return;
      }

      if (!upstreamResponse.headers.get("content-type")?.includes("text/event-stream")) {
        await writeNonStreamingChatResponse(res, upstreamResponse);
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      await pipeChatSseAsResponses(upstreamResponse.body, res, this.options.model);
    } catch (error) {
      if (!res.headersSent) {
        writeJson(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
      } else {
        res.end();
      }
    }
  }
}

export function buildChatCompletionRequest(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const instructions = readString(body.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });

  for (const item of asArray(body.input)) {
    const message = responseInputItemToChatMessage(item);
    if (message) messages.push(message);
  }

  const request: Record<string, unknown> = {
    model,
    messages,
    stream: body.stream !== false,
  };
  const tools = asArray(body.tools).map(responseToolToChatTool).filter((tool): tool is Record<string, unknown> => Boolean(tool));
  if (tools.length) request.tools = tools;
  if (typeof body.tool_choice === "string" || isPlainObject(body.tool_choice)) request.tool_choice = body.tool_choice;
  if (typeof body.parallel_tool_calls === "boolean") request.parallel_tool_calls = body.parallel_tool_calls;
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;
  if (typeof body.max_output_tokens === "number") request.max_tokens = body.max_output_tokens;
  return request;
}

function responseInputItemToChatMessage(item: unknown): Record<string, unknown> | null {
  if (!isPlainObject(item)) return null;
  if (item.type === "message") {
    const role = item.role === "assistant" ? "assistant" : item.role === "developer" || item.role === "system" ? "system" : "user";
    const content = responseContentToText(item.content);
    return content ? { role, content } : null;
  }
  if (item.type === "function_call") {
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: readString(item.call_id),
          type: "function",
          function: {
            name: readString(item.name),
            arguments: readString(item.arguments),
          },
        },
      ],
    };
  }
  if (item.type === "function_call_output") {
    return {
      role: "tool",
      tool_call_id: readString(item.call_id),
      content: readString(item.output),
    };
  }
  return null;
}

function responseContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  return asArray(content)
    .map((part) => {
      if (!isPlainObject(part)) return "";
      return readString(part.text);
    })
    .filter(Boolean)
    .join("\n");
}

function responseToolToChatTool(tool: unknown): Record<string, unknown> | null {
  if (!isPlainObject(tool) || tool.type !== "function") return null;
  return {
    type: "function",
    function: {
      name: readString(tool.name),
      description: readString(tool.description),
      parameters: isPlainObject(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
    },
  };
}

async function pipeChatSseAsResponses(body: ReadableStream<Uint8Array>, res: http.ServerResponse, model: string): Promise<void> {
  const state = new ResponsesStreamState(model);
  res.write(state.createdEvents());
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = splitSseEvents(buffer);
      buffer = events.rest;
      for (const eventText of events.items) {
        const data = parseSseData(eventText);
        if (!data) continue;
        if (data === "[DONE]") {
          res.write(state.completedEvents());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(state.consumeChatChunk(JSON.parse(data) as ChatChunk));
      }
    }
    res.write(state.completedEvents());
    res.write("data: [DONE]\n\n");
    res.end();
  } finally {
    reader.releaseLock();
  }
}

async function writeNonStreamingChatResponse(res: http.ServerResponse, upstreamResponse: Response): Promise<void> {
  const body = (await upstreamResponse.json()) as ChatCompletionResponse;
  const state = new ResponsesStreamState(readString(body.model) || "chat-model");
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(state.createdEvents());
  const message = body.choices?.[0]?.message;
  if (typeof message?.content === "string" && message.content) res.write(state.addText(message.content));
  for (const toolCall of message?.tool_calls ?? []) {
    res.write(state.addToolCall(toolCall));
  }
  res.write(state.completedEvents());
  res.write("data: [DONE]\n\n");
  res.end();
}

class ResponsesStreamState {
  private readonly responseId = `resp_${randomId()}`;
  private readonly output: Array<{ outputIndex: number; item: Record<string, unknown> }> = [];
  private nextOutputIndex = 0;
  private textItem: { id: string; outputIndex: number; text: string; started: boolean; done: boolean } | null = null;
  private readonly toolCalls = new Map<number, ToolCallState>();

  constructor(private readonly model: string) {}

  createdEvents(): string {
    return sse("response.created", {
      type: "response.created",
      response: { id: this.responseId, object: "response", status: "in_progress", model: this.model, output: [] },
    });
  }

  consumeChatChunk(chunk: ChatChunk): string {
    let out = "";
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) out += this.addText(delta.content);
      for (const toolCall of delta.tool_calls ?? []) out += this.addToolCallDelta(toolCall);
      if (choice.finish_reason) out += this.finishOpenItems();
    }
    return out;
  }

  addText(delta: string): string {
    if (!this.textItem) {
      this.textItem = { id: `msg_${randomId()}`, outputIndex: this.nextOutputIndex++, text: "", started: false, done: false };
    }
    let out = "";
    if (!this.textItem.started) {
      this.textItem.started = true;
      out += sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: this.textItem.outputIndex,
        item: { id: this.textItem.id, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      out += sse("response.content_part.added", {
        type: "response.content_part.added",
        item_id: this.textItem.id,
        output_index: this.textItem.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.textItem.text += delta;
    out += sse("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.textItem.id,
      output_index: this.textItem.outputIndex,
      content_index: 0,
      delta,
    });
    return out;
  }

  addToolCall(toolCall: ChatToolCall): string {
    return this.addToolCallDelta({
      index: this.toolCalls.size,
      id: toolCall.id,
      type: toolCall.type,
      function: toolCall.function,
    });
  }

  addToolCallDelta(toolCall: ChatToolCallDelta): string {
    const index = typeof toolCall.index === "number" ? toolCall.index : this.toolCalls.size;
    let state = this.toolCalls.get(index);
    let out = "";
    if (!state) {
      state = {
        outputIndex: this.nextOutputIndex++,
        itemId: `fc_${randomId()}`,
        callId: readString(toolCall.id) || `call_${randomId()}`,
        name: readString(toolCall.function?.name) || "tool_call",
        arguments: "",
        started: false,
        done: false,
      };
      this.toolCalls.set(index, state);
    }
    if (toolCall.id) state.callId = readString(toolCall.id);
    if (toolCall.function?.name) state.name = readString(toolCall.function.name);
    if (!state.started) {
      state.started = true;
      out += sse("response.output_item.added", {
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
    const argsDelta = readString(toolCall.function?.arguments);
    if (argsDelta) {
      state.arguments += argsDelta;
      out += sse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta: argsDelta,
      });
    }
    return out;
  }

  finishOpenItems(): string {
    let out = "";
    if (this.textItem?.started && !this.textItem.done) {
      this.textItem.done = true;
      const outputIndex = this.textItem.outputIndex;
      const item = {
        id: this.textItem.id,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: this.textItem.text, annotations: [] }],
      };
      out += sse("response.output_text.done", {
        type: "response.output_text.done",
        item_id: this.textItem.id,
        output_index: outputIndex,
        content_index: 0,
        text: this.textItem.text,
      });
      out += sse("response.content_part.done", {
        type: "response.content_part.done",
        item_id: this.textItem.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: this.textItem.text, annotations: [] },
      });
      out += sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
      this.output.push({ outputIndex, item });
    }

    for (const state of [...this.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      if (state.done || !state.started) continue;
      state.done = true;
      const item = {
        id: state.itemId,
        type: "function_call",
        status: "completed",
        call_id: state.callId,
        name: state.name,
        arguments: state.arguments,
      };
      out += sse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: state.itemId,
        output_index: state.outputIndex,
        arguments: state.arguments,
      });
      out += sse("response.output_item.done", { type: "response.output_item.done", output_index: state.outputIndex, item });
      this.output.push({ outputIndex: state.outputIndex, item });
    }
    return out;
  }

  completedEvents(): string {
    return `${this.finishOpenItems()}${sse("response.completed", {
      type: "response.completed",
      response: {
        id: this.responseId,
        object: "response",
        status: "completed",
        model: this.model,
        output: [...this.output].sort((a, b) => a.outputIndex - b.outputIndex).map((entry) => entry.item),
      },
    })}`;
  }
}

interface ToolCallState {
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  started: boolean;
  done: boolean;
}

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: ChatToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
}

interface ChatToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ChatToolCall[];
    };
  }>;
}

function splitSseEvents(buffer: string): { items: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  return { items: parts.slice(0, -1), rest: parts.at(-1) ?? "" };
}

function parseSseData(eventText: string): string | null {
  const lines = eventText
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  return lines.length ? lines.join("\n") : null;
}

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isResponsesPath(url: string): boolean {
  const pathname = url.split("?")[0].replace(/\/+$/, "");
  return pathname === "/responses" || pathname === "/v1/responses";
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
