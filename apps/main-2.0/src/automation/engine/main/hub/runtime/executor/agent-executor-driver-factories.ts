import type { AgentId, AgentRuntime, AgentOneShotResponse } from "../../../../shared/types";
import type { RuntimeCapabilities } from "../../../agents/runtime/runtime-capabilities";
import type {
  RuntimeChannelTestContext,
  RuntimeDriver,
  RuntimeSurfaceSupport,
  RuntimeSessionCleanupContext,
  RuntimeOneShotRequest,
} from "../../../agents/runtime/runtime-driver";

export function createInteractiveRuntimeDriver(input: {
  runtimeId: AgentId;
  surfaceSupport: RuntimeSurfaceSupport[];
  getCapabilities: (runtime: AgentRuntime) => RuntimeCapabilities;
  runtimeStateCodec: NonNullable<RuntimeDriver["runtimeStateCodec"]>;
  createOneShotExecutor: NonNullable<RuntimeDriver["createOneShotExecutor"]>;
  createInteractiveSession: NonNullable<RuntimeDriver["createInteractiveSession"]>;
  askOneShot: ((input: RuntimeOneShotRequest) => Promise<AgentOneShotResponse>) | undefined;
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
    ...(input.askOneShot ? { askOneShot: input.askOneShot } : {}),
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
  askOneShot: ((input: RuntimeOneShotRequest) => Promise<AgentOneShotResponse>) | undefined;
  testChannel: ((input: RuntimeChannelTestContext) => Promise<string>) | undefined;
  deleteSessionArtifacts: ((input: RuntimeSessionCleanupContext) => Promise<void>) | undefined;
}): RuntimeDriver {
  return {
    runtimeId: input.runtimeId,
    surfaceSupport: [...input.surfaceSupport],
    ...(input.runtimeStateCodec ? { runtimeStateCodec: input.runtimeStateCodec } : {}),
    getCapabilities: input.getCapabilities,
    createOneShotExecutor: input.createOneShotExecutor,
    ...(input.askOneShot ? { askOneShot: input.askOneShot } : {}),
    ...(input.testChannel ? { testChannel: input.testChannel } : {}),
    ...(input.deleteSessionArtifacts ? { deleteSessionArtifacts: input.deleteSessionArtifacts } : {}),
  };
}
