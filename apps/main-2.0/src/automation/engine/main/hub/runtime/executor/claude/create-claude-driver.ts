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
import { runClaudeOneShot } from "./claude-oneshot";
import { claudeMcpServers } from "../runtime-mcp";

export interface ClaudeDriverDependencies {
  runOneShot?: (input: ClaudeAgentSdkRunInput) => Promise<void>;
}

export function createClaudeDriver(
  options: RuntimeAgentExecutorFactoryOptions,
  dependencies: ClaudeDriverDependencies = {},
): RuntimeDriver {
  const askOneShotByRuntime = options.askOneShotByRuntime ?? {};
  const testChannelByRuntime = options.testChannelByRuntime ?? {};
  const deleteSessionArtifactsByRuntime = options.deleteSessionArtifactsByRuntime ?? {};
  const claudeSdkAdapter = new ClaudeAgentSdkAdapter();
  const runOneShot = dependencies.runOneShot ?? ((input: ClaudeAgentSdkRunInput) => claudeSdkAdapter.runOneShot(input));
  const oneShotAdapter: Pick<ClaudeAgentSdkAdapter, "runOneShot"> = { runOneShot };

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
        claudeMcpServers(context.configuredAgentId ? options.mcpServersForAgent?.(context.configuredAgentId) ?? [] : []),
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
          resolveMcpServers: (interactiveContext) =>
            claudeMcpServers(options.mcpServersForAgent?.(interactiveContext.configuredAgentId) ?? []),
          sdkInteractive: new ClaudeAgentSdkInteractive(),
          ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
        },
      ),
    askOneShot: askOneShotByRuntime.claude ?? ((input) => runClaudeOneShot(input, options, runOneShot)),
    testChannel: testChannelByRuntime.claude ?? ((input) => runClaudeChannelTest(input, options, oneShotAdapter)),
    deleteSessionArtifacts:
      deleteSessionArtifactsByRuntime.claude ??
      ((input) => deleteClaudeSessionArtifacts(input)),
  });
}
