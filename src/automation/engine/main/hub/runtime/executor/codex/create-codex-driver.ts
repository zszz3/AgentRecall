import { codexEnvironmentForChannel } from "../../../../agents/codex/codex-env";
import { CodexInteractiveSession } from "../../../../agents/codex/codex-interactive-session";
import { CodexRpcClient } from "../../../../agents/codex/codex-rpc";
import type { RuntimeDriver } from "../../../../agents/runtime/runtime-driver";
import { codexRuntimeStateCodec } from "../../../../agents/codex/codex-runtime-state-codec";
import { codexAppServerConfigArgs } from "../../../../channels/model-config";
import { createInteractiveRuntimeDriver } from "../agent-executor-driver-factories";
import {
  modelFromRuntimeConfig,
  reasoningEffortFromRuntimeConfig,
  type RuntimeAgentExecutorFactoryOptions,
} from "../agent-executor-types";
import {
  codexInteractiveSessionCapabilities,
  codexSurfaceSupport,
  getCodexCapabilities,
} from "./codex-capabilities";
import { deleteCodexSessionArtifacts } from "./codex-cleanup";
import { CodexAgentExecutor } from "./codex-executor";
import { respondToCodexRuntimeServerRequest } from "./codex-server-request";
import { runCodexChannelTest } from "./codex-test";
import { runCodexWorkflow } from "./codex-workflow";
import { codexWorkflowMcpArgs } from "./codex-workflow-mcp";
import { codexMcpLaunchConfig } from "../runtime-mcp";

export function createCodexDriver(options: RuntimeAgentExecutorFactoryOptions): RuntimeDriver {
  const askWorkflowByRuntime = options.askWorkflowByRuntime ?? {};
  const testChannelByRuntime = options.testChannelByRuntime ?? {};
  const deleteSessionArtifactsByRuntime = options.deleteSessionArtifactsByRuntime ?? {};

  return createInteractiveRuntimeDriver({
    runtimeId: "codex",
    surfaceSupport: [...codexSurfaceSupport],
    getCapabilities: getCodexCapabilities,
    runtimeStateCodec: codexRuntimeStateCodec,
    createOneShotExecutor: (context) => new CodexAgentExecutor(context, options),
    createInteractiveSession: (context) =>
      new CodexInteractiveSession(context, {
        capabilities: codexInteractiveSessionCapabilities,
        createCodexClient: ({ context: sessionContext, onEvent, onExit }) => {
          const channel = options.channelById(sessionContext.channelId);
          const mcp = codexMcpLaunchConfig(options.mcpServersForAgent?.(sessionContext.configuredAgentId) ?? []);
          let client: CodexRpcClient;
          client = new CodexRpcClient({
            executable: sessionContext.runtime.command || options.executables.codex,
            cwd: sessionContext.workDir,
            extraArgs: [
              ...codexAppServerConfigArgs(
                channel,
                modelFromRuntimeConfig(sessionContext.runtimeConfig),
                reasoningEffortFromRuntimeConfig(sessionContext.runtimeConfig),
              ),
              ...codexWorkflowMcpArgs(options.workflowMcpDiscoveryPath?.(), sessionContext.planningWorkflowId, sessionContext.workflowRunId, sessionContext.workflowNodeId),
              ...mcp.args,
            ],
            env: { ...codexEnvironmentForChannel(channel), ...mcp.env },
            onEvent,
            onRequest: (id, method, params) => {
              respondToCodexRuntimeServerRequest(client, id, method, params, options.requestApproval ? {
                ownerId: sessionContext.chatId,
                emit: onEvent,
                request: options.requestApproval,
                cwd: sessionContext.workDir,
              } : undefined);
            },
            onExit,
          });
          return client;
        },
      }),
    askWorkflow: askWorkflowByRuntime.codex ?? ((input) => runCodexWorkflow(input, options)),
    testChannel: testChannelByRuntime.codex ?? ((input) => runCodexChannelTest(input, options)),
    deleteSessionArtifacts:
      deleteSessionArtifactsByRuntime.codex ??
      ((input) => deleteCodexSessionArtifacts(options.executables.codex, input)),
  });
}
