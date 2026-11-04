import { describe, expect, test, vi } from "vitest";

import type { AgentChannel, ConfiguredAgent, AgentOneShotRequest } from "../../shared/types";
import { ConfiguredAgentExecutionService } from "./configured-agent-execution-service";

describe("ConfiguredAgentExecutionService", () => {
  test.each(["codex", "dsh"] as const)("forwards fresh %s one-shot requests", async (runtimeId) => {
    const agent = {
      id: "configured",
      name: "Configured",
      description: "",
      runtimeAgentId: runtimeId,
      channelId: "codex-default",
      modelId: runtimeId === "dsh" ? "default" : "gpt-5.4",
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    } satisfies ConfiguredAgent;
    const channel = {
      id: "codex-default",
      agentId: runtimeId,
      label: "Codex",
      models: [{ id: agent.modelId, label: agent.modelId }],
    } as AgentChannel;
    const conversation = { runtimeId, codecVersion: "v1" as const, payload: { native: { sessionId: "session-test" } } };
    const execute = vi.fn(async (_request: AgentOneShotRequest) => ({ content: "Done", runtimeConversation: conversation }));
    const service = new ConfiguredAgentExecutionService({
      agents: () => [agent],
      channels: () => [channel],
      defaultWorkDir: () => "/workspace",
      execute,
    });

    await service.runOneShot({
      configuredAgentId: agent.id,
      prompt: "Summarize the change",
      invocation: { surface: "evaluation", role: "candidate" },
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: expect.any(String),
      runtimeId,
      continuationPolicy: "fresh",
      prompt: "Summarize the change",
      invocation: { surface: "evaluation", role: "candidate" },
    }));
  });
});
