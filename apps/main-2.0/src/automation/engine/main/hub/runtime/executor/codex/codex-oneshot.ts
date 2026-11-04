import type { AgentOneShotResponse } from "../../../../../shared/types";
import { runtimeModelId } from "../../../../../shared/models";
import { codexEnvironmentForChannel } from "../../../../agents/codex/codex-env";
import { CodexRpcClient } from "../../../../agents/codex/codex-rpc";
import { codexRuntimeStateCodec } from "../../../../agents/codex/codex-runtime-state-codec";
import type { RuntimeOneShotRequest } from "../../../../agents/runtime/runtime-driver";
import { codexAppServerConfigArgs } from "../../../../channels/model-config";
import {
  codexThreadIdFromConversation,
  cloneCodexRuntimeConversation,
} from "../agent-executor-conversation";
import {
  createOneShotAgentTimeout,
  emitOneShotAgentApprovalEvent,
  modelFromRuntimeConfig,
  type RuntimeOneShotExecutionOptions,
  ONE_SHOT_AGENT_IDLE_TIMEOUT_MS,
} from "../oneshot-shared";
import { reasoningEffortFromRuntimeConfig } from "../agent-executor-types";
import { respondToCodexRuntimeServerRequest } from "./codex-server-request";
import { codexMcpLaunchConfig } from "../runtime-mcp";
import { combineDeveloperInstructions } from "../runtime-instructions";

export async function runCodexOneShot(
  input: RuntimeOneShotRequest,
  options: RuntimeOneShotExecutionOptions,
): Promise<AgentOneShotResponse> {
  const executable = input.runtime.command || options.executables.codex;
  const channel = options.channelById(input.channelId);
  const model = runtimeModelId(modelFromRuntimeConfig(input.runtimeConfig));
  let settled = false;
  let content = "";
  let runtimeConversation = input.runtimeConversation ? cloneCodexRuntimeConversation(input.runtimeConversation) : undefined;
  let executionReference: AgentOneShotResponse["executionReference"];
  let timeout: ReturnType<typeof createOneShotAgentTimeout> | undefined;
  let client: CodexRpcClient | undefined;
  const mcp = codexMcpLaunchConfig(input.configuredAgentId
    ? options.mcpServersForAgent?.(input.configuredAgentId) ?? []
    : []);
  const developerInstructions = combineDeveloperInstructions(input.developerInstructions);

  return new Promise<AgentOneShotResponse>((resolve, reject) => {
    let abort: () => void;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      timeout?.clear();
      input.signal?.removeEventListener("abort", abort);
      void client?.shutdown();
      callback();
    };
    abort = () => settle(() => reject(input.signal?.reason instanceof Error ? input.signal.reason : new Error("Agent request interrupted.")));

    if (input.signal?.aborted) { abort(); return; }
    input.signal?.addEventListener("abort", abort, { once: true });

    timeout = createOneShotAgentTimeout({
      timeoutMs: ONE_SHOT_AGENT_IDLE_TIMEOUT_MS,
      onTimeout: () => settle(() => reject(new Error("Agent request timed out after 10 minutes without activity"))),
    });

    client = new CodexRpcClient({
      executable,
      cwd: input.workDir,
      extraArgs: [
        ...codexAppServerConfigArgs(
          channel,
          modelFromRuntimeConfig(input.runtimeConfig),
          reasoningEffortFromRuntimeConfig(input.runtimeConfig),
        ),
        ...mcp.args,
      ],
      env: { ...codexEnvironmentForChannel(channel), ...mcp.env },
      onEvent: (event) => {
        timeout?.refresh();
        if (event.type === "delta") {
          content += event.content;
          input.onEvent?.({ requestId: input.requestId, type: "delta", content: event.content });
          return;
        }
        if (event.type === "tool_call" || event.type === "tool_result") {
          input.onEvent?.({
            requestId: input.requestId,
            type: event.type,
            content: event.content,
            ...(event.name ? { name: event.name } : {}),
            ...(event.metadata ? { metadata: event.metadata } : {}),
          });
          return;
        }
        if (event.type === "completed") {
          if (!content && event.content) content = event.content;
          input.onEvent?.({
            requestId: input.requestId,
            type: "completed",
            content: content.trim(),
            ...(runtimeConversation ? { runtimeConversation } : {}),
          });
          settle(() => resolve({
            content: content.trim(),
            ...(runtimeConversation ? { runtimeConversation } : {}),
            ...(executionReference ? { executionReference } : {}),
          }));
          return;
        }
        if (event.type === "error") {
          input.onEvent?.({ requestId: input.requestId, type: "error", error: event.error });
          settle(() => reject(new Error(event.error)));
        }
      },
      onRequest: (id, method, params) => {
        if (client) {
          respondToCodexRuntimeServerRequest(client, id, method, params, options.requestApproval ? {
            ownerId: `oneshot:${input.requestId}`,
            emit: (event) => {
              timeout?.refresh();
              emitOneShotAgentApprovalEvent(input, event);
            },
            request: options.requestApproval,
            cwd: input.workDir,
            ...(input.signal ? { signal: input.signal } : {}),
          } : undefined);
        }
      },
      onExit: (_code, _signal, stderr) => {
        if (settled) return;
        settle(() => reject(new Error(stderr.trim() || "Codex agent exited before completing")));
      },
    });

    void (async () => {
      try {
        await client.start();
        const existingThreadId = codexThreadIdFromConversation(runtimeConversation);
        const threadResult = existingThreadId
          ? await client.request("thread/resume", {
              threadId: existingThreadId,
              model,
              modelProvider: null,
              cwd: input.workDir,
              approvalPolicy: "on-request",
              config: null,
              baseInstructions: null,
              developerInstructions,
            })
          : await client.request("thread/start", {
              model,
              modelProvider: null,
              profile: null,
              cwd: input.workDir,
              approvalPolicy: "on-request",
              config: null,
              baseInstructions: null,
              developerInstructions,
              compactPrompt: null,
              includeApplyPatchTool: null,
              experimentalRawEvents: true,
              persistExtendedHistory: true,
            });

        const threadId = (threadResult as { thread?: { id?: string } }).thread?.id ?? existingThreadId;
        if (threadId) {
          runtimeConversation = codexRuntimeStateCodec.encodeConversation({
            native: { threadId },
          });
          executionReference = { sessionId: threadId };
          input.reportExecutionReference?.(executionReference);
        }
        const turnResult = await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
        });
        const turnId = (turnResult as { turn?: { id?: string } }).turn?.id;
        executionReference = {
          ...(threadId ? { sessionId: threadId } : {}),
          ...(turnId ? { turnId } : {}),
        };
        input.reportExecutionReference?.(executionReference);
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    })();
  });
}
