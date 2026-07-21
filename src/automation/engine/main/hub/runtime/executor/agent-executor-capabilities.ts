import type { RuntimeSurfaceSupport } from "../../../agents/runtime/runtime-driver";

export function support(
  surface: RuntimeSurfaceSupport["surface"],
  executionModes: RuntimeSurfaceSupport["executionModes"],
  continuationPolicies: RuntimeSurfaceSupport["continuationPolicies"],
): RuntimeSurfaceSupport {
  return { surface, executionModes, continuationPolicies };
}
