import { AcpInteractiveClient } from "../../../../agents/acp/acp-interactive-client";
import type { RuntimeDriver } from "../../../../agents/runtime/runtime-driver";
import { openCodeRuntimeStateCodec } from "../../../../agents/opencode/opencode-runtime-state-codec";
import { createInteractiveRuntimeDriver } from "../agent-executor-driver-factories";
import type { RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import {
  getOpenCodeCapabilities,
  openCodeInteractiveSessionCapabilities,
  openCodeSurfaceSupport,
} from "./opencode-capabilities";
import { deleteOpenCodeSessionArtifacts } from "./opencode-cleanup";
import { OpenCodeAgentExecutor } from "./opencode-executor";
import { OpenCodeInteractiveSession } from "./opencode-session";
import { runOpenCodeChannelTest, runOpenCodeWorkflow } from "./opencode-workflow";
import { acpMcpServers, acpWorkflowMcpServers } from "../runtime-mcp";
import { AcpWorkflowOneShotExecutor } from "../acp-workflow-one-shot-executor";
import { workflowMcpScopeForContext } from "../../../../../shared/workflow-mcp-policy";

export function createOpenCodeDriver(options: RuntimeAgentExecutorFactoryOptions): RuntimeDriver {
  const deleteSessionArtifactsByRuntime = options.deleteSessionArtifactsByRuntime ?? {};
  return createInteractiveRuntimeDriver({
    runtimeId: "opencode",
    surfaceSupport: [...openCodeSurfaceSupport],
    getCapabilities: getOpenCodeCapabilities,
    runtimeStateCodec: openCodeRuntimeStateCodec,
    createOneShotExecutor: (context) => context.planningWorkflowId && context.workflowRunId && context.workflowNodeId
      ? new AcpWorkflowOneShotExecutor(context, {
          executable: context.runtime.command || options.executables.opencode,
          args: ["acp", "--cwd", context.workDir],
          modelId: context.runtimeConfig.model,
          mcpServers: [
            ...acpMcpServers(context.configuredAgentId ? options.mcpServersForAgent?.(context.configuredAgentId) ?? [] : []),
            ...acpWorkflowMcpServers({
              discoveryPath: options.workflowMcpDiscoveryPath?.(), workflowId: context.planningWorkflowId,
              runId: context.workflowRunId, nodeId: context.workflowNodeId, executionId: context.workflowNodeExecutionId, managedToken: options.workflowMcpManagedToken?.(),
            }),
          ],
          ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
        })
      : new OpenCodeAgentExecutor(context, options),
    createInteractiveSession: (context) =>
      new OpenCodeInteractiveSession(context, {
        capabilities: openCodeInteractiveSessionCapabilities,
        createClient: ({ context: interactiveContext, onEvent, onExit }) =>
          new AcpInteractiveClient({
            executable: interactiveContext.runtime.command || options.executables.opencode,
            args: ["acp", "--cwd", interactiveContext.workDir],
            cwd: interactiveContext.workDir,
            modelId: interactiveContext.runtimeConfig.model,
            mcpServers: [...acpMcpServers(options.mcpServersForAgent?.(interactiveContext.configuredAgentId) ?? []), ...acpWorkflowMcpServers({
              discoveryPath: options.workflowMcpDiscoveryPath?.(), workflowId: interactiveContext.planningWorkflowId,
              runId: interactiveContext.workflowRunId, nodeId: interactiveContext.workflowNodeId, executionId: interactiveContext.workflowNodeExecutionId, managedToken: options.workflowMcpManagedToken?.(),
            })],
            onEvent,
            onExit,
            approvalOwnerId: interactiveContext.chatId,
            ...(workflowMcpScopeForContext(interactiveContext) ? { workflowMcpScope: workflowMcpScopeForContext(interactiveContext) } : {}),
            ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
          }),
      }),
    askWorkflow: (input) => runOpenCodeWorkflow(input, options),
    testChannel: (input) => runOpenCodeChannelTest(input, options),
    deleteSessionArtifacts:
      deleteSessionArtifactsByRuntime.opencode
      ?? ((input) => deleteOpenCodeSessionArtifacts(options.executables.opencode, input)),
  });
}
