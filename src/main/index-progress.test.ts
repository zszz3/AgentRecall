import { describe, expect, it } from "vitest";
import { createIndexProgressPublisher } from "./index-progress";
import type { IndexStatus } from "../core/indexer";

function status(total: number, running = true): IndexStatus {
  return {
    running,
    indexed: total,
    skipped: 0,
    total,
    lastIndexedAt: running ? null : Date.now(),
    error: null,
  };
}

describe("index progress publisher", () => {
  it("limits intermediate renderer updates while always publishing start and completion", () => {
    let clock = 0;
    const published: number[] = [];
    const publisher = createIndexProgressPublisher(
      (nextStatus) => published.push(nextStatus.total),
      { minIntervalMs: 200, now: () => clock },
    );

    publisher.publish(status(0), true);
    for (let total = 1; total <= 10; total++) {
      clock += 20;
      publisher.publish(status(total));
    }
    publisher.publish(status(10, false), true);

    expect(published).toEqual([0, 10, 10]);
  });
});
