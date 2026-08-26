import mutableFs, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_RECALL_BUILTIN_SKILLS,
  ManagedSkillLibrary,
  type SkillInstallTarget,
} from "./managed-skill-library";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createManagedSkillFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(tmpdir(), "agent-recall-managed-skill-"));
  temporaryDirectories.push(fixtureRoot);
  const homeDir = path.join(fixtureRoot, "home");
  const library = new ManagedSkillLibrary({
    libraryRoot: path.join(fixtureRoot, "library"),
    homeDir,
  });
  const imported = library.importFiles({
    suggestedId: "fixture-skill",
    origin: { kind: "local", label: "Test fixture" },
    files: [{ relativePath: "SKILL.md", contents: "# Fixture Skill\n" }],
  });
  return {
    fixtureRoot,
    homeDir,
    library,
    managedId: imported.managedId,
    managedSkillPath: imported.skill.directoryPath,
  };
}

function aliasCodexAndSharedSkillParents(fixture: ReturnType<typeof createManagedSkillFixture>) {
  const codexSkillsParent = path.join(fixture.homeDir, ".codex", "skills");
  const sharedSkillsParent = path.join(fixture.homeDir, ".agents", "skills");
  fs.mkdirSync(sharedSkillsParent, { recursive: true });
  fs.mkdirSync(path.dirname(codexSkillsParent), { recursive: true });
  fs.symlinkSync(
    sharedSkillsParent,
    codexSkillsParent,
    process.platform === "win32" ? "junction" : "dir",
  );
  return {
    codexSkillsParent,
    sharedSkillsParent,
    sharedTargetPath: path.join(sharedSkillsParent, fixture.managedId),
  };
}

function replaceSymlinkSync(replacement: typeof fs.symlinkSync): () => void {
  const original = mutableFs.symlinkSync;
  mutableFs.symlinkSync = replacement;
  syncBuiltinESMExports();
  return () => {
    mutableFs.symlinkSync = original;
    syncBuiltinESMExports();
  };
}

function replaceRmSync(replacement: typeof fs.rmSync): () => void {
  const original = mutableFs.rmSync;
  mutableFs.rmSync = replacement;
  syncBuiltinESMExports();
  return () => {
    mutableFs.rmSync = original;
    syncBuiltinESMExports();
  };
}

function replaceUnlinkSync(replacement: typeof fs.unlinkSync): () => void {
  const original = mutableFs.unlinkSync;
  mutableFs.unlinkSync = replacement;
  syncBuiltinESMExports();
  return () => {
    mutableFs.unlinkSync = original;
    syncBuiltinESMExports();
  };
}

function replaceRenameSync(replacement: typeof fs.renameSync): () => void {
  const original = mutableFs.renameSync;
  mutableFs.renameSync = replacement;
  syncBuiltinESMExports();
  return () => {
    mutableFs.renameSync = original;
    syncBuiltinESMExports();
  };
}

function replaceLstatSync(replacement: typeof fs.lstatSync): () => void {
  const mutableLstatFs = mutableFs as unknown as { lstatSync: typeof fs.lstatSync };
  const original = mutableLstatFs.lstatSync;
  mutableLstatFs.lstatSync = replacement;
  syncBuiltinESMExports();
  return () => {
    mutableLstatFs.lstatSync = original;
    syncBuiltinESMExports();
  };
}

function replaceRealpathSync(replacement: typeof fs.realpathSync): () => void {
  const mutableRealpathFs = mutableFs as unknown as { realpathSync: typeof fs.realpathSync };
  const original = mutableRealpathFs.realpathSync;
  mutableRealpathFs.realpathSync = replacement;
  syncBuiltinESMExports();
  return () => {
    mutableRealpathFs.realpathSync = original;
    syncBuiltinESMExports();
  };
}

describe("AgentRecall bundled Skills", () => {
  it("ships aihot as an official built-in Skill", () => {
    expect(AGENT_RECALL_BUILTIN_SKILLS).toContainEqual({
      id: "aihot",
      installId: "aihot",
      sourceUrl: "https://github.com/KKKKhazix/khazix-skills/tree/main/aihot",
      categoryId: "explore",
    });
    expect(
      fs.existsSync(fileURLToPath(new URL("../../assets/bundled-skills/aihot/SKILL.md", import.meta.url))),
    ).toBe(true);
  });

  it("ships resume-optimization as an official built-in Skill", () => {
    expect(AGENT_RECALL_BUILTIN_SKILLS).toContainEqual({
      id: "resume-optimization",
      installId: "resume-optimization",
      sourceUrl: "https://github.com/melodic-software/claude-code-plugins/tree/main/plugins/soft-skills/skills/resume-optimization",
      categoryId: "writing",
    });
    const bundledSkillUrl = new URL("../../assets/bundled-skills/resume-optimization/", import.meta.url);
    expect(fs.existsSync(fileURLToPath(new URL("SKILL.md", bundledSkillUrl)))).toBe(true);
    expect(fs.existsSync(fileURLToPath(new URL("SKILL.zh.md", bundledSkillUrl)))).toBe(true);
    expect(fs.existsSync(fileURLToPath(new URL("metadata.json", bundledSkillUrl)))).toBe(true);
    expect(fs.existsSync(fileURLToPath(new URL("LICENSE", bundledSkillUrl)))).toBe(true);
  });

  it("ships one-bite-teaching as an official built-in Skill with both language variants", () => {
    expect(AGENT_RECALL_BUILTIN_SKILLS).toContainEqual({
      id: "one-bite-teaching",
      installId: "one-bite-teaching",
      sourceUrl: "https://github.com/zszz3/AgentRecall/tree/main/apps/main-2.0/assets/bundled-skills/one-bite-teaching",
      categoryId: "explore",
    });
    const bundledSkillUrl = new URL("../../assets/bundled-skills/one-bite-teaching/", import.meta.url);
    expect(fs.existsSync(fileURLToPath(new URL("SKILL.md", bundledSkillUrl)))).toBe(true);
    expect(fs.existsSync(fileURLToPath(new URL("SKILL.zh.md", bundledSkillUrl)))).toBe(true);
    const metadata = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL("metadata.json", bundledSkillUrl)), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata.categoryId).toBe("explore");
    expect(metadata.tags).toContain("teaching");
  });

  it("ships the adapted DeepSeek Harness quality Skills with their licenses", () => {
    const skills = [
      { id: "dsh-code-review", categoryId: "coding" },
      { id: "dsh-find-simplifications", categoryId: "coding" },
      { id: "dsh-prose-standard", categoryId: "writing" },
      { id: "dsh-trim-cot-leakage", categoryId: "writing" },
    ];

    for (const { id, categoryId } of skills) {
      expect(AGENT_RECALL_BUILTIN_SKILLS).toContainEqual({
        id,
        installId: id,
        sourceUrl: `https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents/skills/${id}`,
        categoryId,
      });
      const bundledSkillUrl = new URL(`../../assets/bundled-skills/${id}/`, import.meta.url);
      expect(fs.existsSync(fileURLToPath(new URL("SKILL.md", bundledSkillUrl)))).toBe(true);
      expect(fs.existsSync(fileURLToPath(new URL("LICENSE", bundledSkillUrl)))).toBe(true);
    }
  });

  it("imports aihot into a fresh managed library with built-in origin metadata", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(tmpdir(), "agent-recall-builtin-skill-"));
    temporaryDirectories.push(fixtureRoot);
    const library = new ManagedSkillLibrary({
      libraryRoot: path.join(fixtureRoot, "skills"),
      homeDir: path.join(fixtureRoot, "home"),
    });
    const bundledRoot = fileURLToPath(new URL("../../assets/bundled-skills", import.meta.url));

    library.ensureBuiltinSkills(bundledRoot);

    expect(library.list().skills.find((skill) => skill.managedId === "aihot")?.origin).toEqual({
      kind: "builtin",
      label: "AgentRecall",
      url: "https://github.com/KKKKhazix/khazix-skills/tree/main/aihot",
    });
    expect(library.list().skills.find((skill) => skill.managedId === "resume-optimization")?.origin).toEqual({
      kind: "builtin",
      label: "AgentRecall",
      url: "https://github.com/melodic-software/claude-code-plugins/tree/main/plugins/soft-skills/skills/resume-optimization",
    });
    expect(library.list().skills.find((skill) => skill.managedId === "dsh-trim-cot-leakage")?.origin).toEqual({
      kind: "builtin",
      label: "AgentRecall",
      url: "https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents/skills/dsh-trim-cot-leakage",
    });
    expect(library.list().skills.find((skill) => skill.managedId === "aihot")?.categoryId).toBe("explore");
    expect(library.list().skills.find((skill) => skill.managedId === "resume-optimization")?.categoryId).toBe("writing");
    expect(library.list().skills.find((skill) => skill.managedId === "dsh-code-review")?.categoryId).toBe("coding");
    expect(library.list().skills.find((skill) => skill.managedId === "dsh-trim-cot-leakage")?.categoryId).toBe("writing");
  });

  it("adds the current category to existing built-in metadata without re-importing the Skill", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(tmpdir(), "agent-recall-builtin-category-"));
    temporaryDirectories.push(fixtureRoot);
    const libraryRoot = path.join(fixtureRoot, "skills");
    const library = new ManagedSkillLibrary({
      libraryRoot,
      homeDir: path.join(fixtureRoot, "home"),
    });
    const bundledRoot = fileURLToPath(new URL("../../assets/bundled-skills", import.meta.url));

    library.ensureBuiltinSkills(bundledRoot);
    const metadataPath = path.join(libraryRoot, ".metadata", "aihot.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    const importedAt = metadata.importedAt;
    delete metadata.categoryId;
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    library.ensureBuiltinSkills(bundledRoot);

    expect(library.list().skills.find((skill) => skill.managedId === "aihot")?.categoryId).toBe("explore");
    expect((JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>).importedAt).toBe(importedAt);
  });

  it("installs a managed Skill into the shared Codex agents directory", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(tmpdir(), "agent-recall-shared-skill-"));
    temporaryDirectories.push(fixtureRoot);
    const homeDir = path.join(fixtureRoot, "home");
    const library = new ManagedSkillLibrary({
      libraryRoot: path.join(fixtureRoot, "skills"),
      homeDir,
    });
    const bundledRoot = fileURLToPath(new URL("../../assets/bundled-skills", import.meta.url));

    library.ensureBuiltinSkills(bundledRoot);
    const updated = library.updateTargets("grill-me", ["codex-shared"]);
    const installation = updated.installations.find((item) => item.target === "codex-shared");

    expect(installation?.state).toBe("installed");
    expect(installation?.path).toBe(path.join(homeDir, ".agents", "skills", "grill-me"));
  });
});

describe("ManagedSkillLibrary conflicting installation targets", () => {
  it("force replaces a real directory conflict with the managed Skill link", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    fs.mkdirSync(targetPath, { recursive: true });
    fs.writeFileSync(path.join(targetPath, "local-only.txt"), "keep unless forced");

    const updated = fixture.library.updateTargets(
      fixture.managedId,
      ["codex"],
      ["codex"],
    );

    expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(targetPath)).toBe(fs.realpathSync(fixture.managedSkillPath));
    expect(fs.existsSync(path.join(targetPath, "local-only.txt"))).toBe(false);
    expect(updated.installations.find((item) => item.target === "codex")?.state).toBe("installed");
  });

  it("rejects a target whose linked parent resolves into the managed library", () => {
    const fixture = createManagedSkillFixture();
    const libraryRoot = path.dirname(fixture.managedSkillPath);
    const skillsParent = path.join(fixture.homeDir, ".codex", "skills");
    const libraryEntriesBefore = fs.readdirSync(libraryRoot).sort();
    fs.mkdirSync(path.dirname(skillsParent), { recursive: true });
    fs.symlinkSync(
      libraryRoot,
      skillsParent,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() => fixture.library.updateTargets(
      fixture.managedId,
      ["codex"],
      ["codex"],
    )).toThrow("overlapping managed Skill target");

    expect(fs.lstatSync(skillsParent).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(fixture.managedSkillPath).isDirectory()).toBe(true);
    expect(fs.lstatSync(fixture.managedSkillPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(fixture.managedSkillPath, "SKILL.md"), "utf8"))
      .toBe("# Fixture Skill\n");
    expect(fs.readdirSync(libraryRoot).sort()).toEqual(libraryEntriesBefore);
    expect(fs.readdirSync(libraryRoot).some((entry) =>
      entry.includes(".agent-recall-backup-"))).toBe(false);
  });

  it("rejects divergent targets whose parent directories alias the same physical entry", () => {
    const fixture = createManagedSkillFixture();
    const { sharedSkillsParent, sharedTargetPath } = aliasCodexAndSharedSkillParents(fixture);

    expect(() => fixture.library.updateTargets(fixture.managedId, ["codex"]))
      .toThrow("resolve to the same path");
    expect(fs.existsSync(sharedTargetPath)).toBe(false);

    fs.symlinkSync(
      fixture.managedSkillPath,
      sharedTargetPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasedInstallations = fixture.library.list().skills[0].installations;
    expect(aliasedInstallations.find((item) => item.target === "codex")?.state).toBe("installed");
    expect(aliasedInstallations.find((item) => item.target === "codex-shared")?.state).toBe("installed");

    expect(() => fixture.library.updateTargets(fixture.managedId, ["codex-shared"]))
      .toThrow("resolve to the same path");
    expect(fs.lstatSync(sharedTargetPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(sharedTargetPath)).toBe(fs.realpathSync(fixture.managedSkillPath));
    expect(fs.readdirSync(sharedSkillsParent)).toEqual([fixture.managedId]);
  });

  it("preserves installed aliases while installing an unrelated target", () => {
    const fixture = createManagedSkillFixture();
    const { sharedTargetPath } = aliasCodexAndSharedSkillParents(fixture);
    fs.symlinkSync(
      fixture.managedSkillPath,
      sharedTargetPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const updated = fixture.library.updateTargets(
      fixture.managedId,
      ["codex", "codex-shared", "claude"],
    );

    expect(updated.installations.find((item) => item.target === "codex")?.state).toBe("installed");
    expect(updated.installations.find((item) => item.target === "codex-shared")?.state).toBe("installed");
    expect(updated.installations.find((item) => item.target === "claude")?.state).toBe("installed");
    expect(fs.realpathSync(sharedTargetPath)).toBe(fs.realpathSync(fixture.managedSkillPath));
  });

  it("clears a shared physical link exactly once when every alias is unselected", () => {
    const fixture = createManagedSkillFixture();
    const { sharedSkillsParent, sharedTargetPath } = aliasCodexAndSharedSkillParents(fixture);
    fs.symlinkSync(
      fixture.managedSkillPath,
      sharedTargetPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const updated = fixture.library.updateTargets(fixture.managedId, []);

    expect(updated.installations.find((item) => item.target === "codex")?.state).toBe("not-installed");
    expect(updated.installations.find((item) => item.target === "codex-shared")?.state).toBe("not-installed");
    expect(fs.existsSync(sharedTargetPath)).toBe(false);
    expect(fs.readdirSync(sharedSkillsParent)).toEqual([]);
  });

  it("deletes a managed Skill with installed aliases without unlinking the shared entry twice", () => {
    const fixture = createManagedSkillFixture();
    const { sharedTargetPath } = aliasCodexAndSharedSkillParents(fixture);
    fs.symlinkSync(
      fixture.managedSkillPath,
      sharedTargetPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const deleted = fixture.library.delete(fixture.managedId);

    expect(deleted.skillName).toBe(fixture.managedId);
    expect(deleted.retainedBackupPaths).toEqual([]);
    expect(fs.existsSync(sharedTargetPath)).toBe(false);
    expect(fs.existsSync(fixture.managedSkillPath)).toBe(false);
    expect(fixture.library.list().skills).toEqual([]);
  });

  it("restores every installed target when staging the second target fails during deletion", () => {
    const fixture = createManagedSkillFixture();
    const codexTargetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    const claudeTargetPath = path.join(fixture.homeDir, ".claude", "skills", fixture.managedId);
    fixture.library.updateTargets(fixture.managedId, ["codex", "claude"]);
    const originalRenameSync = mutableFs.renameSync;
    const restoreRenameSync = replaceRenameSync((oldPath, newPath) => {
      if (path.resolve(String(oldPath)) === path.resolve(claudeTargetPath)) {
        throw new Error("simulated second deletion stage failure");
      }
      originalRenameSync(oldPath, newPath);
    });

    try {
      expect(() => fixture.library.delete(fixture.managedId))
        .toThrow("simulated second deletion stage failure");
    } finally {
      restoreRenameSync();
    }

    for (const targetPath of [codexTargetPath, claudeTargetPath]) {
      expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(targetPath)).toBe(fs.realpathSync(fixture.managedSkillPath));
      expect(fs.readdirSync(path.dirname(targetPath)).some((entry) =>
        entry.includes(".agent-recall-backup-"))).toBe(false);
    }
    expect(fs.readFileSync(path.join(fixture.managedSkillPath, "SKILL.md"), "utf8"))
      .toBe("# Fixture Skill\n");
  });

  it("restores an external directory that replaces an owned link during deletion staging", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    fixture.library.updateTargets(fixture.managedId, ["codex"]);
    const originalRenameSync = mutableFs.renameSync;
    let simulatedRace = false;
    const restoreRenameSync = replaceRenameSync((oldPath, newPath) => {
      if (!simulatedRace && path.resolve(String(oldPath)) === path.resolve(targetPath)) {
        simulatedRace = true;
        mutableFs.unlinkSync(targetPath);
        mutableFs.mkdirSync(targetPath);
        mutableFs.writeFileSync(path.join(targetPath, "external.txt"), "external replacement");
      }
      originalRenameSync(oldPath, newPath);
    });

    try {
      expect(() => fixture.library.delete(fixture.managedId))
        .toThrow("changed during deletion");
    } finally {
      restoreRenameSync();
    }

    expect(fs.lstatSync(targetPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(targetPath, "external.txt"), "utf8")).toBe("external replacement");
    expect(fs.readdirSync(path.dirname(targetPath))).toEqual([fixture.managedId]);
    expect(fs.readFileSync(path.join(fixture.managedSkillPath, "SKILL.md"), "utf8"))
      .toBe("# Fixture Skill\n");
  });

  it("restores installed targets when the managed source cannot be staged for deletion", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    fixture.library.updateTargets(fixture.managedId, ["codex"]);
    const originalRenameSync = mutableFs.renameSync;
    const restoreRenameSync = replaceRenameSync((oldPath, newPath) => {
      if (path.resolve(String(oldPath)) === path.resolve(fixture.managedSkillPath)) {
        throw new Error("simulated managed source stage failure");
      }
      originalRenameSync(oldPath, newPath);
    });

    try {
      expect(() => fixture.library.delete(fixture.managedId))
        .toThrow("simulated managed source stage failure");
    } finally {
      restoreRenameSync();
    }

    expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(targetPath)).toBe(fs.realpathSync(fixture.managedSkillPath));
    expect(fs.readFileSync(path.join(fixture.managedSkillPath, "SKILL.md"), "utf8"))
      .toBe("# Fixture Skill\n");
  });

  it("does not restore installed targets when the managed source cannot be restored", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    const metadataPath = path.join(
      path.dirname(fixture.managedSkillPath),
      ".metadata",
      `${fixture.managedId}.json`,
    );
    fixture.library.updateTargets(fixture.managedId, ["codex"]);
    const originalRenameSync = mutableFs.renameSync;
    const restoreRenameSync = replaceRenameSync((oldPath, newPath) => {
      if (path.resolve(String(oldPath)) === path.resolve(metadataPath)) {
        mutableFs.mkdirSync(fixture.managedSkillPath);
        mutableFs.writeFileSync(
          path.join(fixture.managedSkillPath, "external.txt"),
          "concurrent replacement",
        );
        throw new Error("simulated metadata stage failure");
      }
      originalRenameSync(oldPath, newPath);
    });

    try {
      expect(() => fixture.library.delete(fixture.managedId))
        .toThrow("fully restore its previous state");
    } finally {
      restoreRenameSync();
    }

    expect(fs.readFileSync(path.join(fixture.managedSkillPath, "external.txt"), "utf8"))
      .toBe("concurrent replacement");
    expect(fs.existsSync(targetPath)).toBe(false);
    const linkBackupPath = path.join(
      path.dirname(targetPath),
      fs.readdirSync(path.dirname(targetPath)).find((entry) =>
        entry.includes(".agent-recall-backup-"))!,
    );
    expect(fs.lstatSync(linkBackupPath).isSymbolicLink()).toBe(true);
    const sourceBackupPath = path.join(
      fixture.fixtureRoot,
      fs.readdirSync(fixture.fixtureRoot).find((entry) =>
        entry.startsWith(".library.agent-recall-delete-")
        && !entry.endsWith(".metadata"))!,
    );
    expect(fs.readFileSync(path.join(sourceBackupPath, "SKILL.md"), "utf8"))
      .toBe("# Fixture Skill\n");
  });

  it("reports a retained managed source when deletion cleanup fails", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    fixture.library.updateTargets(fixture.managedId, ["codex"]);
    const originalRmSync = mutableFs.rmSync;
    const restoreRmSync = replaceRmSync((rmPath, options) => {
      if (String(rmPath).includes(".agent-recall-delete-")) {
        throw new Error("simulated deletion cleanup failure");
      }
      originalRmSync(rmPath, options);
    });

    let deleted;
    try {
      deleted = fixture.library.delete(fixture.managedId);
    } finally {
      restoreRmSync();
    }

    expect(deleted.skillName).toBe(fixture.managedId);
    expect(deleted.retainedBackupPaths).toHaveLength(1);
    expect(deleted.retainedBackupPaths[0]).toContain(".agent-recall-delete-");
    expect(fs.readFileSync(path.join(deleted.retainedBackupPaths[0], "SKILL.md"), "utf8"))
      .toBe("# Fixture Skill\n");
    expect(fs.existsSync(fixture.managedSkillPath)).toBe(false);
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fixture.library.list().skills).toEqual([]);
  });

  it("reports an installed-link backup when deletion cleanup fails", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    fixture.library.updateTargets(fixture.managedId, ["codex"]);
    const originalUnlinkSync = mutableFs.unlinkSync;
    const restoreUnlinkSync = replaceUnlinkSync((unlinkPath) => {
      if (String(unlinkPath).includes(".agent-recall-backup-")) {
        throw new Error("simulated link cleanup failure");
      }
      originalUnlinkSync(unlinkPath);
    });

    let deleted;
    try {
      deleted = fixture.library.delete(fixture.managedId);
    } finally {
      restoreUnlinkSync();
    }

    expect(deleted.retainedBackupPaths).toHaveLength(1);
    expect(deleted.retainedBackupPaths[0]).toContain(".agent-recall-backup-");
    expect(fs.lstatSync(deleted.retainedBackupPaths[0]).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(fixture.managedSkillPath)).toBe(false);
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("does not report a backup removed before cleanup throws", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    fixture.library.updateTargets(fixture.managedId, ["codex"]);
    const originalUnlinkSync = mutableFs.unlinkSync;
    const restoreUnlinkSync = replaceUnlinkSync((unlinkPath) => {
      originalUnlinkSync(unlinkPath);
      if (String(unlinkPath).includes(".agent-recall-backup-")) {
        throw new Error("simulated late link cleanup failure");
      }
    });

    let deleted;
    try {
      deleted = fixture.library.delete(fixture.managedId);
    } finally {
      restoreUnlinkSync();
    }

    expect(deleted.retainedBackupPaths).toEqual([]);
    expect(fs.existsSync(fixture.managedSkillPath)).toBe(false);
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("refuses to delete a managed Skill when an installed target cannot be inspected", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    fixture.library.updateTargets(fixture.managedId, ["codex"]);
    const originalLstatSync = mutableFs.lstatSync;
    const restoreLstatSync = replaceLstatSync(((
      inspectedPath: fs.PathLike,
      options?: fs.StatOptions,
    ) => {
      if (path.resolve(String(inspectedPath)) === path.resolve(targetPath)) {
        const error = new Error("simulated access denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalLstatSync(inspectedPath, options);
    }) as typeof fs.lstatSync);

    try {
      expect(() => fixture.library.delete(fixture.managedId)).toThrow("simulated access denied");
    } finally {
      restoreLstatSync();
    }

    expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(targetPath)).toBe(fs.realpathSync(fixture.managedSkillPath));
    expect(fs.existsSync(path.join(fixture.managedSkillPath, "SKILL.md"))).toBe(true);
  });

  it("refuses to delete a managed Skill when an installed target cannot be resolved", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    fixture.library.updateTargets(fixture.managedId, ["codex"]);
    const originalRealpathSync = mutableFs.realpathSync;
    const restoreRealpathSync = replaceRealpathSync(((...args: unknown[]) => {
      if (path.resolve(String(args[0])) === path.resolve(targetPath)) {
        const error = new Error("simulated realpath access denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return Reflect.apply(originalRealpathSync, mutableFs, args);
    }) as typeof fs.realpathSync);

    try {
      expect(() => fixture.library.delete(fixture.managedId)).toThrow("simulated realpath access denied");
    } finally {
      restoreRealpathSync();
    }

    expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(targetPath)).toBe(fs.realpathSync(fixture.managedSkillPath));
    expect(fs.existsSync(path.join(fixture.managedSkillPath, "SKILL.md"))).toBe(true);
  });

  it("creates one shared physical link when every alias is selected", () => {
    const fixture = createManagedSkillFixture();
    const { sharedTargetPath } = aliasCodexAndSharedSkillParents(fixture);
    const originalSymlinkSync = mutableFs.symlinkSync;
    let symlinkCalls = 0;
    const restoreSymlinkSync = replaceSymlinkSync((target, linkPath, type) => {
      symlinkCalls += 1;
      originalSymlinkSync(target, linkPath, type);
    });

    let updated;
    try {
      updated = fixture.library.updateTargets(fixture.managedId, ["codex", "codex-shared"]);
    } finally {
      restoreSymlinkSync();
    }

    expect(symlinkCalls).toBe(1);
    expect(updated.installations.find((item) => item.target === "codex")?.state).toBe("installed");
    expect(updated.installations.find((item) => item.target === "codex-shared")?.state).toBe("installed");
    expect(fs.realpathSync(sharedTargetPath)).toBe(fs.realpathSync(fixture.managedSkillPath));
  });

  it("requires explicit force authorization for every selected conflicting alias", () => {
    const fixture = createManagedSkillFixture();
    const { sharedTargetPath } = aliasCodexAndSharedSkillParents(fixture);
    fs.mkdirSync(sharedTargetPath);
    fs.writeFileSync(path.join(sharedTargetPath, "local-only.txt"), "shared conflict");

    expect(() => fixture.library.updateTargets(
      fixture.managedId,
      ["codex", "codex-shared"],
      ["codex"],
    )).toThrow("codex-shared Skill target conflicts");
    expect(fs.readFileSync(path.join(sharedTargetPath, "local-only.txt"), "utf8")).toBe("shared conflict");

    const updated = fixture.library.updateTargets(
      fixture.managedId,
      ["codex", "codex-shared"],
      ["codex", "codex-shared"],
    );
    expect(updated.installations.find((item) => item.target === "codex")?.state).toBe("installed");
    expect(updated.installations.find((item) => item.target === "codex-shared")?.state).toBe("installed");
    expect(fs.existsSync(path.join(sharedTargetPath, "local-only.txt"))).toBe(false);
  });

  it("installs a normal target and force replaces a conflicting target in one update", () => {
    const fixture = createManagedSkillFixture();
    const codexTargetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    const claudeTargetPath = path.join(fixture.homeDir, ".claude", "skills", fixture.managedId);
    fs.mkdirSync(path.dirname(codexTargetPath), { recursive: true });
    fs.writeFileSync(codexTargetPath, "conflicting file");

    const updated = fixture.library.updateTargets(
      fixture.managedId,
      ["codex", "claude"],
      ["codex"],
    );

    expect(fs.lstatSync(codexTargetPath).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(claudeTargetPath).isSymbolicLink()).toBe(true);
    expect(updated.installations.find((item) => item.target === "codex")?.state).toBe("installed");
    expect(updated.installations.find((item) => item.target === "claude")?.state).toBe("installed");
  });

  it.each(["wrong", "dangling"] as const)(
    "force replaces a %s symlink conflict",
    (kind) => {
      const fixture = createManagedSkillFixture();
      const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
      const otherDirectory = path.join(fixture.fixtureRoot, "other-skill");
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.mkdirSync(otherDirectory, { recursive: true });
      fs.symlinkSync(
        otherDirectory,
        targetPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      if (kind === "dangling") fs.rmSync(otherDirectory, { recursive: true });

      fixture.library.updateTargets(fixture.managedId, ["codex"], ["codex"]);

      expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(targetPath)).toBe(fs.realpathSync(fixture.managedSkillPath));
    },
  );

  it("rejects an unforced conflict without changing it or other selected targets", () => {
    const fixture = createManagedSkillFixture();
    const codexTargetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    const claudeTargetPath = path.join(fixture.homeDir, ".claude", "skills", fixture.managedId);
    fs.mkdirSync(codexTargetPath, { recursive: true });
    fs.writeFileSync(path.join(codexTargetPath, "local-only.txt"), "untouched");

    expect(() => fixture.library.updateTargets(
      fixture.managedId,
      ["codex", "claude"],
    )).toThrow("requires explicit force installation");

    expect(fs.lstatSync(codexTargetPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(codexTargetPath, "local-only.txt"), "utf8")).toBe("untouched");
    expect(fs.existsSync(claudeTargetPath)).toBe(false);
  });

  it("rejects forced targets that are unknown or not selected", () => {
    const fixture = createManagedSkillFixture();
    const claudeTargetPath = path.join(fixture.homeDir, ".claude", "skills", fixture.managedId);

    expect(() => fixture.library.updateTargets(
      fixture.managedId,
      ["claude"],
      ["codex"],
    )).toThrow("must also be selected");
    expect(() => fixture.library.updateTargets(
      fixture.managedId,
      ["claude"],
      ["unknown" as SkillInstallTarget],
    )).toThrow("Unknown Skill installation target");
    expect(fs.existsSync(claudeTargetPath)).toBe(false);
  });

  it("restores the original conflict when managed link creation fails", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    fs.mkdirSync(targetPath, { recursive: true });
    fs.writeFileSync(path.join(targetPath, "local-only.txt"), "restore me");
    const restoreSymlinkSync = replaceSymlinkSync(() => {
      throw new Error("simulated symlink failure");
    });

    try {
      expect(() => fixture.library.updateTargets(
        fixture.managedId,
        ["codex"],
        ["codex"],
      )).toThrow("simulated symlink failure");
    } finally {
      restoreSymlinkSync();
    }

    expect(fs.lstatSync(targetPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(targetPath, "local-only.txt"), "utf8")).toBe("restore me");
    expect(fs.readdirSync(path.dirname(targetPath))).toEqual([fixture.managedId]);
    expect(
      fixture.library.list().skills[0].installations.find((item) => item.target === "codex")?.state,
    ).toBe("conflict");
  });

  it("rolls back a normal install when a later forced target fails", () => {
    const fixture = createManagedSkillFixture();
    const codexTargetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    const claudeTargetPath = path.join(fixture.homeDir, ".claude", "skills", fixture.managedId);
    fs.mkdirSync(claudeTargetPath, { recursive: true });
    fs.writeFileSync(path.join(claudeTargetPath, "local-only.txt"), "restore mixed conflict");
    const originalSymlinkSync = mutableFs.symlinkSync;
    let symlinkCalls = 0;
    const restoreSymlinkSync = replaceSymlinkSync((target, linkPath, type) => {
      symlinkCalls += 1;
      if (symlinkCalls === 2) throw new Error("simulated second symlink failure");
      originalSymlinkSync(target, linkPath, type);
    });

    try {
      expect(() => fixture.library.updateTargets(
        fixture.managedId,
        ["codex", "claude"],
        ["claude"],
      )).toThrow("simulated second symlink failure");
    } finally {
      restoreSymlinkSync();
    }

    expect(fs.existsSync(codexTargetPath)).toBe(false);
    expect(fs.lstatSync(claudeTargetPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(claudeTargetPath, "local-only.txt"), "utf8"))
      .toBe("restore mixed conflict");
  });

  it("restores every conflict when the second forced target fails", () => {
    const fixture = createManagedSkillFixture();
    const codexTargetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    const claudeTargetPath = path.join(fixture.homeDir, ".claude", "skills", fixture.managedId);
    fs.mkdirSync(codexTargetPath, { recursive: true });
    fs.mkdirSync(claudeTargetPath, { recursive: true });
    fs.writeFileSync(path.join(codexTargetPath, "local-only.txt"), "restore codex");
    fs.writeFileSync(path.join(claudeTargetPath, "local-only.txt"), "restore claude");
    const originalSymlinkSync = mutableFs.symlinkSync;
    let symlinkCalls = 0;
    const restoreSymlinkSync = replaceSymlinkSync((target, linkPath, type) => {
      symlinkCalls += 1;
      if (symlinkCalls === 2) throw new Error("simulated second force failure");
      originalSymlinkSync(target, linkPath, type);
    });

    try {
      expect(() => fixture.library.updateTargets(
        fixture.managedId,
        ["codex", "claude"],
        ["codex", "claude"],
      )).toThrow("simulated second force failure");
    } finally {
      restoreSymlinkSync();
    }

    expect(fs.lstatSync(codexTargetPath).isDirectory()).toBe(true);
    expect(fs.lstatSync(claudeTargetPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(codexTargetPath, "local-only.txt"), "utf8")).toBe("restore codex");
    expect(fs.readFileSync(path.join(claudeTargetPath, "local-only.txt"), "utf8")).toBe("restore claude");
  });

  it("restores an owned link staged for removal when a later install fails", () => {
    const fixture = createManagedSkillFixture();
    const codexTargetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    const claudeTargetPath = path.join(fixture.homeDir, ".claude", "skills", fixture.managedId);
    fixture.library.updateTargets(fixture.managedId, ["codex"]);
    const restoreSymlinkSync = replaceSymlinkSync(() => {
      throw new Error("simulated replacement install failure");
    });

    try {
      expect(() => fixture.library.updateTargets(
        fixture.managedId,
        ["claude"],
      )).toThrow("simulated replacement install failure");
    } finally {
      restoreSymlinkSync();
    }

    expect(fs.lstatSync(codexTargetPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(codexTargetPath)).toBe(fs.realpathSync(fixture.managedSkillPath));
    expect(fs.existsSync(claudeTargetPath)).toBe(false);
  });

  it("preserves a path that replaces an owned link immediately before removal staging", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    fixture.library.updateTargets(fixture.managedId, ["codex"]);
    const originalRenameSync = mutableFs.renameSync;
    let simulatedRace = false;
    const restoreRenameSync = replaceRenameSync((oldPath, newPath) => {
      if (!simulatedRace && String(oldPath) === targetPath) {
        simulatedRace = true;
        mutableFs.unlinkSync(targetPath);
        mutableFs.mkdirSync(targetPath);
        mutableFs.writeFileSync(path.join(targetPath, "external.txt"), "appeared during update");
      }
      originalRenameSync(oldPath, newPath);
    });

    try {
      expect(() => fixture.library.updateTargets(fixture.managedId, []))
        .toThrow("changed during the update");
    } finally {
      restoreRenameSync();
    }

    expect(fs.lstatSync(targetPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(targetPath, "external.txt"), "utf8")).toBe("appeared during update");
    expect(fs.readdirSync(path.dirname(targetPath))).toEqual([fixture.managedId]);
  });

  it.each(["ENOTDIR", "ELOOP"] as const)(
    "keeps unrelated targets usable when an install root reports %s",
    (failureCode) => {
      const fixture = createManagedSkillFixture();
      const codexRoot = path.join(fixture.homeDir, ".codex");
      const codexSkillsRoot = path.join(codexRoot, "skills");
      const claudeTargetPath = path.join(fixture.homeDir, ".claude", "skills", fixture.managedId);
      fs.mkdirSync(codexRoot, { recursive: true });
      if (failureCode === "ENOTDIR") {
        fs.writeFileSync(codexSkillsRoot, "not a directory");
      } else {
        fs.symlinkSync(
          codexSkillsRoot,
          codexSkillsRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
      }

      const listed = fixture.library.list().skills[0];
      expect(listed.installations.find((item) => item.target === "codex")?.state)
        .toBe(process.platform === "win32" ? "not-installed" : "conflict");

      const updated = fixture.library.updateTargets(fixture.managedId, ["claude"]);
      expect(updated.installations.find((item) => item.target === "claude")?.state).toBe("installed");

      let requestedError: NodeJS.ErrnoException | undefined;
      try {
        fixture.library.updateTargets(fixture.managedId, ["codex"], ["codex"]);
      } catch (error) {
        requestedError = error as NodeJS.ErrnoException;
      }
      if (process.platform === "win32") {
        expect(requestedError).toBeInstanceOf(Error);
      } else {
        expect(requestedError?.code).toBe(failureCode);
      }
      expect(fs.lstatSync(claudeTargetPath).isSymbolicLink()).toBe(true);
      if (failureCode === "ENOTDIR") {
        expect(fs.readFileSync(codexSkillsRoot, "utf8")).toBe("not a directory");
      } else {
        expect(fs.lstatSync(codexSkillsRoot).isSymbolicLink()).toBe(true);
      }
    },
  );

  it.runIf(
    process.platform !== "win32"
    && typeof process.getuid === "function"
    && process.getuid() !== 0,
  )("keeps unrelated targets usable when an install root is inaccessible", () => {
    const fixture = createManagedSkillFixture();
    const codexRoot = path.join(fixture.homeDir, ".codex");
    const codexSkillsRoot = path.join(codexRoot, "skills");
    const claudeTargetPath = path.join(fixture.homeDir, ".claude", "skills", fixture.managedId);
    fs.mkdirSync(codexSkillsRoot, { recursive: true });
    fs.chmodSync(codexRoot, 0);

    let requestedError: NodeJS.ErrnoException | undefined;
    try {
      const listed = fixture.library.list().skills[0];
      expect(listed.installations.find((item) => item.target === "codex")?.state).toBe("conflict");
      const updated = fixture.library.updateTargets(fixture.managedId, ["claude"]);
      expect(updated.installations.find((item) => item.target === "claude")?.state).toBe("installed");
      try {
        fixture.library.updateTargets(fixture.managedId, ["codex"], ["codex"]);
      } catch (error) {
        requestedError = error as NodeJS.ErrnoException;
      }
    } finally {
      fs.chmodSync(codexRoot, 0o700);
    }

    expect(requestedError?.code).toBe("EACCES");
    expect(fs.lstatSync(claudeTargetPath).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(codexSkillsRoot)).toEqual([]);
  });

  it("keeps the committed target state when hidden backup cleanup fails", () => {
    const fixture = createManagedSkillFixture();
    const targetPath = path.join(fixture.homeDir, ".codex", "skills", fixture.managedId);
    fs.mkdirSync(targetPath, { recursive: true });
    fs.writeFileSync(path.join(targetPath, "local-only.txt"), "cleanup failure fixture");
    const originalRmSync = mutableFs.rmSync;
    const restoreRmSync = replaceRmSync((rmPath, options) => {
      if (String(rmPath).includes(".agent-recall-backup-")) {
        throw new Error("simulated backup cleanup failure");
      }
      originalRmSync(rmPath, options);
    });

    let updated;
    try {
      updated = fixture.library.updateTargets(fixture.managedId, ["codex"], ["codex"]);
    } finally {
      restoreRmSync();
    }

    expect(updated.installations.find((item) => item.target === "codex")?.state).toBe("installed");
    expect(updated.retainedBackupPaths).toHaveLength(1);
    expect(updated.retainedBackupPaths[0]).toContain(".agent-recall-backup-");
    expect(fs.lstatSync(updated.retainedBackupPaths[0]).isDirectory()).toBe(true);
    expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(path.dirname(targetPath)).some((entry) =>
      entry.includes(".agent-recall-backup-"))).toBe(true);
  });
});
