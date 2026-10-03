import { describe, expect, it } from "vitest";
import { parseIpcRequest } from "./contract";
import { PROVIDERS_IPC } from "./providers";

describe("summary connection IPC", () => {
  it("accepts the official Codex CLI route without a Base URL or API key", () => {
    const request = { source: "codex", baseUrl: "", apiKey: "", model: "gpt-6-sol", apiFormat: "openai_responses" };
    expect(parseIpcRequest(PROVIDERS_IPC.testSummaryProviderConnection, [request])).toEqual([request]);
  });

  it("continues to require a Base URL for direct API requests", () => {
    expect(() => parseIpcRequest(PROVIDERS_IPC.testSummaryProviderConnection, [{
      source: "custom", baseUrl: "", apiKey: "test", model: "test", providerId: "custom", apiFormat: "openai_responses",
    }])).toThrow(/baseUrl/);
  });
});
