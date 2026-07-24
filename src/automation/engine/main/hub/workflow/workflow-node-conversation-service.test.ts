import { describe, expect, test, vi } from "vitest";
import type { WorkflowV2ConversationManager } from "../../workflows/v2/workflow-v2-conversation-manager";
import { WorkflowNodeConversationService } from "./workflow-node-conversation-service";

describe("WorkflowNodeConversationService", () => {
  test("automatically persists a proposed interactive output and closes the conversation", async () => {
    const output = { nodeId: "answer", summary: "Done", outputs: { answer_markdown: "Final answer" }, proposals: [] };
    const closeCompleted = vi.fn(async () => undefined);
    const conversations = {
      get: () => ({ conversationId: "c", workflowId: "w", runId: "r", nodeId: "answer", status: "completion_proposed", completionProposal: { submissionId: "submission-1", output } }),
      beginCompletion: () => ({ submissionId: "submission-1", output }),
      closeCompleted,
      releaseCompletion: vi.fn(),
    } as unknown as WorkflowV2ConversationManager;
    const completeInteractiveNode = vi.fn(async () => ({ ok: true, workflowId: "w", runId: "r" }));
    const service = new WorkflowNodeConversationService({
      conversations,
      snapshot: () => ({}) as never,
      completeInteractiveNode,
      nodeExecutionId: () => "execution-1",
      rejectNodeCompletion: vi.fn(async () => undefined),
    });

    const result = await service.completeProposed("c");

    expect(result.ok).toBe(true);
    expect(completeInteractiveNode).toHaveBeenCalledWith({ workflowId: "w", runId: "r", nodeId: "answer", executionId: "execution-1", submissionId: "submission-1", output });
    expect(closeCompleted).toHaveBeenCalledWith("c");
  });

  test("rejects the durable submission before continuing an interactive conversation", async () => {
    const output = { nodeId: "answer", summary: "Done", outputs: { answer_markdown: "Draft" }, proposals: [] };
    const rejectCompletion = vi.fn(async () => undefined);
    const conversations = {
      get: () => ({ conversationId: "c", workflowId: "w", runId: "r", nodeId: "answer", status: "completion_proposed", completionProposal: { submissionId: "submission-1", output } }),
      rejectCompletion,
    } as unknown as WorkflowV2ConversationManager;
    const rejectNodeCompletion = vi.fn(async () => undefined);
    const service = new WorkflowNodeConversationService({
      conversations,
      snapshot: () => ({}) as never,
      completeInteractiveNode: vi.fn(),
      nodeExecutionId: () => "execution-1",
      rejectNodeCompletion,
    });

    await service.rejectCompletion("c", "Revise the answer");

    expect(rejectNodeCompletion).toHaveBeenCalledWith({
      workflowId: "w",
      runId: "r",
      nodeId: "answer",
      executionId: "execution-1",
      submissionId: "submission-1",
      reason: "Revise the answer",
    });
    expect(rejectCompletion).toHaveBeenCalledWith("c", "Revise the answer");
  });
});
