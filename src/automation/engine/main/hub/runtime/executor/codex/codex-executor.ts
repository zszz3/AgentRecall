import { runtimeModelId } from "../../../../../shared/models";
import { codexEnvironmentForChannel } from "../../../../agents/codex/codex-env";
import { CodexRpcClient } from "../../../../agents/codex/codex-rpc";
import { codexRuntimeStateCodec } from "../../../../agents/codex/codex-runtime-state-codec";
import { codexAppServerConfigArgs } from "../../../../channels/model-config";
import { codexThreadIdFromConversation } from "../agent-executor-conversation";
import type {
  AgentExecutionContext,
  AgentExecutor,
  RuntimeAgentExecutorFactoryOptions,
} from "../agent-executor-types";
import { modelFromRuntimeConfig, reasoningEffortFromRuntimeConfig } from "../agent-executor-types";
import { respondToCodexRuntimeServerRequest } from "./codex-server-request";

export class CodexAgentExecutor implements AgentExecutor {
  private client: CodexRpcClient | undefined;

  constructor(
    private readonly context: AgentExecutionContext,
    private readonly options: RuntimeAgentExecutorFactoryOptions,
  ) {}

  async start(): Promise<void> {
    const executable = this.context.runtime.command || this.options.executables.codex;
    const model = runtimeModelId(modelFromRuntimeConfig(this.context.runtimeConfig));
    const channel = this.options.channelById(this.context.channelId);
    const threadIdFromConversation = codexThreadIdFromConversation(this.context.runtimeConversation);
    let client: CodexRpcClient;
    client = new CodexRpcClient({
      executable,
      cwd: this.context.workDir,
      extraArgs: codexAppServerConfigArgs(
        channel,
        modelFromRuntimeConfig(this.context.runtimeConfig),
        reasoningEffortFromRuntimeConfig(this.context.runtimeConfig),
      ),
      env: codexEnvironmentForChannel(channel),
      onEvent: this.context.emit,
      onRequest: (id, method, params) => {
        respondToCodexRuntimeServerRequest(client, id, method, params, this.options.requestApproval ? {
          ownerId: this.context.runId,
          emit: this.context.emit,
          request: this.options.requestApproval,
          cwd: this.context.workDir,
        } : undefined);
      },
      onExit: (code) => {
        this.context.onExit(code);
      },
    });
    this.client = client;

    await client.start();
    const threadResult = threadIdFromConversation
      ? await client.request("thread/resume", {
          threadId: threadIdFromConversation,
          model,
          modelProvider: null,
          cwd: this.context.workDir,
          approvalPolicy: "never",
          config: null,
          baseInstructions: null,
          developerInstructions: this.context.developerInstructions,
        })
      : await client.request("thread/start", {
          model,
          modelProvider: null,
          profile: null,
          cwd: this.context.workDir,
          approvalPolicy: "never",
          config: null,
          baseInstructions: null,
          developerInstructions: this.context.developerInstructions,
          compactPrompt: null,
          includeApplyPatchTool: null,
          experimentalRawEvents: true,
          persistExtendedHistory: true,
        });

    const threadId = (threadResult as { thread?: { id?: string } }).thread?.id;
    if (threadId) {
      this.context.emit({
        type: "runtime_conversation",
        runtimeConversation: codexRuntimeStateCodec.encodeConversation({
          native: { threadId },
        }),
      });
    }

    await client.request("turn/start", {
      threadId: threadId ?? threadIdFromConversation,
      input: [{ type: "text", text: this.context.prompt, text_elements: [] }],
    });
  }

  async stop(): Promise<void> {
    await this.client?.shutdown();
    this.client = undefined;
  }
}
