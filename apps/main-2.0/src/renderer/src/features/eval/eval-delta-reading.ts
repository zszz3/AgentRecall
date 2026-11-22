/**
 * Whether a score delta means anything.
 *
 * A case run twice can land far apart on its own, so a delta inside that gap says
 * nothing about the change under comparison. The band comes from the runs' own
 * repeated-case spread instead of a configured constant: a made-up default would
 * be a criterion nobody chose, and "never scored twice" is the honest reading when
 * a case's variation was not measured.
 */
export type DeltaReading = "improved" | "regressed" | "within-noise" | "unmeasured";

export function deltaReading(delta: number, band: number | null): DeltaReading {
  if (band === null) return "unmeasured";
  if (delta > band) return "improved";
  if (delta < -band) return "regressed";
  return "within-noise";
}

export function deltaBadgeClass(reading: DeltaReading): string {
  if (reading === "improved") return "eval-badge-ok";
  if (reading === "regressed") return "eval-badge-warn";
  return "eval-badge-dim";
}

/**
 * Wider of two bands. A comparison sets one draw from each run side by side, so
 * instability on either side is enough to make a small delta unattributable.
 */
export function widerBand(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

export function deltaTitle(
  reading: DeltaReading,
  band: number | null,
  l: (en: string, zh: string) => string,
): string {
  if (reading === "unmeasured") {
    return l(
      "Fewer than two scored repetitions, so this delta cannot be told apart from ordinary variation.",
      "评分过的重复次不足两次，这个涨跌分不清是改动带来的还是本身的波动。",
    );
  }
  const width = `±${(band ?? 0).toFixed(2)}`;
  if (reading === "within-noise") {
    return l(`Inside the ${width} repeat spread.`, `在 ${width} 的重复波动带内。`);
  }
  return reading === "improved"
    ? l(`Past the ${width} repeat spread, so it reads as a real improvement.`, `超出 ${width} 的重复波动带，可以当成真的改进。`)
    : l(`Past the ${width} repeat spread, so it reads as a real regression.`, `超出 ${width} 的重复波动带，可以当成真的回归。`);
}
