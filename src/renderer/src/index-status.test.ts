import { describe, expect, it } from "vitest";
import type { IndexStatus } from "../../core/indexer";
import { coalesceIndexStatusForRender } from "./index-status";

function status(running: boolean, total: number): IndexStatus {
  return {
    running,
    indexed: total,
    skipped: 0,
    total,
    lastIndexedAt: running ? null : Date.now(),
    error: null,
  };
}

describe("index status rendering", () => {
  it("reuses the current state during intermediate progress and applies lifecycle changes", () => {
    const started = status(true, 0);
    const progressed = status(true, 50);
    const completed = status(false, 50);

    expect(coalesceIndexStatusForRender(null, started)).toBe(started);
    expect(coalesceIndexStatusForRender(started, progressed)).toBe(started);
    expect(coalesceIndexStatusForRender(started, completed)).toBe(completed);
  });
});
