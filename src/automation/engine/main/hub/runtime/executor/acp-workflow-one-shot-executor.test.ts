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

  test("does not turn a completed node into a failure when ACP detach cleanup fails", async () => {
    const context = {
      runId: "task-1",
      prompt: "Complete",
      workDir: "C:/workspace",
      developerInstructions: "Submit result",
      emit: vi.fn(),
      onExit: vi.fn(),
    } as unknown as AgentExecutionContext;
    const executor = new AcpWorkflowOneShotExecutor(context, {
      executable: "hermes",
      args: ["acp"],
      mcpServers: [],
      createClient: () => ({
        attach: async () => "session-1",
        prompt: async () => undefined,
        interrupt: async () => undefined,
        detach: async () => { throw new Error("detach failed"); },
      }),
    });

    await expect(executor.start()).resolves.toBeUndefined();
    expect(context.onExit).toHaveBeenCalledWith(0);
    expect(context.emit).toHaveBeenCalledWith({ type: "system", content: "ACP one-shot cleanup failed: detach failed" });
  });

  test("always detaches when interrupting an active ACP one-shot session", async () => {
    const detached = vi.fn(async () => undefined);
    let releasePrompt!: () => void;
    const promptBlocked = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const context = {
      runId: "task-1",
      prompt: "Complete",
      workDir: "C:/workspace",
      developerInstructions: "Submit result",
      emit: vi.fn(),
      onExit: vi.fn(),
    } as unknown as AgentExecutionContext;
    const executor = new AcpWorkflowOneShotExecutor(context, {
      executable: "hermes",
      args: ["acp"],
      mcpServers: [],
      createClient: () => ({
        attach: async () => "session-1",
        prompt: async () => promptBlocked,
        interrupt: async () => { throw new Error("interrupt failed"); },
        detach: detached,
      }),
    });
    const started = executor.start();
    await Promise.resolve();

    await expect(executor.stop()).rejects.toThrow("interrupt failed");
    expect(detached).toHaveBeenCalled();
    releasePrompt();
    await started;
    expect(detached).toHaveBeenCalledTimes(1);
  });

  test("reports detach failure from an explicit stop after attempting cleanup", async () => {
    let releasePrompt!: () => void;
    const promptBlocked = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const context = {
      runId: "task-1", prompt: "Complete", workDir: "C:/workspace", developerInstructions: "Submit result",
      emit: vi.fn(), onExit: vi.fn(),
    } as unknown as AgentExecutionContext;
    const executor = new AcpWorkflowOneShotExecutor(context, {
      executable: "hermes", args: ["acp"], mcpServers: [],
      createClient: () => ({
        attach: async () => "session-1",
        prompt: async () => promptBlocked,
        interrupt: async () => undefined,
        detach: async () => { throw new Error("detach failed"); },
      }),
    });
    const started = executor.start();
    await Promise.resolve();

    await expect(executor.stop()).rejects.toThrow("detach failed");
    releasePrompt();
    await started;
  });
});
