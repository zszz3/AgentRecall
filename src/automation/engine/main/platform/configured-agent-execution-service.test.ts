import { describe, expect, it, vi } from "vitest";
import type { AgentChannel, ConfiguredAgent } from "../../shared/types";
import { ConfiguredAgentExecutionService } from "./configured-agent-execution-service";

describe("ConfiguredAgentExecutionService", () => {
  it("executes a configured Agent as a fresh one-shot in the current work directory", async () => {
    const channel: AgentChannel = {
      id: "codex-main",
      agentId: "codex",
      label: "Codex",
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", reasoningEfforts: ["high"] }],
    };
    const agent: ConfiguredAgent = {
      id: "reviewer",
      agentType: "execution",
      name: "Reviewer",
      description: "",
      runtimeAgentId: "codex",
      channelId: channel.id,
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const execute = vi.fn(async () => ({ content: "review complete" }));
    const service = new ConfiguredAgentExecutionService({
      agents: () => [agent],
      channels: () => [channel],
      defaultWorkDir: () => "/synthetic/repo",
      execute,
    });

    const result = await service.runOneShot({ configuredAgentId: agent.id, prompt: "Review this" });

    expect(result.output).toBe("review complete");
    expect(execute).toHaveBeenCalledWith({
      configuredAgentId: "reviewer",
      prompt: "Review this",
      runtimeId: "codex",
      runtimeConfig: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      workDir: "/synthetic/repo",
    });
  });
});
