import type { RuntimeDriver } from "../../../../agents/runtime/runtime-driver";
import { createOneShotRuntimeDriver } from "../agent-executor-driver-factories";
import type { RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import { apiSurfaceSupport, getApiCapabilities } from "./api-capabilities";
import { ApiAgentExecutor } from "./api-executor";
import { runApiChannelTest } from "./api-test";
import { runApiOneShot } from "./api-oneshot";

export function createApiDriver(options: RuntimeAgentExecutorFactoryOptions): RuntimeDriver {
  const askOneShotByRuntime = options.askOneShotByRuntime ?? {};
  const testChannelByRuntime = options.testChannelByRuntime ?? {};

  return createOneShotRuntimeDriver({
    runtimeId: "api",
    surfaceSupport: [...apiSurfaceSupport],
    getCapabilities: getApiCapabilities,
    createOneShotExecutor: (context) => new ApiAgentExecutor(context, options),
    askOneShot: askOneShotByRuntime.api ?? ((input) => runApiOneShot(input, options)),
    testChannel: testChannelByRuntime.api ?? ((input) => runApiChannelTest(input, options)),
    deleteSessionArtifacts: undefined,
  });
}
