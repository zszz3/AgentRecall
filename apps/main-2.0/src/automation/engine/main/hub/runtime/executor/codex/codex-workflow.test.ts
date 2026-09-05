import { describe, expect, test, vi } from "vitest";

import type { RuntimeWorkflowRequestContext } from "../../../../agents/runtime/runtime-driver";
import type { RuntimeWorkflowExecutionOptions } from "../workflow/agent-executor-workflow-shared";

vi.mock("../../../../agents/codex/codex-rpc", () => ({
  CodexRpcClient: class {
    async start(): Promise<void> {}
    async request(method: string): Promise<unknown> {
      if (method === "thread/start") return { thread: { id: "thread-created-before-turn" } };
      if (method === "turn/start") throw new Error("turn/start failed");
      return {};
    }
    respond(): void {}
    async shutdown(): Promise<void> {}
  },
}));

import { runCodexWorkflow } from "./codex-workflow";

describe("Codex Workflow native Session binding", () => {
  test("reports the thread before turn/start can fail", async () => {
    const reportExecutionReference = vi.fn();
    const input: RuntimeWorkflowRequestContext = {
      requestId: "request-1",
      prompt: "Review",
      configuredAgentId: "agent-1",
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "default" },
      invocation: {
        surface: "evaluation",
        role: "subject",
        ownerReference: { runId: "run-1", caseId: "case-1" },
      },
      runtime: {
        id: "codex",
        label: "Codex",
        command: "codex",
        version: "test",
        available: true,
      },
      channelId: "codex-default",
      workDir: "/workspace",
      reportExecutionReference,
    };
    const options: RuntimeWorkflowExecutionOptions = {
      executables: {
        api: "",
        codex: "codex",
        claude: "",
        dsh: "",
        opencode: "",
        openclaw: "",
        hermes: "",
      },
      channelById: () => undefined,
    };

    await expect(runCodexWorkflow(input, options)).rejects.toThrow("turn/start failed");
    expect(reportExecutionReference).toHaveBeenCalledWith({
      sessionId: "thread-created-before-turn",
    });
  });
});
