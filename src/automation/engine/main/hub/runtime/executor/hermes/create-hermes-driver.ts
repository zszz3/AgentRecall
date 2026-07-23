import { AcpInteractiveClient } from "../../../../agents/acp/acp-interactive-client";
import type { RuntimeDriver } from "../../../../agents/runtime/runtime-driver";
import { hermesRuntimeStateCodec } from "../../../../agents/hermes/hermes-runtime-state-codec";
import { createInteractiveRuntimeDriver } from "../agent-executor-driver-factories";
import type { RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import {
  getHermesCapabilities,
  hermesInteractiveSessionCapabilities,
  hermesSurfaceSupport,
} from "./hermes-capabilities";
import { deleteHermesSessionArtifacts } from "./hermes-cleanup";
import { HermesAgentExecutor } from "./hermes-executor";
import { HermesInteractiveSession } from "./hermes-session";
import { runHermesChannelTest, runHermesWorkflow } from "./hermes-workflow";
import { acpMcpServers, acpWorkflowMcpServers } from "../runtime-mcp";
import { AcpWorkflowOneShotExecutor } from "../acp-workflow-one-shot-executor";

export function createHermesDriver(options: RuntimeAgentExecutorFactoryOptions): RuntimeDriver {
  const deleteSessionArtifactsByRuntime = options.deleteSessionArtifactsByRuntime ?? {};
  return createInteractiveRuntimeDriver({
    runtimeId: "hermes",
    surfaceSupport: [...hermesSurfaceSupport],
    getCapabilities: getHermesCapabilities,
    runtimeStateCodec: hermesRuntimeStateCodec,
    createOneShotExecutor: (context) => context.planningWorkflowId && context.workflowRunId && context.workflowNodeId
      ? new AcpWorkflowOneShotExecutor(context, {
          executable: context.runtime.command || options.executables.hermes,
          args: ["acp"],
          modelId: context.runtimeConfig.model,
          mcpServers: [
            ...acpMcpServers(context.configuredAgentId ? options.mcpServersForAgent?.(context.configuredAgentId) ?? [] : []),
            ...acpWorkflowMcpServers(options.workflowMcpDiscoveryPath?.(), context.planningWorkflowId, context.workflowRunId, context.workflowNodeId, options.workflowMcpManagedToken?.()),
          ],
          ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
        })
      : new HermesAgentExecutor(context, options),
    createInteractiveSession: (context) =>
      new HermesInteractiveSession(context, {
        capabilities: hermesInteractiveSessionCapabilities,
        createClient: ({ context: interactiveContext, onEvent, onExit }) =>
          new AcpInteractiveClient({
            executable: interactiveContext.runtime.command || options.executables.hermes,
            args: ["acp"],
            cwd: interactiveContext.workDir,
            modelId: interactiveContext.runtimeConfig.model,
            mcpServers: [...acpMcpServers(options.mcpServersForAgent?.(interactiveContext.configuredAgentId) ?? []), ...acpWorkflowMcpServers(options.workflowMcpDiscoveryPath?.(), interactiveContext.planningWorkflowId, interactiveContext.workflowRunId, interactiveContext.workflowNodeId, options.workflowMcpManagedToken?.())],
            onEvent,
            onExit,
            approvalOwnerId: interactiveContext.chatId,
            ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
          }),
      }),
    askWorkflow: (input) => runHermesWorkflow(input, options),
    testChannel: (input) => runHermesChannelTest(input, options),
    deleteSessionArtifacts:
      deleteSessionArtifactsByRuntime.hermes
      ?? ((input) => deleteHermesSessionArtifacts(options.executables.hermes, input)),
  });
}
