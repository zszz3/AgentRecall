export interface OptionalRuntimePolicy {
  automaticUpdateChecks: boolean;
  advancedTasks: boolean;
}

export interface OptionalRuntimeDependencies {
  checkForUpdates(): Promise<void> | void;
  startAdvancedTasks(): Promise<void> | void;
}

export interface OptionalRuntimeActivation {
  updateCheck: "disabled" | "completed";
  advancedTasks: "disabled" | "started";
}

/**
 * This is the sole opt-in gate intended to run after the first usable window.
 * In particular, a disabled update preference never reaches a network-capable
 * update callback, and disabled advanced work never reaches its task starter.
 */
export async function activateAfterFirstWindowReady(
  policy: OptionalRuntimePolicy,
  dependencies: OptionalRuntimeDependencies,
): Promise<OptionalRuntimeActivation> {
  if (policy.automaticUpdateChecks) await dependencies.checkForUpdates();
  if (policy.advancedTasks) await dependencies.startAdvancedTasks();

  return {
    updateCheck: policy.automaticUpdateChecks ? "completed" : "disabled",
    advancedTasks: policy.advancedTasks ? "started" : "disabled",
  };
}
