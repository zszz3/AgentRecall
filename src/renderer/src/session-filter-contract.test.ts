import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("session filter toolbar contract", () => {
  it("offers date ranges and sort order controls", () => {
    expect(appSource).toContain('className="date-filter"');
    expect(appSource).toContain('className="sort-filter"');
    expect(appSource).toContain('setSortBy("smart")');
    expect(appSource).toContain('setSortBy("activity")');
    expect(appSource).toContain('setSortBy("created")');
    expect(stylesheet).toMatch(/\.sort-filter/);
  });
});
