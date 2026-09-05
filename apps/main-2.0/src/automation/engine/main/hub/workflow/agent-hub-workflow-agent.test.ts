import { describe, expect, test } from "vitest";

import type { WorkflowAgentRequest } from "../../../shared/types";
import { buildWorkflowAgentExecution } from "./agent-hub-workflow-agent";

describe("buildWorkflowAgentExecution", () => {
  test("preserves node completion identity for the Runtime output tool", () => {
    const request = {
      configuredAgentId: "configured",
      prompt: "Complete",
      runtimeId: "codex",
      runtimeConfig: { model: "gpt-5.4" },
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      planningWorkflowId: "workflow",
      workflowRunId: "run",
      workflowNodeId: "node",
      workflowNodeExecutionId: "execution",
      invocation: { surface: "workflow", role: "node" },
    } satisfies WorkflowAgentRequest;

    const execution = buildWorkflowAgentExecution({
      request,
      resolveConfiguredAgent: () => ({
        agent: { id: "configured", name: "Configured" },
        runtimeAgentId: "codex" as const,
        runtime: { available: true },
        channel: { id: "codex-default" },
      }),
      cloneConversationForPolicy: () => undefined,
      defaultWorkDir: "/workspace",
      createRequestId: () => "request",
    });

    expect(execution).toMatchObject({
      planningWorkflowId: "workflow",
      workflowRunId: "run",
      workflowNodeId: "node",
      workflowNodeExecutionId: "execution",
    });
  });
});
