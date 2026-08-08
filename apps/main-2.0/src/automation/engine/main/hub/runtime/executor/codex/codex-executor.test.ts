import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentExecutionContext, RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";

const rpc = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("../../../../agents/codex/codex-rpc", () => ({
  CodexRpcClient: class {
    async start(): Promise<void> {}
    request(method: string, params: unknown): Promise<unknown> {
      rpc.request(method, params);
      if (method === "thread/start" || method === "thread/resume") return Promise.resolve({ thread: { id: "thread-1" } });
      return Promise.resolve({});
    }
    respond(): void {}
    async shutdown(): Promise<void> {}
  },
}));

import { CodexAgentExecutor } from "./codex-executor";

function context(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    runId: "task-1",
    runKind: "task",
    configuredAgentId: "agent-1",
    runtimeId: "codex",
    executionMode: "oneshot",
    continuationPolicy: "fresh",
    runtimeConfig: { model: "default" },
    runtime: { id: "codex", label: "Codex", version: "test", available: true, command: "codex" },
    channelId: "codex-channel",
    prompt: "Review the result",
    workDir: "C:/repo",
    developerInstructions: "",
    emit: () => undefined,
    onExit: () => undefined,
    ...overrides,
  };
}

const options: RuntimeAgentExecutorFactoryOptions = {
  executables: { api: "", codex: "codex", claude: "", opencode: "", openclaw: "", hermes: "" },
  channelById: () => ({ id: "codex-channel", agentId: "codex", label: "Codex", models: [{ id: "default", label: "Default" }] }),
};

describe("CodexAgentExecutor approval policy", () => {
  beforeEach(() => rpc.request.mockClear());

  test("enables native approval requests for Workflow and Review tasks", async () => {
    await new CodexAgentExecutor(context({ planningWorkflowId: "wf-1", workflowRunId: "run-1", workflowNodeId: "answer" }), options).start();

    expect(rpc.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ approvalPolicy: "on-request" }));
  });

  test("keeps standalone one-shot tasks non-interactive", async () => {
    await new CodexAgentExecutor(context(), options).start();

    expect(rpc.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ approvalPolicy: "never" }));
  });
});
