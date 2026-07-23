import { AcpInteractiveClient } from "../../../../agents/acp/acp-interactive-client";
import type { RuntimeDriver } from "../../../../agents/runtime/runtime-driver";
import { openClawRuntimeStateCodec } from "../../../../agents/openclaw/openclaw-runtime-state-codec";
import { createInteractiveRuntimeDriver } from "../agent-executor-driver-factories";
import type { RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import {
  getOpenClawCapabilities,
  openClawInteractiveSessionCapabilities,
  openClawSurfaceSupport,
} from "./openclaw-capabilities";
import { OpenClawAgentExecutor } from "./openclaw-executor";
import { OpenClawInteractiveSession } from "./openclaw-session";
import { runOpenClawChannelTest, runOpenClawWorkflow } from "./openclaw-workflow";
import { acpMcpServers, acpWorkflowMcpServers } from "../runtime-mcp";
import { AcpWorkflowOneShotExecutor } from "../acp-workflow-one-shot-executor";

export function createOpenClawDriver(options: RuntimeAgentExecutorFactoryOptions): RuntimeDriver {
  return createInteractiveRuntimeDriver({
    runtimeId: "openclaw",
    surfaceSupport: [...openClawSurfaceSupport],
    getCapabilities: getOpenClawCapabilities,
    runtimeStateCodec: openClawRuntimeStateCodec,
    createOneShotExecutor: (context) => context.planningWorkflowId && context.workflowRunId && context.workflowNodeId
      ? new AcpWorkflowOneShotExecutor(context, {
          executable: context.runtime.command || options.executables.openclaw,
          args: ["acp"],
          modelId: context.runtimeConfig.model,
          mcpServers: [
            ...acpMcpServers(context.configuredAgentId ? options.mcpServersForAgent?.(context.configuredAgentId) ?? [] : []),
            ...acpWorkflowMcpServers(options.workflowMcpDiscoveryPath?.(), context.planningWorkflowId, context.workflowRunId, context.workflowNodeId, options.workflowMcpManagedToken?.()),
          ],
          ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
        })
      : new OpenClawAgentExecutor(context, options),
    createInteractiveSession: (context) =>
      new OpenClawInteractiveSession(context, {
        capabilities: openClawInteractiveSessionCapabilities,
        createClient: ({ context: interactiveContext, onEvent, onExit }) =>
          new AcpInteractiveClient({
            executable: interactiveContext.runtime.command || options.executables.openclaw,
            args: ["acp"],
            cwd: interactiveContext.workDir,
            mcpServers: [...acpMcpServers(options.mcpServersForAgent?.(interactiveContext.configuredAgentId) ?? []), ...acpWorkflowMcpServers(options.workflowMcpDiscoveryPath?.(), interactiveContext.planningWorkflowId, interactiveContext.workflowRunId, interactiveContext.workflowNodeId, options.workflowMcpManagedToken?.())],
            onEvent,
            onExit,
            approvalOwnerId: interactiveContext.chatId,
            ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
          }),
      }),
    askWorkflow: (input) => runOpenClawWorkflow(input, options),
    testChannel: (input) => runOpenClawChannelTest(input, options),
    deleteSessionArtifacts: undefined,
  });
}
