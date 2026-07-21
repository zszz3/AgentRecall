import { describe, expect, it, vi } from "vitest";
import { refreshSnapshotForFeature } from "./shell";

describe("refreshSnapshotForFeature", () => {
  it("reloads authoritative history when entering workflow", async () => {
    const snapshot = { workflowStore: { workflows: [{ workflowId: "wf-1" }] } } as never;
    const load = vi.fn(async () => snapshot);
    const apply = vi.fn();
    await refreshSnapshotForFeature("workflow", load, apply);
    expect(load).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(snapshot);
  });

  it("does not reload for unrelated features", async () => {
    const load = vi.fn();
    await refreshSnapshotForFeature("chat", load, vi.fn());
    expect(load).not.toHaveBeenCalled();
  });
});
