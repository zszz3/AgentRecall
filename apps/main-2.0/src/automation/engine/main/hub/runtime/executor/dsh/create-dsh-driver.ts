import { dshRuntimeStateCodec } from "../../../../agents/dsh/dsh-runtime-state-codec";
import type { RuntimeDriver } from "../../../../agents/runtime/runtime-driver";
import { createOneShotRuntimeDriver } from "../agent-executor-driver-factories";
import type { RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import { dshSurfaceSupport, getDshCapabilities } from "./dsh-capabilities";
import { DshAgentExecutor } from "./dsh-executor";
import { DshRuntimeLifecycle } from "./dsh-runtime-lifecycle";
import { runDshChannelTest, runDshWorkflow } from "./dsh-workflow";

export function createDshDriver(options: RuntimeAgentExecutorFactoryOptions): RuntimeDriver {
  const lifecycle = new DshRuntimeLifecycle();
  const driver = createOneShotRuntimeDriver({
    runtimeId: "dsh",
    runtimeStateCodec: dshRuntimeStateCodec,
    surfaceSupport: [...dshSurfaceSupport],
    getCapabilities: getDshCapabilities,
    createOneShotExecutor: (context) =>
      new DshAgentExecutor(context, options, lifecycle.createRunner),
    askWorkflow: (input) =>
      runDshWorkflow(input, options, lifecycle.createRunner),
    testChannel: (input) =>
      runDshChannelTest(input, options, lifecycle.createRunner),
    deleteSessionArtifacts: undefined,
  });
  return {
    ...driver,
    shutdown: () => lifecycle.shutdown(),
  };
}
