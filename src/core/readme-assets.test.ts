import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("README assets", () => {
  it("keeps the concise READMEs free of the rate-limited remote chart", () => {
    const chineseReadme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");
    const englishReadme = readFileSync(resolve(repositoryRoot, "docs/README.en.md"), "utf8");
    const chartPath = resolve(repositoryRoot, "assets/star-history.svg");

    expect(chineseReadme).not.toContain("api.star-history.com");
    expect(englishReadme).not.toContain("api.star-history.com");
    expect(existsSync(chartPath)).toBe(true);
    const chart = readFileSync(chartPath, "utf8");
    expect(chart).toContain("<svg");
    expect(chart).toContain('<rect fill="#ffffff"');
    expect(chart).toContain('<stop offset="0%" stop-color="#54aeff" stop-opacity="0.36" />');
    expect(chart).toContain('fill="#1f2328"');
  });
});
