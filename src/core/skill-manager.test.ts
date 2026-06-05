import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteInstalledSkill, listInstalledSkills } from "./skill-manager";

function writeSkill(root: string, directoryName: string, content: string): string {
  const skillDir = path.join(root, directoryName);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, content, "utf8");
  return skillPath;
}

describe("skill manager", () => {
  it("lists Codex, shared, Claude Code, and project skills", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-"));
    const projectDir = path.join(homeDir, "project");
    const codexHome = path.join(homeDir, ".codex");
    const codexSkillPath = writeSkill(
      path.join(codexHome, "skills"),
      "review-code",
      ["---", "name: review-code", "description: Review code changes", "---", "", "# Review"].join("\n"),
    );
    writeSkill(
      path.join(homeDir, ".agents", "skills"),
      "find-skills",
      ["---", "name: find-skills", "description: Discover available skills", "---", "", "# Find"].join("\n"),
    );
    writeSkill(
      path.join(homeDir, ".claude", "skills"),
      "deploy-helper",
      ["---", "name: deploy-helper", "description: Deploy safely", "---", "", "# Deploy"].join("\n"),
    );
    writeSkill(
      path.join(projectDir, ".claude", "skills"),
      "project-guide",
      ["---", "name: project-guide", "description: Project conventions", "---", "", "# Project"].join("\n"),
    );

    const snapshot = listInstalledSkills({ homeDir, codexHome, projectDirs: [projectDir] });

    expect(snapshot.skills.map((skill) => ({ name: skill.name, description: skill.description, agent: skill.agent, source: skill.source }))).toEqual([
      { name: "deploy-helper", description: "Deploy safely", agent: "claude", source: "claude-user" },
      { name: "find-skills", description: "Discover available skills", agent: "codex", source: "codex-shared" },
      { name: "project-guide", description: "Project conventions", agent: "claude", source: "claude-project" },
      { name: "review-code", description: "Review code changes", agent: "codex", source: "codex-user" },
    ]);
    expect(snapshot.skills.find((skill) => skill.name === "review-code")).toMatchObject({
      path: codexSkillPath,
      directoryPath: path.dirname(codexSkillPath),
      markdown: expect.stringContaining("# Review"),
    });
    expect(snapshot.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "codex-user", exists: true, skillCount: 1 }),
        expect.objectContaining({ source: "codex-shared", exists: true, skillCount: 1 }),
        expect.objectContaining({ source: "claude-user", exists: true, skillCount: 1 }),
        expect.objectContaining({ source: "claude-project", exists: true, skillCount: 1 }),
      ]),
    );

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("includes Claude Code plugin skills from installed_plugins.json", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-plugins-"));
    const pluginsDir = path.join(homeDir, ".claude", "plugins");
    const superpowersInstall = path.join(pluginsDir, "cache", "official", "superpowers", "5.1.0");
    const docsInstall = path.join(pluginsDir, "cache", "official", "document-skills", "abc123");
    writeSkill(
      path.join(superpowersInstall, "skills"),
      "brainstorming",
      ["---", "name: brainstorming", "description: Explore intent before building", "---", "", "# Brainstorm"].join("\n"),
    );
    writeSkill(
      path.join(docsInstall, "skills"),
      "pdf",
      ["---", "name: pdf", "description: Work with PDF files", "---", "", "# PDF"].join("\n"),
    );
    fs.writeFileSync(
      path.join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "superpowers@official": [{ scope: "user", installPath: superpowersInstall }],
          "document-skills@official": [{ scope: "user", installPath: docsInstall }],
        },
      }),
      "utf8",
    );

    const snapshot = listInstalledSkills({ homeDir, codexHome: path.join(homeDir, ".codex"), projectDirs: [] });

    expect(snapshot.skills.map((skill) => ({ name: skill.name, agent: skill.agent, source: skill.source }))).toEqual([
      { name: "brainstorming", agent: "claude", source: "claude-plugin" },
      { name: "pdf", agent: "claude", source: "claude-plugin" },
    ]);
    expect(snapshot.roots).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "claude-plugin", exists: true, skillCount: 2 })]),
    );

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("falls back to directory names and reports missing roots", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-fallback-"));
    const codexHome = path.join(homeDir, ".codex");
    writeSkill(path.join(codexHome, "skills"), "plain-skill", "# Plain");

    const snapshot = listInstalledSkills({ homeDir, codexHome, projectDirs: [path.join(homeDir, "missing-project")] });

    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["plain-skill"]);
    expect(snapshot.skills[0]).toMatchObject({ description: "", agent: "codex", source: "codex-user" });
    expect(snapshot.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "claude-user", exists: false, skillCount: 0 }),
        expect.objectContaining({ source: "claude-project", exists: false, skillCount: 0 }),
      ]),
    );

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("deletes a scanned user skill directory", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-delete-"));
    const codexHome = path.join(homeDir, ".codex");
    const skillPath = writeSkill(
      path.join(codexHome, "skills"),
      "old-helper",
      ["---", "name: old-helper", "description: Remove me", "---", "", "# Old"].join("\n"),
    );
    fs.writeFileSync(path.join(path.dirname(skillPath), "notes.txt"), "extra file", "utf8");

    const result = deleteInstalledSkill(skillPath, { homeDir, codexHome, projectDirs: [] });

    expect(result).toEqual({ deletedPath: path.dirname(skillPath), skillName: "old-helper" });
    expect(fs.existsSync(path.dirname(skillPath))).toBe(false);
    expect(listInstalledSkills({ homeDir, codexHome, projectDirs: [] }).skills).toHaveLength(0);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("rejects deleting paths that are not scanned skills", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-delete-outside-"));
    const codexHome = path.join(homeDir, ".codex");
    const outsidePath = writeSkill(path.join(homeDir, "outside"), "not-installed", "# Outside");

    expect(() => deleteInstalledSkill(outsidePath, { homeDir, codexHome, projectDirs: [] })).toThrow("Skill is no longer installed or is outside managed roots.");
    expect(fs.existsSync(path.dirname(outsidePath))).toBe(true);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("rejects deleting Codex system skills", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-delete-system-"));
    const codexHome = path.join(homeDir, ".codex");
    const skillPath = writeSkill(path.join(codexHome, "skills", ".system"), "system-helper", "# System");

    expect(() => deleteInstalledSkill(skillPath, { homeDir, codexHome, projectDirs: [] })).toThrow("Codex system skills cannot be deleted from this app.");
    expect(fs.existsSync(path.dirname(skillPath))).toBe(true);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });
});
