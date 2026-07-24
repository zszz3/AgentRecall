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

  it("keeps segmented toolbar filters evenly divided", () => {
    expect(appSource).toContain('className="live-filter"');
    expect(appSource).toContain("LIVE_STATUS_FILTERS.map");
    expect(appSource).toContain("liveStatusFilterLabel(option.value, language)");
    expect(stylesheet).toMatch(/--sort-filter-width:\s*214px/);
    expect(stylesheet).toMatch(/\.live-filter\s*\{[^}]*width:\s*var\(--live-filter-width\)/);
    expect(stylesheet).toMatch(/\.live-filter button\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 0/);
    expect(stylesheet).toMatch(/\.date-filter\s*\{[^}]*width:\s*var\(--date-filter-width\)/);
    expect(stylesheet).toMatch(/\.date-filter button\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 0/);
    expect(stylesheet).toMatch(/\.sort-filter\s*\{[^}]*width:\s*var\(--sort-filter-width\)/);
    expect(stylesheet).toMatch(/\.sort-filter button\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 0/);
  });

  it("keeps secondary segmented controls evenly divided", () => {
    expect(stylesheet).toMatch(/\.stats-period-toggle\s*\{[^}]*width:\s*142px/);
    expect(stylesheet).toMatch(/\.stats-period-toggle button\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 0/);
    expect(stylesheet).toMatch(/\.stats-period-toggle button\s*\{[^}]*white-space:\s*nowrap/);
    expect(stylesheet).toMatch(/\.theme-setting-toggle,\s*\.language-setting-toggle\s*\{[^}]*width:\s*176px/);
    expect(stylesheet).toMatch(/\.theme-setting-toggle button,\s*\.language-setting-toggle button\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 0/);
  });
});
