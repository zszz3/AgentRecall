import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUERY_BUILDER_STATE,
  countActiveFilters,
  hasActiveFilters,
  toSearchOptionsPatch,
  type QueryBuilderState,
} from "./query-builder-types";

describe("query-builder-types", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_QUERY_BUILDER_STATE.source).toBeUndefined();
    expect(DEFAULT_QUERY_BUILDER_STATE.tag).toBeUndefined();
    expect(DEFAULT_QUERY_BUILDER_STATE.visibility).toBe("default");
    expect(DEFAULT_QUERY_BUILDER_STATE.dateRange).toBe("all");
  });

  it("converts state to a search options patch", () => {
    const state: QueryBuilderState = {
      source: "codex-cli",
      tag: "urgent",
      visibility: "favorites",
      dateRange: "7d",
    };
    const now = 1_720_000_000_000;
    const patch = toSearchOptionsPatch(state, now);
    expect(patch.source).toBe("codex-cli");
    expect(patch.tag).toBe("urgent");
    expect(patch.visibility).toBe("favorites");
    expect(patch.dateFrom).toBe(now - 7 * 24 * 60 * 60 * 1000);
    expect(patch.dateTo).toBe(now);
  });

  it("omits date bounds for the all range", () => {
    const patch = toSearchOptionsPatch({ ...DEFAULT_QUERY_BUILDER_STATE, dateRange: "all" }, 123);
    expect(patch.dateFrom).toBeUndefined();
    expect(patch.dateTo).toBeUndefined();
  });

  it("detects active filters", () => {
    expect(hasActiveFilters(DEFAULT_QUERY_BUILDER_STATE)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_QUERY_BUILDER_STATE, source: "claude-cli" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_QUERY_BUILDER_STATE, dateRange: "30d" })).toBe(true);
  });

  it("counts active filters", () => {
    expect(countActiveFilters(DEFAULT_QUERY_BUILDER_STATE)).toBe(0);
    expect(
      countActiveFilters({ source: "codex-cli", tag: "x", visibility: "pinned", dateRange: "90d" }),
    ).toBe(4);
    expect(countActiveFilters({ ...DEFAULT_QUERY_BUILDER_STATE, tag: "only" })).toBe(1);
  });
});
