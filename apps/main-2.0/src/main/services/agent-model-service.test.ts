import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { AgentModelNotReadyError, defaultAgentModelConfig, type AgentModelConfig } from "../../core/agent-model-config";
import type { ScannedAgentModelImports } from "../../core/agent-model-imports";
import { AgentModelService } from "./agent-model-service";

function service(config: AgentModelConfig, keys: Record<string, string> = {}, scanned: ScannedAgentModelImports = { imports: [], problems: [] }) {
  const get = vi.fn(async (provider: string) => keys[provider] ?? "");
  const set = vi.fn(async (provider: string, apiKey: string) => { keys[provider] = apiKey; });
  return { get, set, service: new AgentModelService({ config: () => config, keys: { get, set }, scanImports: async () => scanned }) };
}

/** A Chat Completions endpoint that answers "OK" and records the Authorization header of each request. */
async function okEndpoint() {
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
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    authorizations,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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
    const endpoint = await okEndpoint();
    try {
      const { service: agentModel } = service(defaultAgentModelConfig, { custom: "saved-key" });

      const result = await agentModel.test({ provider: " custom ", model: " local-model ", baseUrl: `${endpoint.baseUrl}/`, api: "openai-completions" }, null);

      expect(result).toEqual({ model: "local-model", reply: "OK" });
      expect(endpoint.authorizations).toEqual(["Bearer saved-key"]);
    } finally {
      await endpoint.close();
    }
  });

  it("keeps imported keys in the main process and uses one only for the endpoints of its service", async () => {
    const endpoint = await okEndpoint();
    try {
      const choice = (model: string): AgentModelConfig => ({ provider: "custom", model, baseUrl: endpoint.baseUrl, api: "openai-completions" });
      const imported = {
        service: { id: "relay", name: "Relay", host: "127.0.0.1", sources: ["zcode" as const], choices: [{ config: choice("local-model"), label: "local-model" }] },
        apiKey: "imported-key",
      };
      const { service: agentModel, set } = service(defaultAgentModelConfig, {}, { imports: [imported], problems: [{ source: "dsh", message: "Unreadable." }] });

      const listed = await agentModel.listImports();
      expect(listed).toEqual({ imports: [imported.service], problems: [{ source: "dsh", message: "Unreadable." }] });
      expect(JSON.stringify(listed)).not.toContain("imported-key");

      // Another model behind the same endpoint may use the key; another endpoint may not.
      await expect(agentModel.test(choice("other-model"), { importId: "relay" })).resolves.toEqual({ model: "other-model", reply: "OK" });
      expect(endpoint.authorizations).toEqual(["Bearer imported-key"]);
      await expect(agentModel.test({ ...choice("local-model"), baseUrl: "https://elsewhere.example.com/v1" }, { importId: "relay" }))
        .rejects.toThrow("The key imported for Relay cannot be used with this endpoint.");
      await expect(agentModel.saveKey(choice("local-model"), { importId: "gone" })).rejects.toThrow("no longer available");

      await agentModel.saveKey(choice("local-model"), { importId: "relay" });
      expect(set).toHaveBeenCalledWith("custom", "imported-key");
      await expect(agentModel.saveKey(choice("local-model"), { apiKey: "  " })).rejects.toThrow("Enter an API key.");
    } finally {
      await endpoint.close();
    }
  });
});
