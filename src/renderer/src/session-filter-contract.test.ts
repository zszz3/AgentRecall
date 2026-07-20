import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rendererStyleSource } from "./style-test-source";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const stylesheet = rendererStyleSource;

describe("session filter toolbar contract", () => {
  it("offers date ranges while keeping smart ordering implicit", () => {
    expect(appSource).toContain('className="date-filter"');
    expect(appSource).toContain('const sortBy: SessionSortBy = "smart";');
    expect(appSource).not.toContain('className="sort-filter"');
    expect(appSource).not.toContain("setSortBy(");
    expect(stylesheet).not.toMatch(/\.sort-filter/);
  });

  it("drills a Token trend day into Sessions and lets presets replace it", () => {
    expect(appSource).toContain("const [customDateRange, setCustomDateRange]");
    expect(appSource).toContain("dateFrom: customDateRange.dayStart");
    expect(appSource).toContain("dateTo: customDateRange.dayEndExclusive - 1");
    expect(appSource).toContain("onSelectTrendDay={(day) => {");
    expect(appSource).toContain('setActivePage("sessions")');
    expect(appSource).toContain('setSource("all")');
    expect(appSource).toContain('setLiveStatus("all")');
    expect(appSource).toContain('className="date-filter-custom active"');
    expect(appSource).toContain('className={!customDateRange && dateRange === option.value ? "active" : ""}');
    expect(appSource).toContain("setCustomDateRange(null);");
    expect(stylesheet).toMatch(/\.date-filter-custom\s*\{/);
  });
});
