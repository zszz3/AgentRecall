import type { OpenVikingMemorySnapshot } from "./openviking-memory";

export function isOpenVikingMemoryTransient(
  snapshot: OpenVikingMemorySnapshot | null,
  importInFlight: boolean,
): boolean {
  return importInFlight
    || snapshot?.runtime.state === "installing"
    || snapshot?.runtime.state === "starting"
    || snapshot?.workspaces.some((workspace) =>
      ["queued", "running"].includes(workspace.importState))
    || false;
}
