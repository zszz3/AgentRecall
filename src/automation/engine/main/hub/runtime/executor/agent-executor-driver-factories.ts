import type { AgentId, AgentRuntime, WorkflowAgentResponse } from "../../../../shared/types";
import type { RuntimeCapabilities } from "../../../agents/runtime/runtime-capabilities";
import type {
  RuntimeChannelTestContext,
  RuntimeDriver,
  RuntimeSurfaceSupport,
  RuntimeSessionCleanupContext,
  RuntimeWorkflowRequestContext,
} from "../../../agents/runtime/runtime-driver";

export function createInteractiveRuntimeDriver(input: {
  runtimeId: AgentId;
  surfaceSupport: RuntimeSurfaceSupport[];
  getCapabilities: (runtime: AgentRuntime) => RuntimeCapabilities;
  runtimeStateCodec: NonNullable<RuntimeDriver["runtimeStateCodec"]>;
  createOneShotExecutor: NonNullable<RuntimeDriver["createOneShotExecutor"]>;
  createInteractiveSession: NonNullable<RuntimeDriver["createInteractiveSession"]>;
  askWorkflow: ((input: RuntimeWorkflowRequestContext) => Promise<WorkflowAgentResponse>) | undefined;
  testChannel: ((input: RuntimeChannelTestContext) => Promise<string>) | undefined;
  deleteSessionArtifacts: ((input: RuntimeSessionCleanupContext) => Promise<void>) | undefined;
}): RuntimeDriver {
  return {
    runtimeId: input.runtimeId,
    surfaceSupport: [...input.surfaceSupport],
    runtimeStateCodec: input.runtimeStateCodec,
    getCapabilities: input.getCapabilities,
    createOneShotExecutor: input.createOneShotExecutor,
    createInteractiveSession: input.createInteractiveSession,
    ...(input.askWorkflow ? { askWorkflow: input.askWorkflow } : {}),
    ...(input.testChannel ? { testChannel: input.testChannel } : {}),
    ...(input.deleteSessionArtifacts ? { deleteSessionArtifacts: input.deleteSessionArtifacts } : {}),
  };
}

export function createOneShotRuntimeDriver(input: {
  runtimeId: AgentId;
  surfaceSupport: RuntimeSurfaceSupport[];
  getCapabilities: (runtime: AgentRuntime) => RuntimeCapabilities;
  runtimeStateCodec?: RuntimeDriver["runtimeStateCodec"];
  createOneShotExecutor: NonNullable<RuntimeDriver["createOneShotExecutor"]>;
  askWorkflow: ((input: RuntimeWorkflowRequestContext) => Promise<WorkflowAgentResponse>) | undefined;
  testChannel: ((input: RuntimeChannelTestContext) => Promise<string>) | undefined;
  deleteSessionArtifacts: ((input: RuntimeSessionCleanupContext) => Promise<void>) | undefined;
}): RuntimeDriver {
  return {
    runtimeId: input.runtimeId,
    surfaceSupport: [...input.surfaceSupport],
    ...(input.runtimeStateCodec ? { runtimeStateCodec: input.runtimeStateCodec } : {}),
    getCapabilities: input.getCapabilities,
    createOneShotExecutor: input.createOneShotExecutor,
    ...(input.askWorkflow ? { askWorkflow: input.askWorkflow } : {}),
    ...(input.testChannel ? { testChannel: input.testChannel } : {}),
    ...(input.deleteSessionArtifacts ? { deleteSessionArtifacts: input.deleteSessionArtifacts } : {}),
  };
}
