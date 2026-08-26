import { describe, expect, it } from "vitest";

import { TRACE_DETAIL_PREVIEW_MAX_CHARS, truncateTraceDetail } from "./trace-detail";

describe("truncateTraceDetail", () => {
  it("keeps surrogate pairs intact at the preview boundary", () => {
    const retainedPrefix = `😀${"x".repeat(11_944)}`;
    const detail = `${retainedPrefix}𝔸${"y".repeat(600)}`;

    const truncated = truncateTraceDetail(detail);

    expect(truncated.length).toBeLessThanOrEqual(TRACE_DETAIL_PREVIEW_MAX_CHARS);
    expect(truncated.slice(0, truncated.indexOf("\n\n[Indexed preview truncated"))).toBe(retainedPrefix);
    expect(Buffer.from(truncated, "utf8").toString("utf8")).toBe(truncated);
  });

  it("omits a whole surrogate pair when a short preview ends between its code units", () => {
    expect(truncateTraceDetail("😀tail", 1)).toBe("");
    expect(truncateTraceDetail("😀tail", 2)).toBe("😀");
  });

  it("stays within the limit when the omitted count grows or its notice cannot fit", () => {
    expect(truncateTraceDetail("x".repeat(12_048)).length).toBe(TRACE_DETAIL_PREVIEW_MAX_CHARS);
    expect(truncateTraceDetail("x".repeat(100), 30)).toHaveLength(30);
    expect(truncateTraceDetail("anything", Number.NaN)).toBe("");
  });
});
