import { ClaudeAgentSdkAdapter } from "../../../../agents/claude/claude-agent-sdk";
import { claudeSessionIdFromConversation } from "../agent-executor-conversation";
import type { AgentExecutionContext, AgentExecutor } from "../agent-executor-types";
import type { RuntimeApprovalRequester } from "../../../../approvals/runtime-approval-broker";
import type { ClaudeAgentSdkRunInput } from "../../../../agents/claude/claude-agent-sdk";
import { workflowMcpScopeForContext } from "../../../../../shared/workflow-mcp-policy";

export class ClaudeAgentExecutor implements AgentExecutor {
  private abortController: AbortController | undefined;

  constructor(
    private readonly context: AgentExecutionContext,
    private readonly adapter: Pick<ClaudeAgentSdkAdapter, "runOneShot">,
    private readonly resolvedModelId: string | undefined,
    private readonly requestApproval?: RuntimeApprovalRequester,
    private readonly mcpServers?: ClaudeAgentSdkRunInput["mcpServers"],
  ) {}

  async start(): Promise<void> {
    const abortController = new AbortController();
    this.abortController = abortController;
    const resumeSessionId = claudeSessionIdFromConversation(this.context.runtimeConversation);

    try {
      await this.adapter.runOneShot({
        prompt: this.context.prompt,
        cwd: this.context.workDir,
        developerInstructions: this.context.developerInstructions,
        onEvent: this.context.emit,
        abortController,
        approvalOwnerId: this.context.runId,
        ...(workflowMcpScopeForContext(this.context) ? { workflowMcpScope: workflowMcpScopeForContext(this.context) } : {}),
        ...(this.requestApproval ? { requestApproval: this.requestApproval } : {}),
        ...(this.resolvedModelId ? { modelId: this.resolvedModelId } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(this.mcpServers ? { mcpServers: this.mcpServers } : {}),
      });
      this.context.onExit(0);
    } catch (error) {
      if (abortController.signal.aborted) {
        this.context.onExit(null);
        return;
      }
      this.context.emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
      this.context.onExit(1);
    } finally {
      this.abortController = undefined;
    }
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    this.abortController = undefined;
  }
}
