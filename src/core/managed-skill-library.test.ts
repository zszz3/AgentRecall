import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedSkillLibrary, managedSkillLinkType } from "./managed-skill-library";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createHarness() {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "agent-recall-managed-skills-"));
  temporaryRoots.push(homeDir);
  const codexHome = path.join(homeDir, ".codex");
  const libraryRoot = path.join(homeDir, "app-data", "skills");
  const library = new ManagedSkillLibrary({
    homeDir,
    codexHome,
    libraryRoot,
    platform: "darwin",
  });
  return { homeDir, codexHome, libraryRoot, library };
}

function writeSkill(directoryPath: string, name: string, description: string, extraFile = true): string {
  mkdirSync(directoryPath, { recursive: true });
  const skillPath = path.join(directoryPath, "SKILL.md");
  writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
  if (extraFile) {
    mkdirSync(path.join(directoryPath, "references"), { recursive: true });
    writeFileSync(path.join(directoryPath, "references", "guide.md"), "Keep this file.\n", "utf8");
  }
  return skillPath;
}

describe("ManagedSkillLibrary local import", () => {
  it("lists existing Agent skills as candidates and copies a selected directory without changing the source", () => {
    const { codexHome, libraryRoot, library } = createHarness();
    const sourceDirectory = path.join(codexHome, "skills", "review-code");
    const sourceSkillPath = writeSkill(sourceDirectory, "review-code", "Review code changes");

    const candidates = library.listImportCandidates([]);
    expect(candidates.skills).toHaveLength(1);
    expect(candidates.skills[0]).toMatchObject({ path: sourceSkillPath, source: "codex-user" });

    const result = library.importLocalSkill(sourceSkillPath, []);
    expect(result).toMatchObject({ status: "imported", managedId: "review-code" });
    expect(readFileSync(path.join(libraryRoot, "review-code", "SKILL.md"), "utf8")).toContain("Review code changes");
    expect(readFileSync(path.join(libraryRoot, "review-code", "references", "guide.md"), "utf8")).toBe("Keep this file.\n");
    expect(existsSync(sourceSkillPath)).toBe(true);

    expect(library.list().skills[0]).toMatchObject({
      managedId: "review-code",
      source: "agent-recall",
      origin: { kind: "local", label: "Codex" },
    });
  });

  it("reuses byte-identical content and rejects a same-id import with different content", () => {
    const { codexHome, library } = createHarness();
    const sourceSkillPath = writeSkill(
      path.join(codexHome, "skills", "review-code"),
      "review-code",
      "Review code changes",
    );

    expect(library.importLocalSkill(sourceSkillPath, [])).toMatchObject({ status: "imported" });
    expect(library.importLocalSkill(sourceSkillPath, [])).toMatchObject({ status: "existing" });

    writeFileSync(sourceSkillPath, "---\nname: review-code\ndescription: Changed\n---\n", "utf8");
    expect(() => library.importLocalSkill(sourceSkillPath, [])).toThrow(/different content/i);
  });

  it("refuses arbitrary paths that are outside the current import candidates", () => {
    const { homeDir, library } = createHarness();
    const arbitrarySkill = writeSkill(path.join(homeDir, "downloads", "unknown"), "unknown", "Unknown");

    expect(() => library.importLocalSkill(arbitrarySkill, [])).toThrow(/available local skill/i);
  });

  it("validates downloaded file paths before writing any managed content", () => {
    const { libraryRoot, library } = createHarness();

    expect(() => library.importFiles({
      suggestedId: "unsafe-skill",
      origin: { kind: "skills-sh", label: "skills.sh", source: "owner/repo", url: "https://skills.sh/owner/repo/unsafe-skill" },
      files: [
        { relativePath: "SKILL.md", contents: "# Unsafe\n" },
        { relativePath: "../outside.txt", contents: "not allowed" },
      ],
    })).toThrow(/unsafe skill file path/i);

    expect(existsSync(path.join(libraryRoot, "unsafe-skill"))).toBe(false);
    expect(existsSync(path.join(libraryRoot, "outside.txt"))).toBe(false);
  });

  it("atomically replaces a managed Skill only through the explicit update operation", () => {
    const { libraryRoot, library } = createHarness();
    library.importFiles({
      suggestedId: "review-code",
      origin: { kind: "remote", label: "Cloud sync" },
      files: [{ relativePath: "SKILL.md", contents: "# Version 1\n" }],
    });

    expect(() => library.importFiles({
      suggestedId: "review-code",
      origin: { kind: "remote", label: "Cloud sync" },
      files: [{ relativePath: "SKILL.md", contents: "# Version 2\n" }],
    })).toThrow(/different content/i);

    const updated = library.replaceFiles({
      suggestedId: "review-code",
      origin: { kind: "remote", label: "Cloud sync" },
      files: [{ relativePath: "SKILL.md", contents: "# Version 2\n" }],
    });
    expect(updated.status).toBe("updated");
    expect(readFileSync(path.join(libraryRoot, "review-code", "SKILL.md"), "utf8")).toBe("# Version 2\n");
  });
});

describe("ManagedSkillLibrary target installation", () => {
  it("preflights target conflicts and updates only links owned by the managed Skill", () => {
    const { homeDir, codexHome, libraryRoot, library } = createHarness();
    const sourceSkillPath = writeSkill(
      path.join(codexHome, "skills", "review-code"),
      "review-code",
      "Review code changes",
    );
    library.importLocalSkill(sourceSkillPath, []);
    const codexTarget = path.join(codexHome, "skills", "review-code");
    const claudeTarget = path.join(homeDir, ".claude", "skills", "review-code");
    const traeTarget = path.join(homeDir, ".trae", "skills", "review-code");
    const managedDirectory = path.join(libraryRoot, "review-code");

    // The original source occupies the Codex target and must never be overwritten.
    expect(() => library.updateTargets("review-code", ["codex", "claude"])).toThrow(/refusing to overwrite/i);
    expect(existsSync(claudeTarget)).toBe(false);
    rmSync(path.dirname(codexTarget), { recursive: true, force: true });

    const installed = library.updateTargets("review-code", ["codex", "claude"]);
    expect(lstatSync(codexTarget).isSymbolicLink()).toBe(true);
    expect(lstatSync(claudeTarget).isSymbolicLink()).toBe(true);
    expect(realpathSync(codexTarget)).toBe(realpathSync(managedDirectory));
    expect(realpathSync(claudeTarget)).toBe(realpathSync(managedDirectory));
    expect(installed.installations).toEqual([
      expect.objectContaining({ target: "codex", state: "installed" }),
      expect.objectContaining({ target: "claude", state: "installed" }),
      expect.objectContaining({ target: "trae", state: "not-installed" }),
    ]);

    mkdirSync(traeTarget, { recursive: true });
    expect(() => library.updateTargets("review-code", ["trae"])).toThrow(/refusing to overwrite/i);
    expect(existsSync(codexTarget)).toBe(true);
    expect(existsSync(claudeTarget)).toBe(true);

    rmSync(traeTarget, { recursive: true, force: true });
    const removed = library.updateTargets("review-code", []);
    expect(existsSync(codexTarget)).toBe(false);
    expect(existsSync(claudeTarget)).toBe(false);
    expect(removed.installations.every((target) => target.state === "not-installed")).toBe(true);
  });

  it("uses directory symlinks on macOS/Linux and Junctions on Windows", () => {
    expect(managedSkillLinkType("darwin")).toBe("dir");
    expect(managedSkillLinkType("linux")).toBe("dir");
    expect(managedSkillLinkType("win32")).toBe("junction");
  });

  it("deletes the managed copy and owned target links without touching conflicts", () => {
    const { homeDir, codexHome, libraryRoot, library } = createHarness();
    const sourceSkillPath = writeSkill(
      path.join(codexHome, "skills", "review-code"),
      "review-code",
      "Review code changes",
    );
    library.importLocalSkill(sourceSkillPath, []);
    rmSync(path.dirname(path.join(codexHome, "skills", "review-code")), { recursive: true, force: true });
    library.updateTargets("review-code", ["codex", "claude"]);

    const traeTarget = path.join(homeDir, ".trae", "skills", "review-code");
    mkdirSync(traeTarget, { recursive: true });
    writeFileSync(path.join(traeTarget, "keep.txt"), "user owned\n", "utf8");

    expect(library.delete("review-code")).toMatchObject({ skillName: "review-code" });
    expect(existsSync(path.join(libraryRoot, "review-code"))).toBe(false);
    expect(existsSync(path.join(codexHome, "skills", "review-code"))).toBe(false);
    expect(existsSync(path.join(homeDir, ".claude", "skills", "review-code"))).toBe(false);
    expect(readFileSync(path.join(traeTarget, "keep.txt"), "utf8")).toBe("user owned\n");
  });
});
