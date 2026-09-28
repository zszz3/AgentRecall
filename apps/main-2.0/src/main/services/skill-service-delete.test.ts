import { describe, expect, it, vi } from "vitest";

import { SkillService } from "./skill-service";

function makeDependencies() {
  const listProjects = vi.fn(async () => [{ path: "/workspace/project", environmentId: "local" }]);
  const managedLibrary = {
    list: vi.fn(() => ({ skills: [], roots: [], scannedAt: 0 })),
    listImportCandidates: vi.fn(() => ({ skills: [], roots: [], scannedAt: 0 })),
    importLocalSkill: vi.fn(),
    ensureBuiltinSkills: vi.fn(),
    importFiles: vi.fn(),
    replaceFiles: vi.fn(),
    updateTargets: vi.fn(),
    delete: vi.fn(),
  };
  const deleteInstalledSkill = vi.fn(() => ({
    deletedPath: "/home/.codex/skills/local-skill",
    skillName: "Local Skill",
    retainedBackupPaths: [],
  }));
  const skillProjectDirsFromIndexedProjects = vi.fn(() => ["/workspace/project"]);
  const service = new SkillService({
    getStore: () => ({ listProjects }) as never,
    getSettings: () => ({}) as never,
    getHookSetup: vi.fn() as never,
    copyText: vi.fn(),
    revealPath: vi.fn(async () => undefined),
    now: () => 0,
    logError: vi.fn(),
    managedLibrary,
    homeDir: "/home",
    codexHome: "/home/.codex",
    operations: { deleteInstalledSkill, skillProjectDirsFromIndexedProjects },
  });
  return { service, managedLibrary, deleteInstalledSkill, skillProjectDirsFromIndexedProjects };
}

describe("SkillService deletion", () => {
  it("deletes a Skill from the managed library when it belongs to the app", async () => {
    const fixture = makeDependencies();
    fixture.managedLibrary.list.mockReturnValue({
      skills: [{ managedId: "managed-skill", path: "/library/managed-skill/SKILL.md", directoryPath: "/library/managed-skill" }],
      roots: [],
      scannedAt: 0,
    } as never);
    fixture.managedLibrary.delete.mockReturnValue({
      deletedPath: "/library/managed-skill",
      skillName: "Managed Skill",
      retainedBackupPaths: [],
    });

    await expect(fixture.service.delete("/library/managed-skill/SKILL.md"))
      .resolves.toMatchObject({ skillName: "Managed Skill" });
    expect(fixture.managedLibrary.delete).toHaveBeenCalledWith("managed-skill");
    expect(fixture.deleteInstalledSkill).not.toHaveBeenCalled();
  });

  it("falls back to protected local-root deletion for a local Skill", async () => {
    const fixture = makeDependencies();

    await expect(fixture.service.delete("/home/.codex/skills/local-skill/SKILL.md"))
      .resolves.toMatchObject({ skillName: "Local Skill" });
    expect(fixture.skillProjectDirsFromIndexedProjects).toHaveBeenCalledWith([
      { path: "/workspace/project", environmentId: "local" },
    ]);
    expect(fixture.deleteInstalledSkill).toHaveBeenCalledWith(
      "/home/.codex/skills/local-skill/SKILL.md",
      {
        homeDir: "/home",
        codexHome: "/home/.codex",
        projectDirs: ["/workspace/project"],
      },
    );
  });
});
