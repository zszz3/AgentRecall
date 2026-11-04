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
    runId: "run-1",
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
    invocation: overrides.invocation ?? { surface: "agent", role: "task" },
  };
}

const options: RuntimeAgentExecutorFactoryOptions = {
  executables: { api: "", codex: "codex", claude: "", dsh: "", opencode: "", openclaw: "", hermes: "" },
  channelById: () => ({ id: "codex-channel", agentId: "codex", label: "Codex", models: [{ id: "default", label: "Default" }] }),
};

describe("CodexAgentExecutor approval policy", () => {
  beforeEach(() => rpc.request.mockClear());

  test("keeps one-shot runs non-interactive", async () => {
    await new CodexAgentExecutor(context(), options).start();

    expect(rpc.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ approvalPolicy: "never" }));
  });
});
