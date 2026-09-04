import { describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../shared/types";
import { buildInteractiveChatContext } from "./chat/agent-hub-interactive";
import type { AgentExecutionContext, AgentExecutorFactory } from "./runtime/executor/agent-executor";
import { runAgentExecution } from "./runtime/run/agent-hub-runner";
import { ChatState, TaskState } from "./state/agent-hub-state";

const runtime: AgentRuntime = {
  id: "codex",
  label: "Codex",
  command: "codex",
  version: "test",
  available: true,
};

describe("Agent Runtime invocation ownership", () => {
  it("keeps the configured Agent id on interactive chat invocations", () => {
    const chat = new ChatState("agent-1", "model-1");
    chat.id = "chat-1";

    const context = buildInteractiveChatContext({
      chat,
      resolved: {
        runtimeAgentId: "codex",
        modelId: "model-1",
        runtime,
        channel: { id: "codex-default" },
      },
      workDir: "/workspace",
      developerInstructions: "",
      selectExecutionMode: () => "interactive",
      defaultContinuationPolicy: () => "fresh",
      cloneConversationForPolicy: () => undefined,
      emit: () => undefined,
      syncState: () => undefined,
    });

    expect(context.invocation).toEqual({
      surface: "agent",
      role: "chat",
      ownerReference: { chatId: "chat-1", agentId: "agent-1" },
    });
  });

  it("keeps the configured Agent id on one-shot task invocations", async () => {
    const task = new TaskState("Run it", "agent-1", "model-1", "/workspace");
    task.id = "task-1";
    const create = vi.fn((_context: AgentExecutionContext) => ({
      start: async () => undefined,
      stop: async () => undefined,
    }));
    const executorFactory: AgentExecutorFactory = { create };

    await runAgentExecution({
      run: task,
      prompt: "Run it",
      resolved: {
        agent: {
          id: "agent-1",
          name: "Agent One",
          description: "",
          runtimeAgentId: "codex",
          modelId: "model-1",
          channelId: "codex-default",
          tags: [],
          createdAt: 1,
          updatedAt: 1,
        },
        runtimeAgentId: "codex",
        channel: { id: "codex-default" },
        modelId: "model-1",
        runtime,
      },
      workDir: "/workspace",
      chatDeveloperInstructions: "",
      taskDeveloperInstructions: "",
      executorFactory,
      selectExecutionMode: () => "oneshot",
      defaultContinuationPolicy: () => "fresh",
      cloneConversationForPolicy: () => undefined,
      handleAgentEvent: () => undefined,
      markRunExited: () => undefined,
      markRunFailed: () => undefined,
      registerStop: () => undefined,
      clearStop: () => undefined,
      emit: () => undefined,
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      invocation: {
        surface: "agent",
        role: "task",
        ownerReference: { taskId: "task-1", agentId: "agent-1" },
      },
    }));
  });
});
