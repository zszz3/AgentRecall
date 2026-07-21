import type {
  AgentId,
  RuntimeContinuationPolicy,
  RuntimeConversation,
  RuntimeExecutionMode,
} from "../../../../shared/types";
import type { RuntimeSurface } from "../../../agents/runtime/runtime-driver";
import type { RuntimeDriverRegistry } from "../executor/agent-executor";

function surfaceSupportForRuntime(
  runtimeDrivers: Pick<RuntimeDriverRegistry, "maybeDriverFor">,
  runtimeId: AgentId,
  surface: RuntimeSurface,
) {
  return runtimeDrivers.maybeDriverFor(runtimeId)?.surfaceSupport.find((item) => item.surface === surface);
}

export function supportsContinuationPolicy(input: {
  runtimeDrivers: Pick<RuntimeDriverRegistry, "maybeDriverFor">;
  runtimeId: AgentId;
  surface: RuntimeSurface;
  executionMode: RuntimeExecutionMode;
  continuationPolicy: RuntimeContinuationPolicy;
}): boolean {
  const driver = input.runtimeDrivers.maybeDriverFor(input.runtimeId);
  if (!driver) return false;
  const support = driver.surfaceSupport.find((item) => item.surface === input.surface);
  if (!support) return false;
  if (!support.executionModes.includes(input.executionMode)) return false;
  if (!support.continuationPolicies.includes(input.continuationPolicy)) return false;
  if (input.continuationPolicy !== "fresh" && !driver.runtimeStateCodec) return false;
  return true;
}

export function selectExecutionMode(input: {
  runtimeDrivers: Pick<RuntimeDriverRegistry, "maybeDriverFor">;
  runtimeId: AgentId;
  surface: RuntimeSurface;
  preferred: RuntimeExecutionMode;
}): RuntimeExecutionMode {
  const support = surfaceSupportForRuntime(input.runtimeDrivers, input.runtimeId, input.surface);
  if (!support) return "oneshot";
  if (support.executionModes.length === 0) return "oneshot";
  if (support.executionModes.includes(input.preferred)) return input.preferred;
  if (input.preferred !== "oneshot" && support.executionModes.includes("oneshot")) return "oneshot";
  if (input.preferred !== "interactive" && support.executionModes.includes("interactive")) return "interactive";
  return "oneshot";
}

export function defaultContinuationPolicy(input: {
  runtimeDrivers: Pick<RuntimeDriverRegistry, "maybeDriverFor">;
  runtimeId: AgentId;
  surface: RuntimeSurface;
  executionMode: RuntimeExecutionMode;
}): RuntimeContinuationPolicy {
  if (input.surface === "chat") {
    for (const policy of ["resume-preferred", "fresh", "resume-required"] as const) {
      if (
        supportsContinuationPolicy({
          runtimeDrivers: input.runtimeDrivers,
          runtimeId: input.runtimeId,
          surface: input.surface,
          executionMode: input.executionMode,
          continuationPolicy: policy,
        })
      ) {
        return policy;
      }
    }
  }
  return "fresh";
}

export function cloneConversationForPolicy(
  continuationPolicy: RuntimeContinuationPolicy,
  runtimeConversation: RuntimeConversation | undefined,
  cloneConversation: (conversation: RuntimeConversation) => RuntimeConversation,
): RuntimeConversation | undefined {
  if (!runtimeConversation || continuationPolicy === "fresh") return undefined;
  return cloneConversation(runtimeConversation);
}
