import {
  query,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "../../../shared/types";
import type { RuntimeApprovalRequester } from "../../approvals/runtime-approval-broker";
import { createClaudeSdkQueryOptions } from "./claude-agent-sdk";
import { createClaudeStreamState, normalizeClaudeStreamEvent } from "./claude-stream";
import type { WorkflowMcpScope } from "../../../shared/workflow-mcp-policy";

interface ClaudeAgentSdkInteractiveAttachInput {
  cwd: string;
  modelId?: string;
  developerInstructions?: string;
  resumeSessionId?: string;
  mcpServers?: Parameters<typeof createClaudeSdkQueryOptions>[0]["mcpServers"];
  onEvent: (event: AgentEvent) => void;
  env?: NodeJS.ProcessEnv;
  approvalOwnerId?: string;
  requestApproval?: RuntimeApprovalRequester;
  workflowMcpScope?: WorkflowMcpScope;
}

export class ClaudeAgentSdkInteractive {
  private activeQuery: Query | undefined;
  private activeInput: AsyncPushQueue<SDKUserMessage> | undefined;
  private attachmentGeneration = 0;

  constructor(
    private readonly options: {
      queryImpl?: typeof query;
    } = {},
  ) {}

  isAttached(): boolean {
    return this.activeQuery !== undefined;
  }

  async attach(input: ClaudeAgentSdkInteractiveAttachInput): Promise<void> {
    if (this.activeQuery) {
      throw new Error("ClaudeAgentSdkInteractive is already attached.");
    }

    const queryImpl = this.options.queryImpl ?? query;
    const messageQueue = new AsyncPushQueue<SDKUserMessage>();
    const activeQuery = queryImpl({
      prompt: messageQueue,
      options: createClaudeSdkQueryOptions({
        cwd: input.cwd,
        onEvent: input.onEvent,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.approvalOwnerId ? { approvalOwnerId: input.approvalOwnerId } : {}),
        ...(input.requestApproval ? { requestApproval: input.requestApproval } : {}),
        ...(input.workflowMcpScope ? { workflowMcpScope: input.workflowMcpScope } : {}),
      }),
    });

    this.activeQuery = activeQuery;
    this.activeInput = messageQueue;
    const generation = ++this.attachmentGeneration;
    void this.consumeQuery(activeQuery, generation, input.onEvent);
  }

  async sendUserMessage(content: string): Promise<void> {
    if (!this.activeInput) {
      throw new Error("ClaudeAgentSdkInteractive is not attached.");
    }

    await this.activeInput.push({
      type: "user",
      message: {
        role: "user",
        content,
      },
      parent_tool_use_id: null,
    });
  }

  async interrupt(): Promise<void> {
    await this.activeQuery?.interrupt();
  }

  async detach(): Promise<void> {
    this.activeInput?.close();
    this.activeInput = undefined;
    this.activeQuery?.close();
    this.activeQuery = undefined;
  }

  private async consumeQuery(
    activeQuery: Query,
    generation: number,
    onEvent: (event: AgentEvent) => void,
  ): Promise<void> {
    const state = createClaudeStreamState();

    try {
      for await (const message of activeQuery) {
        for (const event of normalizeClaudeStreamEvent(message, state)) {
          onEvent(event);
          if (event.type === "completed" || event.type === "error") {
            state.lastText = "";
          }
        }
      }
    } catch (error) {
      if (this.attachmentGeneration !== generation || this.activeQuery !== activeQuery) {
        return;
      }
      onEvent({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.attachmentGeneration === generation && this.activeQuery === activeQuery) {
        this.activeInput = undefined;
        this.activeQuery = undefined;
      }
    }
  }
}

class AsyncPushQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  async push(item: T): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot push to a closed queue.");
    }

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
      return;
    }

    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}
