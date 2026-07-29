import { describe, expect, it } from "vitest";
import type { SkillRootStatus } from "../../core/skill-manager";
import { summarizeSkillRoots } from "./features/skills/skills-dialog";

describe("summarizeSkillRoots", () => {
  it("hides duplicate missing Qoder project roots", () => {
    const roots: SkillRootStatus[] = [
      {
        agent: "qoder",
        source: "qoder-project",
        path: "/repo-a/.qoder/skills",
        exists: false,
        skillCount: 0,
      },
      {
        agent: "qoder",
        source: "qoder-project",
        path: "/repo-b/.qoder/skills",
        exists: false,
        skillCount: 0,
      },
    ];

    expect(summarizeSkillRoots(roots)).toEqual([]);
  });

  it("combines available Qoder project roots and omits missing paths", () => {
    const roots: SkillRootStatus[] = [
      {
        agent: "qoder",
        source: "qoder-user",
        path: "/home/.qoder/skills",
        exists: true,
        skillCount: 1,
      },
      {
        agent: "qoder",
        source: "qoder-project",
        path: "/repo-a/.qoder/skills",
        exists: true,
        skillCount: 2,
      },
      {
        agent: "qoder",
        source: "qoder-project",
        path: "/repo-b/.qoder/skills",
        exists: true,
        skillCount: 3,
      },
      {
        agent: "qoder",
        source: "qoder-project",
        path: "/repo-c/.qoder/skills",
        exists: false,
        skillCount: 0,
      },
    ];

    expect(summarizeSkillRoots(roots)).toEqual([
      roots[0],
      {
        agent: "qoder",
        source: "qoder-project",
        path: "/repo-a/.qoder/skills\n/repo-b/.qoder/skills",
        exists: true,
        skillCount: 5,
      },
    ]);
  });
});
