import { describe, expect, test, vi } from "vitest";

import type { AgentChannel, ConfiguredAgent, WorkflowAgentRequest } from "../../shared/types";
import { ConfiguredAgentExecutionService } from "./configured-agent-execution-service";

describe("ConfiguredAgentExecutionService", () => {
  test("forwards a Core Workflow node execution to Runtime MCP context", async () => {
    const agent = {
      id: "configured",
      name: "Configured",
      description: "",
      runtimeAgentId: "codex",
      channelId: "codex-default",
      modelId: "gpt-5.4",
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    } satisfies ConfiguredAgent;
    const channel = {
      id: "codex-default",
      agentId: "codex",
      label: "Codex",
      models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
    } as AgentChannel;
    const execute = vi.fn(async (_request: WorkflowAgentRequest) => ({ content: "Done" }));
    const service = new ConfiguredAgentExecutionService({
      agents: () => [agent],
      channels: () => [channel],
      defaultWorkDir: () => "/workspace",
      execute,
    });

    await service.runOneShot({
      configuredAgentId: agent.id,
      prompt: "Complete the node",
      invocation: { surface: "workflow", role: "node" },
      workflowExecution: {
        workflowId: "workflow",
        runId: "run",
        nodeId: "review",
        executionId: "execution",
      },
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      planningWorkflowId: "workflow",
      workflowRunId: "run",
      workflowNodeId: "review",
      workflowNodeExecutionId: "execution",
      invocation: { surface: "workflow", role: "node" },
    }));
  });
});
