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

export function createOpenCodeDriver(options: RuntimeAgentExecutorFactoryOptions): RuntimeDriver {
  const deleteSessionArtifactsByRuntime = options.deleteSessionArtifactsByRuntime ?? {};
  return createInteractiveRuntimeDriver({
    runtimeId: "opencode",
    surfaceSupport: [...openCodeSurfaceSupport],
    getCapabilities: getOpenCodeCapabilities,
    runtimeStateCodec: openCodeRuntimeStateCodec,
    createOneShotExecutor: (context) => new OpenCodeAgentExecutor(context, options),
    createInteractiveSession: (context) =>
      new OpenCodeInteractiveSession(context, {
        capabilities: openCodeInteractiveSessionCapabilities,
        createClient: ({ context: interactiveContext, onEvent, onExit }) =>
          new AcpInteractiveClient({
            executable: interactiveContext.runtime.command || options.executables.opencode,
            args: ["acp", "--cwd", interactiveContext.workDir],
            cwd: interactiveContext.workDir,
            modelId: interactiveContext.runtimeConfig.model,
            mcpServers: [...acpMcpServers(options.mcpServersForAgent?.(interactiveContext.configuredAgentId) ?? []), ...acpWorkflowMcpServers(options.workflowMcpDiscoveryPath?.(), interactiveContext.planningWorkflowId, interactiveContext.workflowRunId, interactiveContext.workflowNodeId)],
            onEvent,
            onExit,
            approvalOwnerId: interactiveContext.chatId,
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
