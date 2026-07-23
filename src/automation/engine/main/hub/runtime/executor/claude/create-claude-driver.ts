import { ClaudeAgentSdkAdapter, type ClaudeAgentSdkRunInput } from "../../../../agents/claude/claude-agent-sdk";
import { ClaudeAgentSdkInteractive } from "../../../../agents/claude/claude-agent-sdk-interactive";
import { ClaudeInteractiveSession } from "../../../../agents/claude/claude-interactive-session";
import { claudeCliModelForChannel } from "../../../../agents/claude/claude-env";
import type { RuntimeDriver } from "../../../../agents/runtime/runtime-driver";
import { claudeRuntimeStateCodec } from "../../../../agents/claude/claude-runtime-state-codec";
import { createInteractiveRuntimeDriver } from "../agent-executor-driver-factories";
import { modelFromRuntimeConfig, type RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import {
  claudeInteractiveSessionCapabilities,
  claudeSurfaceSupport,
  getClaudeCapabilities,
} from "./claude-capabilities";
import { deleteClaudeSessionArtifacts } from "./claude-cleanup";
import { ClaudeAgentExecutor } from "./claude-executor";
import { runClaudeChannelTest } from "./claude-test";
import { runClaudeWorkflow } from "./claude-workflow";
import { claudeWorkflowMcpServers } from "./claude-workflow-mcp";
import { claudeMcpServers } from "../runtime-mcp";

export interface ClaudeDriverDependencies {
  runOneShot?: (input: ClaudeAgentSdkRunInput) => Promise<void>;
}

export function createClaudeDriver(
  options: RuntimeAgentExecutorFactoryOptions,
  dependencies: ClaudeDriverDependencies = {},
): RuntimeDriver {
  const askWorkflowByRuntime = options.askWorkflowByRuntime ?? {};
  const testChannelByRuntime = options.testChannelByRuntime ?? {};
  const deleteSessionArtifactsByRuntime = options.deleteSessionArtifactsByRuntime ?? {};
  const claudeSdkAdapter = new ClaudeAgentSdkAdapter();
  const runClaudeOneShot = dependencies.runOneShot ?? ((input: ClaudeAgentSdkRunInput) => claudeSdkAdapter.runOneShot(input));
  const oneShotAdapter: Pick<ClaudeAgentSdkAdapter, "runOneShot"> = { runOneShot: runClaudeOneShot };

  return createInteractiveRuntimeDriver({
    runtimeId: "claude",
    surfaceSupport: [...claudeSurfaceSupport],
    getCapabilities: getClaudeCapabilities,
    runtimeStateCodec: claudeRuntimeStateCodec,
    createOneShotExecutor: (context) =>
      new ClaudeAgentExecutor(
        context,
        oneShotAdapter,
        claudeCliModelForChannel(options.channelById(context.channelId), modelFromRuntimeConfig(context.runtimeConfig)),
        options.requestApproval,
        {
          ...claudeMcpServers(context.configuredAgentId ? options.mcpServersForAgent?.(context.configuredAgentId) ?? [] : []),
          ...claudeWorkflowMcpServers(options.workflowMcpDiscoveryPath?.(), context.planningWorkflowId, context.workflowRunId, context.workflowNodeId),
        },
      ),
    createInteractiveSession: (context) =>
      new ClaudeInteractiveSession(
        context,
        {
          capabilities: claudeInteractiveSessionCapabilities,
          resolveModelId: (interactiveContext) =>
            claudeCliModelForChannel(
              options.channelById(interactiveContext.channelId),
              modelFromRuntimeConfig(interactiveContext.runtimeConfig),
            ) ?? modelFromRuntimeConfig(interactiveContext.runtimeConfig),
          resolveMcpServers: (interactiveContext) => ({
            ...claudeMcpServers(options.mcpServersForAgent?.(interactiveContext.configuredAgentId) ?? []),
            ...claudeWorkflowMcpServers(options.workflowMcpDiscoveryPath?.(), interactiveContext.planningWorkflowId, interactiveContext.workflowRunId, interactiveContext.workflowNodeId),
          }),
          sdkInteractive: new ClaudeAgentSdkInteractive(),
          ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
        },
      ),
    askWorkflow: askWorkflowByRuntime.claude ?? ((input) => runClaudeWorkflow(input, options, runClaudeOneShot)),
    testChannel: testChannelByRuntime.claude ?? ((input) => runClaudeChannelTest(input, options, oneShotAdapter)),
    deleteSessionArtifacts:
      deleteSessionArtifactsByRuntime.claude ??
      ((input) => deleteClaudeSessionArtifacts(input)),
  });
}
