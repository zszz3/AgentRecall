import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("session filter toolbar contract", () => {
  it("offers date ranges without exposing selectable session sorting", () => {
    expect(appSource).toContain('sortBy: "activity"');
    expect(appSource).toContain('className="date-filter"');
    expect(appSource).not.toContain('className="sort-menu"');
    expect(appSource).not.toContain("setSortBy");
    expect(stylesheet).not.toMatch(/\.sort-menu/);
  });
});
