import type { AppSnapshot } from "../../../shared/types";
import type { WorkflowOperationResult } from "../../../shared/workflow/commands";
import type { WorkflowV2ConversationManager } from "../../workflows/v2/workflow-v2-conversation-manager";

export class WorkflowNodeConversationService {
  constructor(private readonly deps: {
    conversations: WorkflowV2ConversationManager;
    snapshot: () => AppSnapshot;
    completeInteractiveNode: (input: {
      workflowId: string;
      runId: string;
      nodeId: string;
      output: Parameters<WorkflowV2ConversationManager["proposeCompletion"]>[1]["output"];
    }) => Promise<WorkflowOperationResult>;
  }) {}

  async sendMessage(conversationId: string, message: string): Promise<AppSnapshot> {
    await this.deps.conversations.sendUserMessage(conversationId, message);
    return this.deps.snapshot();
  }

  async confirmCompletion(conversationId: string): Promise<WorkflowOperationResult> {
    return this.completeProposed(conversationId);
  }

  async completeProposed(conversationId: string): Promise<WorkflowOperationResult> {
    const conversation = this.deps.conversations.get(conversationId);
    if (!conversation) return { ok: false, error: "Workflow node conversation was not found." };
    if (!conversation.completionProposal || conversation.status !== "completion_proposed") {
      return {
        ok: false,
        workflowId: conversation.workflowId,
        runId: conversation.runId,
        error: "The node agent has not proposed a complete output yet.",
      };
    }
    let completionStarted = false;
    try {
      const proposal = this.deps.conversations.beginCompletion(conversationId);
      completionStarted = true;
      const result = await this.deps.completeInteractiveNode({
        workflowId: conversation.workflowId,
        runId: conversation.runId,
        nodeId: conversation.nodeId,
        output: proposal.output,
      });
      if (result.ok) await this.deps.conversations.closeCompleted(conversationId);
      else this.deps.conversations.releaseCompletion(conversationId);
      return result;
    } catch (error) {
      if (completionStarted) this.deps.conversations.releaseCompletion(conversationId);
      return {
        ok: false,
        workflowId: conversation.workflowId,
        runId: conversation.runId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async rejectCompletion(conversationId: string, instruction: string): Promise<AppSnapshot> {
    await this.deps.conversations.rejectCompletion(conversationId, instruction);
    return this.deps.snapshot();
  }

  async interrupt(conversationId: string): Promise<AppSnapshot> {
    await this.deps.conversations.interrupt(conversationId);
    return this.deps.snapshot();
  }
}
