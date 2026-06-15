import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CodexChatProxy } from "./codex-chat-proxy";

const runningProxies: CodexChatProxy[] = [];

afterEach(async () => {
  await Promise.all(runningProxies.splice(0).map((proxy) => proxy.stop()));
});

describe("Codex Chat proxy", () => {
  it("translates Codex Responses requests into Chat Completions upstream requests", async () => {
    const upstreamRequests: Array<{ url: string | undefined; body: any; authorization: string | undefined }> = [];
    const upstream = await startUpstreamServer((req, body, res) => {
      upstreamRequests.push({
        url: req.url,
        body: JSON.parse(body),
        authorization: req.headers.authorization,
      });
      writeChatSse(res, [
        { id: "chatcmpl-text", choices: [{ index: 0, delta: { role: "assistant", content: "hello" } }] },
        { id: "chatcmpl-text", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });

    try {
      const proxy = new CodexChatProxy({
        upstreamBaseUrl: upstream.baseUrl,
        apiKey: "sk-upstream",
        model: "glm-5.1",
      });
      runningProxies.push(proxy);
      const status = await proxy.start();

      const response = await fetch(`${status.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer codex-local" },
        body: JSON.stringify({
          model: "glm-5.1",
          instructions: "Use repo rules.",
          input: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: "Prefer concise answers." }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "Say hello." }] },
          ],
          tools: [
            {
              type: "function",
              name: "exec_command",
              description: "Runs a shell command.",
              parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
            },
          ],
          tool_choice: "auto",
          parallel_tool_calls: false,
          max_output_tokens: 1024,
          stream: true,
        }),
      });

      const responseText = await response.text();

      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0].url).toBe("/v1/chat/completions");
      expect(upstreamRequests[0].authorization).toBe("Bearer sk-upstream");
      expect(upstreamRequests[0].body).toMatchObject({
        model: "glm-5.1",
        stream: true,
        tool_choice: "auto",
        parallel_tool_calls: false,
        max_tokens: 1024,
      });
      expect(upstreamRequests[0].body.messages).toEqual([
        { role: "system", content: "Use repo rules." },
        { role: "system", content: "Prefer concise answers." },
        { role: "user", content: "Say hello." },
      ]);
      expect(upstreamRequests[0].body.tools).toEqual([
        {
          type: "function",
          function: {
            name: "exec_command",
            description: "Runs a shell command.",
            parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
          },
        },
      ]);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(responseText).toContain("event: response.output_text.delta");
      expect(responseText).toContain('"delta":"hello"');
      expect(responseText).toContain("event: response.completed");
    } finally {
      await upstream.close();
    }
  });

  it("translates Chat Completions tool calls back into Responses function call events", async () => {
    const upstream = await startUpstreamServer((_req, _body, res) => {
      writeChatSse(res, [
        {
          id: "chatcmpl-tool",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "exec_command", arguments: "{\"cmd\"" },
                  },
                ],
              },
            },
          ],
        },
        {
          id: "chatcmpl-tool",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: ":\"pwd\"}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);
    });

    try {
      const proxy = new CodexChatProxy({
        upstreamBaseUrl: upstream.baseUrl,
        apiKey: "sk-upstream",
        model: "glm-5.1",
      });
      runningProxies.push(proxy);
      const status = await proxy.start();

      const response = await fetch(`${status.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "glm-5.1",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Run pwd." }] }],
          stream: true,
        }),
      });

      const responseText = await response.text();

      expect(responseText).toContain("event: response.output_item.added");
      expect(responseText).toContain('"type":"function_call"');
      expect(responseText).toContain("event: response.function_call_arguments.delta");
      expect(responseText).toContain('"{\\"cmd\\""');
      expect(responseText).toContain('":\\"pwd\\"}"');
      expect(responseText).toContain("event: response.function_call_arguments.done");
      expect(responseText).toContain('"arguments":"{\\"cmd\\":\\"pwd\\"}"');
      expect(responseText).toContain("event: response.output_item.done");
    } finally {
      await upstream.close();
    }
  });

  it("keeps distinct Responses output indexes when text and tool calls share a Chat stream", async () => {
    const upstream = await startUpstreamServer((_req, _body, res) => {
      writeChatSse(res, [
        { id: "chatcmpl-mixed", choices: [{ index: 0, delta: { role: "assistant", content: "checking" } }] },
        {
          id: "chatcmpl-mixed",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);
    });

    try {
      const proxy = new CodexChatProxy({
        upstreamBaseUrl: upstream.baseUrl,
        apiKey: "sk-upstream",
        model: "glm-5.1",
      });
      runningProxies.push(proxy);
      const status = await proxy.start();

      const response = await fetch(`${status.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "glm-5.1",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Check and run pwd." }] }],
          stream: true,
        }),
      });

      const responseText = await response.text();
      const outputItemAdded = responseText
        .split("\n\n")
        .filter((eventText) => eventText.includes("event: response.output_item.added"))
        .map((eventText) => JSON.parse(eventText.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));

      expect(outputItemAdded.map((event) => event.output_index)).toEqual([0, 1]);
      expect(outputItemAdded[0].item.type).toBe("message");
      expect(outputItemAdded[1].item.type).toBe("function_call");
    } finally {
      await upstream.close();
    }
  });
});

async function startUpstreamServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => handler(req, Buffer.concat(chunks).toString("utf8"), res));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function writeChatSse(res: http.ServerResponse, chunks: any[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}
