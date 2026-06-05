import { describe, expect, it } from "vitest";
import type { InstalledSkill } from "../../core/skill-manager";
import { filterInstalledSkills, sortInstalledSkills } from "./skill-manager";

function skill(overrides: Partial<InstalledSkill> & Pick<InstalledSkill, "name" | "agent" | "source">): InstalledSkill {
  return {
    id: overrides.name,
    description: "",
    path: `/skills/${overrides.name}/SKILL.md`,
    directoryPath: `/skills/${overrides.name}`,
    rootPath: "/skills",
    markdown: "",
    mtimeMs: 0,
    ...overrides,
  };
}

describe("skill manager renderer data", () => {
  it("filters installed skills by agent-level and special source filters", () => {
    const skills = [
      skill({ name: "codex-user-skill", agent: "codex", source: "codex-user" }),
      skill({ name: "shared-skill", agent: "codex", source: "codex-shared" }),
      skill({ name: "claude-user-skill", agent: "claude", source: "claude-user" }),
      skill({ name: "project-skill", agent: "claude", source: "claude-project" }),
    ];

    expect(filterInstalledSkills(skills, "", "codex").map((item) => item.name)).toEqual(["codex-user-skill", "shared-skill"]);
    expect(filterInstalledSkills(skills, "", "claude").map((item) => item.name)).toEqual(["claude-user-skill", "project-skill"]);
    expect(filterInstalledSkills(skills, "", "shared").map((item) => item.name)).toEqual(["shared-skill"]);
    expect(filterInstalledSkills(skills, "", "project").map((item) => item.name)).toEqual(["project-skill"]);
  });

  it("searches skill name, description, and path", () => {
    const skills = [
      skill({ name: "review-code", description: "Review changes", agent: "codex", source: "codex-user" }),
      skill({ name: "deploy-helper", description: "Release checklist", path: "/tmp/.claude/skills/deploy-helper/SKILL.md", agent: "claude", source: "claude-user" }),
    ];

    expect(filterInstalledSkills(skills, "review", "all").map((item) => item.name)).toEqual(["review-code"]);
    expect(filterInstalledSkills(skills, "release", "all").map((item) => item.name)).toEqual(["deploy-helper"]);
    expect(filterInstalledSkills(skills, ".claude", "all").map((item) => item.name)).toEqual(["deploy-helper"]);
  });

  it("sorts by usage, name, or update time", () => {
    const skills = [
      skill({ name: "alpha", agent: "claude", source: "claude-user", usageCount: 1, lastUsedAt: 100, mtimeMs: 10 }),
      skill({ name: "bravo", agent: "claude", source: "claude-user", usageCount: 5, lastUsedAt: 200, mtimeMs: 30 }),
      skill({ name: "charlie", agent: "claude", source: "claude-user", usageCount: 0, lastUsedAt: null, mtimeMs: 20 }),
    ];

    expect(sortInstalledSkills(skills, "usage").map((item) => item.name)).toEqual(["bravo", "alpha", "charlie"]);
    expect(sortInstalledSkills(skills, "usage-asc").map((item) => item.name)).toEqual(["charlie", "alpha", "bravo"]);
    expect(sortInstalledSkills(skills, "name").map((item) => item.name)).toEqual(["alpha", "bravo", "charlie"]);
    expect(sortInstalledSkills(skills, "updated").map((item) => item.name)).toEqual(["bravo", "charlie", "alpha"]);
  });
});
