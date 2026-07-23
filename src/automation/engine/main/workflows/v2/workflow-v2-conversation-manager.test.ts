import { describe, expect, test, vi } from "vitest";
import type { AgentEvent, RuntimeConversation } from "../../../shared/types";
import { workflowNodeConversationId } from "../../../shared/workflow-v2/conversation";
import { WorkflowV2ConversationManager } from "./workflow-v2-conversation-manager";

function output() {
  return { nodeId: "collect", summary: "Requirements collected", outputs: { requirements: ["a", "b"] }, evidence: ["user confirmed"], proposals: [] };
}

describe("WorkflowV2ConversationManager", () => {
  test("marks streaming deltas for coalesced publication while keeping terminal events immediate", async () => {
    let emit!: (event: AgentEvent) => void;
    const deliveries: Array<"stream" | "immediate" | undefined> = [];
    const manager = new WorkflowV2ConversationManager({
      now: () => 1,
      createSession: (input) => {
        emit = input.emit;
        return { sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => undefined, runtimeConversation: () => undefined };
      },
      onChanged: (delivery) => deliveries.push(delivery),
    });
    await manager.start({ workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Start" });
    deliveries.length = 0;

    emit({ type: "delta", content: "one" });
    emit({ type: "delta", content: " two" });
    emit({ type: "tool_result", name: "read", content: "done" });

    expect(deliveries).toEqual(["stream", "stream", "immediate"]);
  });

  test("publishes the conversation before the initial agent turn finishes", async () => {
    let release!: () => void;
    const initialTurn = new Promise<void>((resolve) => { release = resolve; });
    const manager = new WorkflowV2ConversationManager({
      now: () => 5,
      createSession: () => ({
        sendPrompt: () => initialTurn,
        interrupt: async () => undefined,
        close: async () => undefined,
        runtimeConversation: () => undefined,
      }),
    });

    const started = await manager.start({ workflowId: "w", runId: "r", nodeId: "interactive", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Collect requirements" });

    expect(started).toMatchObject({ status: "active", nodeId: "interactive" });
    expect(manager.get(started.conversationId)?.messages).toEqual([expect.objectContaining({ role: "system", content: "Collect requirements" })]);
    release();
  });
  test("preserves tool names so the node window can distinguish calls from results", async () => {
    let emit!: (event: AgentEvent) => void;
    const manager = new WorkflowV2ConversationManager({
      now: () => 8,
      createSession: (input) => {
        emit = input.emit;
        return { sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => undefined, runtimeConversation: () => undefined };
      },
    });
    const started = await manager.start({ workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Inspect files" });
    emit({ type: "tool_call", name: "shell_command", content: "Get-ChildItem" });
    emit({ type: "tool_result", name: "shell_command", content: "package.json" });
    expect(manager.get(started.conversationId)?.messages.slice(-2)).toEqual([
      expect.objectContaining({ role: "tool", eventType: "tool_call", name: "shell_command" }),
      expect.objectContaining({ role: "tool", eventType: "tool_result", name: "shell_command" }),
    ]);
  });

  test("aggregates interactive usage and preserves it when the conversation is restored", async () => {
    let emit!: (event: AgentEvent) => void;
    const manager = new WorkflowV2ConversationManager({
      now: () => 100,
      createSession: (input) => {
        emit = input.emit;
        return { sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => undefined, runtimeConversation: () => undefined };
      },
    });
    const started = await manager.start({
      workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Start",
      provider: "anthropic", runtimeId: "claude", channelId: "channel-1",
    });
    emit({ type: "usage", usage: { provider: "anthropic", inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 10 } });
    emit({ type: "usage", usage: { provider: "anthropic", inputTokens: 50, outputTokens: 5, cacheWrite5mInputTokens: 30 } });

    expect(manager.get(started.conversationId)?.telemetry).toMatchObject({
      provider: "anthropic", runtimeId: "claude", channelId: "channel-1", inputTokens: 150, outputTokens: 25,
      cacheReadInputTokens: 10, cacheWrite5mInputTokens: 30,
    });

    const restored = new WorkflowV2ConversationManager({ now: () => 100, createSession: () => ({ sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => undefined, runtimeConversation: () => undefined }) });
    restored.restore([manager.get(started.conversationId)]);
    expect(restored.get(started.conversationId)?.telemetry).toMatchObject({ inputTokens: 150, outputTokens: 25, cacheWrite5mInputTokens: 30 });
  });
  test("preserves live approval identity and resolves it after the runtime responds", async () => {
    let emit!: (event: AgentEvent) => void;
    const manager = new WorkflowV2ConversationManager({
      now: () => 9,
      createSession: (input) => {
        emit = input.emit;
        return { sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => undefined, runtimeConversation: () => undefined };
      },
    });
    const started = await manager.start({ workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Run tools" });
    emit({ type: "approval_request", requestId: "approval-1", content: "Allow command?", metadata: { command: "npm test" } });
    expect(manager.get(started.conversationId)?.messages.at(-1)?.event).toMatchObject({ type: "approval_request", requestId: "approval-1", requestState: "live", metadata: { command: "npm test" } });
    emit({ type: "approval_response", requestId: "approval-1", decision: "approved", content: "Approved" });
    expect(manager.get(started.conversationId)?.messages.find((message) => message.event?.requestId === "approval-1")?.event?.requestState).toBe("resolved");
  });
  test("expires restored approval requests because the in-memory broker no longer owns them", () => {
    const manager = new WorkflowV2ConversationManager({ now: () => 10, createSession: () => ({ sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => undefined, runtimeConversation: () => undefined }) });
    manager.restore([{ conversationId: "w::r::n", workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "active", messages: [{ id: "m1", role: "assistant", content: "Approve?", at: 1, event: { id: "e1", type: "approval_request", content: "Approve?", timestamp: 1, requestId: "approval-1", requestState: "live" } }], createdAt: 1, updatedAt: 1, lastActivityAt: 1 }]);
    expect(manager.get("w::r::n")?.messages[0]?.event?.requestState).toBe("expired");
  });
  test("drops malformed persisted messages before exposing a restored conversation", () => {
    const manager = new WorkflowV2ConversationManager({ now: () => 10, createSession: () => ({ sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => undefined, runtimeConversation: () => undefined }) });
    manager.restore([{
      conversationId: "w::r::n", workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "closed",
      messages: [
        { id: "valid", role: "assistant", content: "Done", at: 1 },
        { id: "missing-content", role: "assistant", at: 2 },
      ],
      createdAt: 1, updatedAt: 2, lastActivityAt: 2,
    }] as never);

    expect(manager.get("w::r::n")?.messages).toEqual([
      expect.objectContaining({ id: "valid", content: "Done" }),
    ]);
  });
  test("downgrades a malformed persisted completion proposal to user input", () => {
    const manager = new WorkflowV2ConversationManager({ now: () => 10, createSession: () => ({ sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => undefined, runtimeConversation: () => undefined }) });
    manager.restore([{
      conversationId: "w::r::n", workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "completion_proposed",
      messages: [], completionProposal: { output: {}, unresolvedRisks: "unknown" }, createdAt: 1, updatedAt: 2, lastActivityAt: 2,
    }] as never);

    expect(manager.get("w::r::n")?.status).toBe("waiting_for_user");
    expect(manager.get("w::r::n")?.completionProposal).toBeUndefined();
  });
  test("reuses one interactive session across multiple user turns and requires confirmation", async () => {
    let now = 10;
    let createCount = 0;
    const prompts: string[] = [];
    let emit!: (event: AgentEvent) => void;
    const runtimeConversation: RuntimeConversation = { runtimeId: "codex", codecVersion: "1", payload: { threadId: "thread-1" } };
    const manager = new WorkflowV2ConversationManager({
      now: () => now++,
      createSession: (input) => {
        createCount += 1;
        emit = input.emit;
        return {
          sendPrompt: async (prompt) => { prompts.push(prompt); },
          interrupt: async () => undefined,
          close: async () => undefined,
          runtimeConversation: () => runtimeConversation,
        };
      },
    });

    const started = await manager.start({
      workflowId: "workflow-1",
      runId: "run-1",
      nodeId: "collect",
      configuredAgentId: "agent-1",
      modelId: "model-1",
      workDir: "C:/workspace",
      initialPrompt: "Collect deployment requirements.",
    });
    emit({ type: "delta", content: "Which regions should be supported?" });
    const waiting = manager.markWaitingForUser(started.conversationId, "Which regions should be supported?");
    expect(waiting.messages.filter((message) => message.content === "Which regions should be supported?")).toHaveLength(1);
    const replied = await manager.sendUserMessage(started.conversationId, "US and EU.");
    const proposed = manager.proposeCompletion(started.conversationId, {
      output: output(),
      acceptanceCriteria: [{ key: "regions", satisfied: true, evidence: "US and EU" }],
      unresolvedRisks: [],
    });

    expect(createCount).toBe(1);
    expect(prompts).toEqual(["Collect deployment requirements.", "US and EU."]);
    expect(waiting.status).toBe("waiting_for_user");
    expect(replied.runtimeConversation).toEqual(runtimeConversation);
    expect(proposed.status).toBe("completion_proposed");
    expect(manager.get(started.conversationId)?.status).not.toBe("closed");

    const confirmed = manager.completionProposal(started.conversationId);
    expect(confirmed.output).toEqual(output());
    expect(manager.get(started.conversationId)?.status).toBe("completion_proposed");
    await manager.closeCompleted(started.conversationId);
    expect(manager.get(started.conversationId)?.status).toBe("closed");
    expect(started.conversationId).toBe(workflowNodeConversationId("workflow-1", "run-1", "collect"));
  });

  test("keeps the conversation open until downstream persistence succeeds", async () => {
    const manager = new WorkflowV2ConversationManager({ now: () => 1, createSession: () => ({ sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => undefined, runtimeConversation: () => undefined }) });
    const started = await manager.start({ workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Work" });
    expect(() => manager.completionProposal(started.conversationId)).toThrow(/no completion proposal/i);
    expect(manager.get(started.conversationId)?.status).toBe("active");
  });

  test("serializes completion confirmation and releases the interactive session", async () => {
    let closed = 0;
    const manager = new WorkflowV2ConversationManager({ now: () => 1, createSession: () => ({ sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => { closed += 1; }, runtimeConversation: () => undefined }) });
    const started = await manager.start({ workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Work" });
    manager.proposeCompletion(started.conversationId, { output: output(), acceptanceCriteria: [], unresolvedRisks: [] });
    manager.beginCompletion(started.conversationId);
    expect(() => manager.beginCompletion(started.conversationId)).toThrow(/already being confirmed/i);
    await manager.closeCompleted(started.conversationId);
    expect(closed).toBe(1);
  });

  test("does not accept a new user message while completion is being confirmed", async () => {
    const manager = new WorkflowV2ConversationManager({ now: () => 1, createSession: () => ({ sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => undefined, runtimeConversation: () => undefined }) });
    const started = await manager.start({ workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Work" });
    manager.proposeCompletion(started.conversationId, { output: output(), acceptanceCriteria: [], unresolvedRisks: [] });
    manager.beginCompletion(started.conversationId);
    await expect(manager.sendUserMessage(started.conversationId, "Actually change this.")).rejects.toThrow(/being confirmed/i);
  });

  test("ignores late agent events after a completed conversation is closed", async () => {
    let emit!: (event: AgentEvent) => void;
    const manager = new WorkflowV2ConversationManager({ now: () => 1, createSession: (input) => { emit = input.emit; return { sendPrompt: async () => undefined, interrupt: async () => undefined, close: async () => undefined, runtimeConversation: () => undefined }; } });
    const started = await manager.start({ workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Work" });
    manager.proposeCompletion(started.conversationId, { output: output(), acceptanceCriteria: [], unresolvedRisks: [] });
    manager.beginCompletion(started.conversationId);
    await manager.closeCompleted(started.conversationId);
    emit({ type: "completed", content: "late result" });
    expect(manager.get(started.conversationId)?.status).toBe("closed");
  });

  test("rejects a completion proposal by continuing the same conversation", async () => {
    let createdSession: object | undefined;
    const prompts: string[] = [];
    const manager = new WorkflowV2ConversationManager({
      now: () => 20,
      createSession: () => {
        const session = {
          sendPrompt: async (prompt: string) => { prompts.push(prompt); },
          interrupt: async () => undefined,
          close: async () => undefined,
          runtimeConversation: () => undefined,
        };
        createdSession = session;
        return session;
      },
    });
    const started = await manager.start({ workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Start" });
    manager.proposeCompletion(started.conversationId, { output: output(), acceptanceCriteria: [], unresolvedRisks: [] });

    const rejected = await manager.rejectCompletion(started.conversationId, "Also collect the budget.");

    expect(createdSession).toBeDefined();
    expect(prompts).toEqual(["Start", "Also collect the budget."]);
    expect(rejected.status).toBe("active");
    expect(rejected.completionProposal).toBeUndefined();
  });
  test("stopping a run interrupts and closes every active node session", async () => {
    const calls: string[] = [];
    const manager = new WorkflowV2ConversationManager({
      now: () => 30,
      createSession: ({ nodeId }) => ({
        sendPrompt: async () => undefined,
        interrupt: async () => { calls.push(`${nodeId}:interrupt`); },
        close: async () => { calls.push(`${nodeId}:close`); },
        runtimeConversation: () => undefined,
      }),
    });
    const first = await manager.start({ workflowId: "w", runId: "r", nodeId: "first", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Start" });
    const second = await manager.start({ workflowId: "w", runId: "r", nodeId: "second", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Start" });

    await manager.stopRun("w", "r");

    expect(calls).toEqual(expect.arrayContaining(["first:interrupt", "first:close", "second:interrupt", "second:close"]));
    expect(manager.get(first.conversationId)).toMatchObject({ status: "closed" });
    expect(manager.get(second.conversationId)).toMatchObject({ status: "closed" });
    expect(manager.get(first.conversationId)?.messages.at(-1)?.content).toBe("Workflow run stopped by user.");
  });

  test("releases a runtime session when the initial prompt fails", async () => {
    const close = vi.fn(async () => undefined);
    const manager = new WorkflowV2ConversationManager({
      now: () => 40,
      createSession: () => ({
        sendPrompt: async () => { throw new Error("missing thread"); },
        interrupt: async () => undefined,
        close,
        runtimeConversation: () => undefined,
      }),
    });
    const started = await manager.start({ workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", initialPrompt: "Start" });
    await vi.waitFor(() => expect(manager.get(started.conversationId)?.status).toBe("failed"));
    expect(close).toHaveBeenCalledTimes(1);
    await expect(manager.interrupt(started.conversationId)).resolves.toBeUndefined();
  });

  test("does not create a new runtime session only to interrupt a restored conversation", async () => {
    const createSession = vi.fn(() => ({
      sendPrompt: async () => undefined,
      interrupt: async () => undefined,
      close: async () => undefined,
      runtimeConversation: () => undefined,
    }));
    const manager = new WorkflowV2ConversationManager({ now: () => 45, createSession });
    manager.restore([{
      conversationId: "w::r::n", workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "waiting_for_user",
      messages: [], createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    }]);
    await expect(manager.interrupt("w::r::n")).resolves.toBeUndefined();
    expect(createSession).not.toHaveBeenCalled();
  });
  test("restores a conversation snapshot and lazily recreates its runtime session", async () => {
    const prompts: string[] = [];
    const manager = new WorkflowV2ConversationManager({
      now: () => 50,
      createSession: (input) => ({
        sendPrompt: async (prompt) => { prompts.push(prompt); },
        interrupt: async () => undefined,
        close: async () => undefined,
        runtimeConversation: () => undefined,
      }),
    });
    manager.restore([{
      conversationId: "w::r::n", workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "waiting_for_user",
      messages: [{ id: "w::r::n:1", role: "system", content: "Collect requirements", at: 1 }], createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    }]);
    const restored = manager.get("w::r::n");
    expect(restored?.status).toBe("waiting_for_user");
    await manager.sendUserMessage("w::r::n", "US and EU");
    expect(prompts).toEqual(["US and EU"]);
  });});
