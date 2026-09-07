import { describe, expect, it } from "vitest";
import { bundledSkillAssetsFor, loadBundledSkillTemplates } from "./bundled-skill-library";

describe("bundled Skill assets", () => {
  it("lists the technical writing and diagram Skills as official writing templates", () => {
    const templates = loadBundledSkillTemplates();

    expect(templates.map((template) => template.id)).toEqual([
      "brainstorming",
      "frontend-design",
      "feishu-tech-diagram",
      "handoff",
      "skill-creator",
      "systematic-debugging",
      "personal-finance-planning",
      "resume-optimization",
      "paper-writing",
      "rewrite-technical-tutorial",
      "refactor-review-knowledge",
      "code-review-and-quality",
    ]);

    expect(templates.find((template) => template.id === "rewrite-technical-tutorial"))
      .toMatchObject({
        name: "rewrite-technical-tutorial",
        categoryId: "writing",
        sourceType: "official",
        sourcePath: "assets/bundled-skills/rewrite-technical-tutorial/SKILL.md",
      });
    expect(templates.find((template) => template.id === "feishu-tech-diagram"))
      .toMatchObject({
        name: "feishu-tech-diagram",
        categoryId: "writing",
        sourceType: "official",
        sourcePath: "assets/bundled-skills/feishu-tech-diagram/SKILL.md",
      });
  });

  it("embeds auxiliary files for Skills that reference them", () => {
    const brainstormingAssets = bundledSkillAssetsFor("brainstorming");
    const diagramAssets = bundledSkillAssetsFor("feishu-tech-diagram");
    const tutorialAssets = bundledSkillAssetsFor("rewrite-technical-tutorial");
    const systematicDebuggingAssets = bundledSkillAssetsFor("systematic-debugging");

    expect(brainstormingAssets.map((asset) => asset.relativePath)).toContain("references/visual-companion.md");
    expect(systematicDebuggingAssets.map((asset) => asset.relativePath)).toEqual(expect.arrayContaining([
      "condition-based-waiting.md",
      "defense-in-depth.md",
      "root-cause-tracing.md",
    ]));
    expect(tutorialAssets.map((asset) => asset.relativePath)).toEqual(expect.arrayContaining([
      "SKILL.md",
      "agents/openai.yaml",
    ]));
    expect(diagramAssets.map((asset) => asset.relativePath)).toEqual(expect.arrayContaining([
      "SKILL.md",
      "agents/openai.yaml",
      "references/diagram-prompts.json",
      "references/template-catalog.md",
      "references/template-specs.json",
      "references/visual-examples.md",
      "scripts/render_lark_skill_doc.py",
      "tests/validate_assets.py",
    ]));
    expect(diagramAssets.filter((asset) => asset.relativePath.startsWith("assets/samples/") && asset.relativePath.endsWith(".svg")))
      .toHaveLength(66);
  });
});
