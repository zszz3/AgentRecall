import { describe, expect, it, vi } from "vitest";

import { SkillService } from "./skill-service";

function makeService(existing: string[], importFiles: ReturnType<typeof vi.fn>) {
  const managedLibrary = {
    list: vi.fn(() => ({ skills: existing.map((managedId) => ({ managedId })), roots: [], scannedAt: 0 })),
    listImportCandidates: vi.fn(), importLocalSkill: vi.fn(), ensureBuiltinSkills: vi.fn(), importFiles, replaceFiles: vi.fn(), updateTargets: vi.fn(), delete: vi.fn(),
  };
  return new SkillService({
    getStore: () => ({}) as never, getSettings: () => ({}) as never, getHookSetup: vi.fn() as never, copyText: vi.fn(), revealPath: vi.fn(async () => undefined),
    now: () => 0, logError: vi.fn(), managedLibrary: managedLibrary as never, homeDir: "/home", codexHome: "/home/.codex",
  });
}

describe("SkillService.createLibrarySkill", () => {
  it("writes a SKILL.md with the chosen ID and a one-line description into the library", () => {
    const importFiles = vi.fn(() => ({ status: "imported", managedId: "pglite", skill: {} }));
    expect(makeService([], importFiles).createLibrarySkill({ id: "pglite", description: "PGlite 参数\n类型推断", body: "# 标题\n\n显式写 $2::integer" })).toEqual({ status: "imported", managedId: "pglite" });
    expect(importFiles).toHaveBeenCalledWith({
      suggestedId: "pglite",
      origin: { kind: "local", label: "经验卡" },
      files: [{ relativePath: "SKILL.md", contents: '---\nname: pglite\ndescription: "PGlite 参数 类型推断"\n---\n\n# 标题\n\n显式写 $2::integer\n', mode: 0o644 }],
    });
  });

  it("reports an ID already used by a different Skill instead of replacing it", () => {
    const importFiles = vi.fn(() => { throw new Error("Managed Skill pglite already exists with different content."); });
    expect(makeService(["pglite"], importFiles).createLibrarySkill({ id: "pglite", description: "d", body: "b" })).toEqual({ status: "conflict", managedId: "pglite" });
    expect(() => makeService([], importFiles).createLibrarySkill({ id: "pglite", description: "d", body: "b" })).toThrow("already exists");
  });
});
