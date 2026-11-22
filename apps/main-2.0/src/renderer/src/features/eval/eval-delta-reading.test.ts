import { describe, expect, it } from "vitest";
import { deltaBadgeClass, deltaReading, deltaTitle, widerBand, type DeltaReading } from "./eval-delta-reading";

const english = (en: string) => en;

describe("eval delta reading", () => {
  it("reads a delta against the repeat spread and refuses to read it without one", () => {
    expect(deltaReading(0.5, null)).toBe("unmeasured");
    expect(deltaReading(0.11, 0.1)).toBe("improved");
    expect(deltaReading(-0.11, 0.1)).toBe("regressed");
    expect(deltaReading(0.1, 0.1)).toBe("within-noise");
    expect(deltaReading(-0.1, 0.1)).toBe("within-noise");
    expect(deltaReading(0, 0)).toBe("within-noise");
    const readings: DeltaReading[] = ["improved", "regressed", "within-noise", "unmeasured"];
    expect(readings.map(deltaBadgeClass))
      .toEqual(["eval-badge-ok", "eval-badge-warn", "eval-badge-dim", "eval-badge-dim"]);
  });

  it("uses the wider band when either run measured its spread", () => {
    expect(widerBand(null, null)).toBeNull();
    expect(widerBand(0.2, null)).toBe(0.2);
    expect(widerBand(null, 0.3)).toBe(0.3);
    expect(widerBand(0.2, 0.05)).toBe(0.2);
  });

  it("names the band width in the explanation, or the missing repetitions when there is none", () => {
    expect(deltaTitle("unmeasured", null, english)).toContain("Fewer than two scored repetitions");
    expect(deltaTitle("within-noise", 0.1, english)).toBe("Inside the ±0.10 repeat spread.");
    expect(deltaTitle("improved", 0.125, english)).toBe("Past the ±0.13 repeat spread, so it reads as a real improvement.");
    expect(deltaTitle("regressed", 0.1, english)).toBe("Past the ±0.10 repeat spread, so it reads as a real regression.");
  });
});
