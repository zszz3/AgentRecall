import { describe, expect, it } from "vitest";
import type { SessionContextSample } from "../../../../core/types";
import { contextCallWidth, contextChart } from "./context-chart";

function call(turn: number, occurredAt: string, cached: number, created = 0, input = 0, output = 10): SessionContextSample {
  return {
    turnId: `turn-${turn}`,
    turnIndex: turn,
    occurredAt,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheCreationInputTokens: created,
    outputTokens: output,
  };
}

describe("contextChart", () => {
  it("adds up the context each call sent and marks where a Turn starts", () => {
    const chart = contextChart([
      call(0, "2026-11-23T08:00:00.000Z", 0, 1_000, 200),
      call(0, "2026-11-23T08:00:05.000Z", 1_200, 300, 50),
      call(1, "2026-11-23T08:01:00.000Z", 1_500, 0, 100, 40),
    ]);

    expect(chart.points.map((point) => point.total)).toEqual([1_200, 1_550, 1_600]);
    expect(chart.turns).toEqual([
      { index: 0, turnId: "turn-0", turnIndex: 0 },
      { index: 2, turnId: "turn-1", turnIndex: 1 },
    ]);
    expect(chart.summary).toEqual({ calls: 3, peak: 1_600, last: 1_600, cacheShare: 2_700 / 4_350, compactions: 0, output: 60 });
  });

  it("counts a call that sent far less context than the one before as a compaction", () => {
    const chart = contextChart([
      call(0, "2026-11-23T08:00:00.000Z", 100_000),
      call(0, "2026-11-23T08:00:05.000Z", 180_000),
      call(0, "2026-11-23T08:00:10.000Z", 70_000),
      call(1, "2026-11-23T08:01:00.000Z", 60_000),
    ]);

    expect(chart.points.map((point) => point.compacted)).toEqual([false, false, true, false]);
    expect(chart.summary.compactions).toBe(1);
    expect(chart.summary.peak).toBe(180_000);
  });

  it("has nothing to draw for a Session without per-call usage", () => {
    expect(contextChart([])).toEqual({
      points: [],
      turns: [],
      summary: { calls: 0, peak: 0, last: 0, cacheShare: 0, compactions: 0, output: 0 },
    });
  });

  it("fits about a hundred Turns into the visible width, fills it for shorter Sessions and zooms from there", () => {
    const long = contextCallWidth({ calls: 2_532, turns: 227, viewport: 1_250, zoom: 1 });
    expect(1_250 / (long * (2_532 / 227))).toBeCloseTo(100);
    expect(contextCallWidth({ calls: 40, turns: 5, viewport: 1_000, zoom: 1 })).toBe(25);
    expect(contextCallWidth({ calls: 2_532, turns: 227, viewport: 1_250, zoom: 2 })).toBeCloseTo(long * 2);
    expect(contextCallWidth({ calls: 100_000, turns: 10, viewport: 1_000, zoom: 1 })).toBe(0.5);
    expect(contextCallWidth({ calls: 3, turns: 2, viewport: 0, zoom: 1 })).toBe(6);
  });
});
