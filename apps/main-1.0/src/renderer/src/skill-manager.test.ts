import { describe, expect, it } from "vitest";
import type { InstalledSkill, SkillSource } from "../../core/skill-manager";
import { filterInstalledSkills, skillSourceLabel } from "./skill-manager";

function skill(source: SkillSource): InstalledSkill {
  const agent = source.startsWith("qoder-")
    ? "qoder"
    : source.startsWith("codex-")
      ? "codex"
      : "claude";

  return {
    id: source,
    name: `${source} skill`,
    description: "",
    agent,
    source,
    path: `/skills/${source}/SKILL.md`,
    directoryPath: `/skills/${source}`,
    rootPath: "/skills",
    markdown: "",
    mtimeMs: 0,
  };
}

describe("skillSourceLabel", () => {
  it("labels Qoder sources explicitly", () => {
    expect(skillSourceLabel("qoder-user")).toBe("Qoder");
    expect(skillSourceLabel("qoder-project")).toBe("Qoder Project");
  });
});

describe("filterInstalledSkills", () => {
  const skills = [
    skill("codex-project"),
    skill("claude-project"),
    skill("qoder-project"),
    skill("qoder-user"),
  ];

  it("includes Qoder project skills in the project filter", () => {
    expect(filterInstalledSkills(skills, "", "project").map((item) => item.source)).toEqual([
      "codex-project",
      "claude-project",
      "qoder-project",
    ]);
  });

  it("finds Qoder skills by their source label", () => {
    expect(filterInstalledSkills(skills, "qoder", "all").map((item) => item.source)).toEqual([
      "qoder-project",
      "qoder-user",
    ]);
  });
});
