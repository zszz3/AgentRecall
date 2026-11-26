import type { SessionContextSample } from "../../../../core/types";

/** A call that sends less than this share of the previous call's context ran after a compaction. */
const COMPACTION_RATIO = 0.6;

export interface ContextPoint {
  sample: SessionContextSample;
  /** Everything the call sent: cache reads, cache writes and uncached input. */
  total: number;
  compacted: boolean;
}

export interface ContextChart {
  points: ContextPoint[];
  /** The first call of each Turn, by its position in `points`. */
  turns: Array<{ index: number; turnId: string | null; turnIndex: number | null }>;
  summary: {
    calls: number;
    peak: number;
    last: number;
    /** Share of all sent context the provider read from its cache. */
    cacheShare: number;
    compactions: number;
    output: number;
  };
}

export function contextChart(samples: readonly SessionContextSample[]): ContextChart {
  const points: ContextPoint[] = [];
  const turns: ContextChart["turns"] = [];
  let sent = 0;
  let cached = 0;
  let output = 0;
  let peak = 0;
  let compactions = 0;
  for (const sample of samples) {
    const total = sample.inputTokens + sample.cachedInputTokens + sample.cacheCreationInputTokens;
    const previous = points.at(-1);
    const compacted = previous !== undefined && total < previous.total * COMPACTION_RATIO;
    if (previous === undefined || previous.sample.turnId !== sample.turnId) {
      turns.push({ index: points.length, turnId: sample.turnId, turnIndex: sample.turnIndex });
    }
    points.push({ sample, total, compacted });
    sent += total;
    cached += sample.cachedInputTokens;
    output += sample.outputTokens;
    peak = Math.max(peak, total);
    if (compacted) compactions += 1;
  }
  return {
    points,
    turns,
    summary: {
      calls: points.length,
      peak,
      last: points.at(-1)?.total ?? 0,
      cacheShare: sent > 0 ? cached / sent : 0,
      compactions,
      output,
    },
  };
}

/** Turns visible at once before the reader zooms; longer Sessions scroll sideways. */
const VISIBLE_TURNS = 100;
const MIN_CALL_WIDTH = 0.5;
const CALL_WIDTH_BEFORE_LAYOUT = 6;

/**
 * Horizontal room for one model call. The chart opens with about a hundred Turns in view and fills the
 * width when the Session is shorter; `zoom` multiplies that so the reader can widen or narrow it.
 */
export function contextCallWidth({ calls, turns, viewport, zoom }: { calls: number; turns: number; viewport: number; zoom: number }): number {
  if (calls === 0 || viewport <= 0) return CALL_WIDTH_BEFORE_LAYOUT;
  const visibleCalls = Math.min(calls, (calls / Math.max(turns, 1)) * VISIBLE_TURNS);
  return Math.max(MIN_CALL_WIDTH, (viewport / visibleCalls) * zoom);
}
