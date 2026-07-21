import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentChannel } from "../../shared/types";
import { codexChannelNeedsChatRouting, startCodexChatRouter, type CodexChatRouterServer } from "./codex-chat-router";

const servers: Array<{ stop: () => Promise<void> }> = [];

describe("Codex chat router", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  test("only routes providers configured for Chat Completions", () => {
    expect(codexChannelNeedsChatRouting({
      id: "native",
      agentId: "codex",
      label: "Native responses",
      modelProvider: "native",
      baseUrl: "https://native.example/v1",
      apiFormat: "openai_responses",
      models: [{ id: "default", label: "Default" }],
    })).toBe(false);
    expect(codexChannelNeedsChatRouting({
      id: "chat",
      agentId: "codex",
      label: "Chat upstream",
      modelProvider: "chat",
      baseUrl: "https://chat.example/v1",
      apiFormat: "openai_chat",
      models: [{ id: "default", label: "Default" }],
    })).toBe(true);
  });

  test("applies full endpoint, user agent, and request overrides", async () => {
    let captured: { url?: string; headers?: http.IncomingHttpHeaders; body?: unknown } = {};
    const upstream = await startJsonUpstream(async (body, request) => {
      captured = { url: request.url ?? "", headers: request.headers, body };
      return { id: "chatcmpl_override", model: "model-a", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
    });
    const router = await startRouter(`${upstream.baseUrl}/custom-chat`, {
      isFullUrl: true,
      customUserAgent: "multi-agent-chat/test",
      requestOverrides: {
        headers: { "x-provider": "override" },
        body: { service_tier: "priority" },
      },
    });

    await fetch(`${router.baseUrl}/codex-test/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model-a", input: "hello" }),
    });

    expect(captured.url).toBe("/v1/custom-chat");
    expect(captured.headers).toMatchObject({ "user-agent": "multi-agent-chat/test", "x-provider": "override" });
    expect(captured.body).toMatchObject({ model: "model-a", service_tier: "priority" });
  });

  test("converts Responses function tools to Chat tools and back", async () => {
    let capturedBody: unknown;
    const upstream = await startJsonUpstream(async (body) => {
      capturedBody = body;
      return {
        id: "chatcmpl_tool",
        model: "deepseek-v4-flash",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_read",
                  type: "function",
                  function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
    });
    const router = await startRouter(upstream.baseUrl);

    const response = await fetch(`${router.baseUrl}/codex-test/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        input: "Read README.md",
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a local file.",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(capturedBody).toMatchObject({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "Read README.md" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    const payload = await response.json();
    expect(payload.output).toEqual([
      {
        id: "fc_call_read",
        type: "function_call",
        status: "completed",
        call_id: "call_read",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
    ]);
  });

  test("streams Chat tool call deltas as Responses tool call events", async () => {
    const upstream = await startSseUpstream([
      'data: {"id":"chatcmpl_stream","model":"deepseek-v4-flash","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read_file"}}]}}]}\n\n',
      'data: {"id":"chatcmpl_stream","model":"deepseek-v4-flash","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const router = await startRouter(upstream.baseUrl);

    const response = await fetch(`${router.baseUrl}/codex-test/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: true,
        input: "Read README.md",
        tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: response.output_item.added");
    expect(text).toContain("event: response.function_call_arguments.delta");
    expect(text).toContain("event: response.function_call_arguments.done");
    expect(text).toContain('"type":"function_call"');
    expect(text).toContain('"call_id":"call_read"');
    expect(text).toContain('"arguments":"{\\"path\\":\\"README.md\\"}"');
    expect(text).toContain("event: response.completed");
  });
});

async function startRouter(baseUrl: string, overrides: Partial<AgentChannel> = {}): Promise<CodexChatRouterServer> {
  const channel: AgentChannel = {
    id: "codex-test",
    agentId: "codex",
    label: "Codex Test",
    modelProvider: "deepseek",
    providerName: "DeepSeek",
    baseUrl,
    wireApi: "responses",
    models: [
      { id: "default", label: "Default" },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    ],
    ...overrides,
  };
  const router = await startCodexChatRouter({ channels: () => [channel] });
  servers.push(router);
  return router;
}

async function startJsonUpstream(handler: (body: unknown, request: http.IncomingMessage) => Promise<unknown>): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const payload = await handler(body, request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`${JSON.stringify(payload)}\n`);
  });
  return listen(server);
}

async function startSseUpstream(chunks: string[]): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of chunks) response.write(chunk);
    response.end();
  });
  return listen(server);
}

async function listen(server: http.Server): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const handle = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    stop: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
  servers.push(handle);
  return handle;
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
