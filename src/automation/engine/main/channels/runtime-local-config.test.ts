import { describe, expect, test, vi } from "vitest";
import { loadRuntimeLocalConfig } from "./runtime-local-config";

describe("runtime local config import", () => {
  test("imports a Codex API key as plaintext channel configuration", async () => {
    const result = await loadRuntimeLocalConfig({
      runtimeId: "codex",
      executable: "codex",
      dependencies: {
        homeDir: "/home/demo",
        loadCodexConfig: async () => ({
          modelProvider: "custom",
          providerName: "Custom",
          baseUrl: "https://provider.example/v1",
          wireApi: "responses",
          httpHeaders: { "x-tenant": "demo" },
          apiKey: "plain-codex-token",
          modelId: "gpt-local",
          modelCatalogJson: null,
          modelReasoningEffort: null,
          plugins: null,
        }),
      },
    });

    expect(result.channel).toMatchObject({
      id: "codex-openai",
      models: [{ id: "default" }, { id: "gpt-local" }],
      httpHeaders: { "x-tenant": "demo", Authorization: "Bearer plain-codex-token" },
    });
  });

  test("imports Claude environment tokens without redaction", async () => {
    const result = await loadRuntimeLocalConfig({
      runtimeId: "claude",
      executable: "claude",
      dependencies: {
        homeDir: "/home/demo",
        readTextFile: vi.fn(async () => JSON.stringify({
          env: {
            ANTHROPIC_MODEL: "claude-local",
            ANTHROPIC_AUTH_TOKEN: "plain-claude-token",
          },
        })) as never,
      },
    });

    expect(result.channel.models).toEqual([{ id: "default", label: "Default" }, { id: "claude-local", label: "claude-local" }]);
    expect(result.channel.environment?.ANTHROPIC_AUTH_TOKEN).toBe("plain-claude-token");
  });

  test("imports Hermes model, endpoint, and API key from config.yaml", async () => {
    const result = await loadRuntimeLocalConfig({
      runtimeId: "hermes",
      executable: "hermes",
      dependencies: {
        exec: vi.fn(async () => ({ stdout: "/home/demo/.hermes/config.yaml\n", stderr: "" })) as never,
        readTextFile: vi.fn(async () => [
          "model:",
          "  default: provider/model",
          "  provider: custom",
          "  base_url: https://provider.example/v1",
          "  api_key: plain-hermes-token",
        ].join("\n")) as never,
      },
    });

    expect(result.channel).toMatchObject({
      modelProvider: "custom",
      baseUrl: "https://provider.example/v1",
      httpHeaders: { Authorization: "Bearer plain-hermes-token" },
      models: [{ id: "default" }, { id: "provider/model" }],
    });
  });

  test("imports OpenClaw model and gateway token", async () => {
    const exec = vi.fn(async (request: { args?: string[] }) => ({
      stdout: request.args?.at(-1) === "gateway.auth.token" ? "plain-gateway-token\n" : "provider/model\n",
      stderr: "",
    }));
    const result = await loadRuntimeLocalConfig({
      runtimeId: "openclaw",
      executable: "openclaw",
      dependencies: { exec: exec as never },
    });

    expect(result.channel.models).toEqual([{ id: "default", label: "Default" }, { id: "provider/model", label: "provider/model" }]);
    expect(result.channel.environment?.OPENCLAW_GATEWAY_TOKEN).toBe("plain-gateway-token");
  });

  test("rejects local import for the virtual API runtime", async () => {
    await expect(loadRuntimeLocalConfig({ runtimeId: "api", executable: "api" })).rejects.toThrow(
      "API does not have a local CLI config to import",
    );
  });

  test("keeps OpenCode on its runtime default when no model or provider is configured", async () => {
    const result = await loadRuntimeLocalConfig({
      runtimeId: "opencode",
      executable: "opencode",
      dependencies: {
        exec: vi.fn(async () => ({ stdout: JSON.stringify({ plugin: [] }), stderr: "" })) as never,
      },
    });

    expect(result.channel).toMatchObject({
      id: "opencode-default",
      presetId: "opencode-default",
      models: [{ id: "default", label: "Default" }],
    });
    expect(result.channel.modelProvider).toBeUndefined();
    expect(result.channel.baseUrl).toBeUndefined();
  });
});
