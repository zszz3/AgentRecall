import { describe, expect, it } from "vitest";
import type { ManagedSkill, SkillInstallTarget } from "../../../../core/managed-skill-library";
import { planBatchSkillTargetInstall } from "./skill-batch-install";

describe("planBatchSkillTargetInstall", () => {
  it("preserves existing targets, adds safe targets, and skips conflicts", () => {
    const skill = managedSkill({
      codex: "installed",
      "codex-shared": "not-installed",
      claude: "conflict",
    });

    expect(planBatchSkillTargetInstall(skill, ["codex-shared", "claude"])).toEqual({
      targets: ["codex", "codex-shared"],
      conflictTargets: ["claude"],
      changed: true,
    });
  });

  it("does not rewrite a Skill when every requested target is already installed", () => {
    const skill = managedSkill({ codex: "installed" });

    expect(planBatchSkillTargetInstall(skill, ["codex"])).toEqual({
      targets: ["codex"],
      conflictTargets: [],
      changed: false,
    });
  });
});

function managedSkill(states: Partial<Record<SkillInstallTarget, "installed" | "not-installed" | "conflict">>): ManagedSkill {
  const targets = Object.keys(states) as SkillInstallTarget[];
  return {
    id: "agent-recall-v2:example",
    managedId: "example",
    name: "example",
    description: "fixture",
    agent: "codex",
    source: "agent-recall-v2",
    path: "/managed/example/SKILL.md",
    directoryPath: "/managed/example",
    rootPath: "/managed",
    markdown: "# example",
    mtimeMs: 1,
    origin: { kind: "builtin", label: "Built-in" },
    installations: targets.map((target) => ({
      target,
      path: `/targets/${target}/example`,
      state: states[target]!,
    })),
  };
}
