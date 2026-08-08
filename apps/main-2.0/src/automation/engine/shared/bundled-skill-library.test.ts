import { describe, expect, it } from "vitest";
import { bundledSkillAssetsFor } from "./bundled-skill-library";

describe("bundled Skill assets", () => {
  it("embeds auxiliary files for Skills that reference them", () => {
    const brainstormingAssets = bundledSkillAssetsFor("brainstorming");
    const systematicDebuggingAssets = bundledSkillAssetsFor("systematic-debugging");

    expect(brainstormingAssets.map((asset) => asset.relativePath)).toContain("references/visual-companion.md");
    expect(systematicDebuggingAssets.map((asset) => asset.relativePath)).toEqual(expect.arrayContaining([
      "condition-based-waiting.md",
      "defense-in-depth.md",
      "root-cause-tracing.md",
    ]));
  });
});
