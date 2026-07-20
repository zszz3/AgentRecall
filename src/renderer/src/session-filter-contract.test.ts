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
});
