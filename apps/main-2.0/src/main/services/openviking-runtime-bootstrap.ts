import type {
  OpenVikingMemorySnapshot,
  OpenVikingModelStatus,
  OpenVikingRuntimeStatus,
} from "../../core/openviking-memory";

// Bringing the OpenViking runtime up at startup used to be a single guarded
// call: start only when the runtime reported "stopped". A released runtime
// revision bump leaves the installed copy behind, so the status becomes
// "not-installed" instead, the guard silently fell through, and long-term
// memory stayed off for every hook without surfacing anything — the hook
// manifest just kept a null baseUrl. This orchestrator installs what is
// missing, starts the runtime, and reports which stage failed so startup can
// log an actionable message instead of nothing.

export type OpenVikingRuntimeBootstrapOutcome =
  | { status: "skipped"; reason: "memory-disabled" | "no-managed-workspace" | "runtime-busy" }
  | { status: "already-running" }
  | { status: "started"; installedRuntime: boolean; installedModel: boolean }
  | {
    status: "failed";
    stage: "snapshot" | "install-runtime" | "install-model" | "start";
    message: string;
  };

export interface OpenVikingRuntimeBootstrapDependencies {
  memoryEnabled: boolean;
  snapshot(): Promise<OpenVikingMemorySnapshot>;
  installRuntime(): Promise<OpenVikingRuntimeStatus>;
  installModel(): Promise<OpenVikingModelStatus>;
  startRuntime(): Promise<OpenVikingRuntimeStatus>;
  logInfo(message: string): void;
  logError(message: string): void;
}

export async function bootstrapOpenVikingRuntime(
  dependencies: OpenVikingRuntimeBootstrapDependencies,
): Promise<OpenVikingRuntimeBootstrapOutcome> {
  if (!dependencies.memoryEnabled) return { status: "skipped", reason: "memory-disabled" };

  let snapshot: OpenVikingMemorySnapshot;
  try {
    snapshot = await dependencies.snapshot();
  } catch (error) {
    return failure(dependencies, "snapshot", error);
  }

  if (!snapshot.workspaces.some((workspace) => workspace.managed)) {
    return { status: "skipped", reason: "no-managed-workspace" };
  }
  if (snapshot.runtime.state === "running") return { status: "already-running" };
  // Another install or start is already in flight; joining it would only
  // duplicate a multi-hundred-megabyte download.
  if (snapshot.runtime.state === "installing" || snapshot.runtime.state === "starting") {
    return { status: "skipped", reason: "runtime-busy" };
  }

  let installedRuntime = false;
  if (snapshot.runtime.state === "not-installed") {
    dependencies.logInfo(
      "The OpenViking runtime for this build is not installed. Installing it so long-term memory keeps working.",
    );
    try {
      await dependencies.installRuntime();
      installedRuntime = true;
    } catch (error) {
      return failure(dependencies, "install-runtime", error);
    }
  }

  let installedModel = false;
  if (!snapshot.model.installed) {
    dependencies.logInfo("The local embedding model is missing. Downloading it before starting OpenViking.");
    try {
      await dependencies.installModel();
      installedModel = true;
    } catch (error) {
      return failure(dependencies, "install-model", error);
    }
  }

  try {
    await dependencies.startRuntime();
  } catch (error) {
    return failure(dependencies, "start", error);
  }
  return { status: "started", installedRuntime, installedModel };
}

function failure(
  dependencies: OpenVikingRuntimeBootstrapDependencies,
  stage: "snapshot" | "install-runtime" | "install-model" | "start",
  error: unknown,
): OpenVikingRuntimeBootstrapOutcome {
  const message = error instanceof Error ? error.message : String(error);
  dependencies.logError(`OpenViking runtime bootstrap failed while it ran ${stage}: ${message}`);
  return { status: "failed", stage, message };
}
