import { describe, expect, it } from "vitest";
import { loadRuntimeLocalConfig } from "./runtime-local-config";

describe("loadRuntimeLocalConfig", () => {
  it("preserves the Responses protocol when importing the local Codex config", async () => {
    const imported = await loadRuntimeLocalConfig({
      runtimeId: "codex",
      executable: "codex",
      existingChannel: {
        id: "codex-openai",
        agentId: "codex",
        label: "Codex OpenAI",
        modelProvider: "openai",
        models: [{ id: "default", label: "Default" }],
      },
      dependencies: {
        loadCodexConfig: async () => ({
          modelProvider: "custom",
          providerName: "custom",
          baseUrl: "http://127.0.0.1:15721/v1",
          wireApi: "responses",
          apiKey: "proxy-key",
          modelId: "gpt-5.6-sol",
          modelCatalogJson: null,
          modelReasoningEffort: null,
          httpHeaders: null,
          plugins: null,
        }),
      },
    });

    expect(imported.channel).toMatchObject({
      id: "codex-openai",
      modelProvider: "custom",
      wireApi: "responses",
      apiFormat: "openai_responses",
    });
  });
});
