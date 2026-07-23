import { describe, expect, test, vi } from "vitest";
import type { AgentExecutionContext } from "./agent-executor-types";
import { AcpWorkflowOneShotExecutor } from "./acp-workflow-one-shot-executor";

describe("AcpWorkflowOneShotExecutor", () => {
  test("creates a one-shot ACP session with workflow MCP servers", async () => {
    const calls: string[] = [];
    const context = {
      runId: "task-1",
      runKind: "task",
      configuredAgentId: "agent-1",
      planningWorkflowId: "wf-1",
      workflowRunId: "run-1",
      workflowNodeId: "node-1",
      runtime: { id: "hermes", available: true },
      channelId: "hermes-default",
      runtimeConfig: { model: "default" },
      prompt: "Complete the node",
      workDir: "C:/workspace",
      developerInstructions: "Use workflow_node_complete.",
      emit: vi.fn(),
      onExit: vi.fn(),
    } as unknown as AgentExecutionContext;
    const mcpServers = [{ name: "agent_recall_workflow", command: "node", args: ["server.js"], env: [] }];

    const executor = new AcpWorkflowOneShotExecutor(context, {
      executable: "hermes",
      args: ["acp"],
      mcpServers,
      createClient: (options) => {
        expect(options.mcpServers).toEqual(mcpServers);
        expect(options.approvalOwnerId).toBe("task-1");
        return {
          attach: async () => { calls.push("attach"); return "session-1"; },
          prompt: async (prompt) => { calls.push(`prompt:${prompt}`); },
          interrupt: async () => { calls.push("interrupt"); },
          detach: async () => { calls.push("detach"); },
        };
      },
    });

    await executor.start();

    expect(calls).toEqual(["attach", "prompt:Use workflow_node_complete.\n\nUser request:\nComplete the node", "detach"]);
    expect(context.onExit).toHaveBeenCalledWith(0);
  });
});
