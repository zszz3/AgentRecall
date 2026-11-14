import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { AgentModelNotReadyError, defaultAgentModelConfig, type AgentModelConfig } from "../../core/agent-model-config";
import { AgentModelService } from "./agent-model-service";

function service(config: AgentModelConfig, keys: Record<string, string> = {}) {
  const get = vi.fn(async (provider: string) => keys[provider] ?? "");
  return { get, service: new AgentModelService({ config: () => config, keys: { get, set: vi.fn(async () => undefined) } }) };
}

describe("AgentModelService", () => {
  it("refuses to call before the model and its API key are set up", async () => {
    await expect(service(defaultAgentModelConfig).service.complete("hi")).rejects.toThrow(AgentModelNotReadyError);

    const deepseek = { ...defaultAgentModelConfig, provider: "deepseek", model: "deepseek-v4-pro" };
    const withoutKey = service(deepseek);
    await expect(withoutKey.service.complete("hi")).rejects.toThrow("Save the API key of the AgentRecall model");
    expect(withoutKey.get).toHaveBeenCalledWith("deepseek");
  });

  it("tests an unsaved choice with the key saved for its provider", async () => {
    const authorizations: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({
          id: "c", object: "chat.completion.chunk", created: 0, model: "local-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const { service: agentModel } = service(defaultAgentModelConfig, { custom: "saved-key" });

      const result = await agentModel.test(
        { provider: " custom ", model: " local-model ", baseUrl: `http://127.0.0.1:${port}/v1/`, api: "openai-completions" },
        null,
      );

      expect(result).toEqual({ model: "local-model", reply: "OK" });
      expect(authorizations).toEqual(["Bearer saved-key"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
