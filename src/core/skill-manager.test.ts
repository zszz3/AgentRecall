import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deleteInstalledSkill,
  installRemoteSkillLocally,
  listInstalledSkills,
  skillProjectDirsFromIndexedProjects,
} from "./skill-manager";
import type { RemoteSkill } from "./skill-sync";

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
    writeSkill(
      path.join(projectDir, ".codex", "skills"),
      "codex-project-guide",
      ["---", "name: codex-project-guide", "description: Codex project conventions", "---", "", "# Codex Project"].join("\n"),
    );
    const snapshot = listInstalledSkills({ homeDir, codexHome, projectDirs: [projectDir] });

    expect(snapshot.skills.map((skill) => ({ name: skill.name, description: skill.description, agent: skill.agent, source: skill.source }))).toEqual([
      { name: "codex-project-guide", description: "Codex project conventions", agent: "codex", source: "codex-project" },
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
        expect.objectContaining({ source: "codex-project", exists: true, skillCount: 1 }),
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

  it("includes Claude Code plugin skills from marketplace cache", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-marketplace-"));
    const pluginsDir = path.join(homeDir, ".claude", "plugins");
    writeSkill(
      path.join(pluginsDir, "marketplaces", "official", "plugins", "plugin-dev", "skills"),
      "skill-development",
      ["---", "name: skill-development", "description: Build Claude skills", "---", "", "# Skill Development"].join("\n"),
    );
    writeSkill(
      path.join(pluginsDir, "marketplaces", "official", "external_plugins", "discord", "skills"),
      "configure",
      ["---", "name: discord-configure", "description: Configure Discord", "---", "", "# Configure"].join("\n"),
    );

    const snapshot = listInstalledSkills({ homeDir, codexHome: path.join(homeDir, ".codex"), projectDirs: [] });

    expect(snapshot.skills.map((skill) => ({ name: skill.name, agent: skill.agent, source: skill.source }))).toEqual([
      { name: "discord-configure", agent: "claude", source: "claude-plugin" },
      { name: "skill-development", agent: "claude", source: "claude-plugin" },
    ]);
    expect(snapshot.roots).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "claude-plugin", exists: true, skillCount: 2 })]),
    );

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("derives skill project directories from indexed local projects", () => {
    const dirs = skillProjectDirsFromIndexedProjects(
      [
        { path: "/repo/app", environmentId: "local" },
        { path: "/repo/app", environmentId: "local" },
        { path: "/remote/app", environmentId: "ssh-prod" },
        { path: "  ", environmentId: "local" },
      ],
      ["/app/cwd"],
    );

    expect(dirs).toEqual(["/app/cwd", "/repo/app"]);
  });

  it("does not treat agent home directories as project skill roots", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-home-project-"));
    writeSkill(
      path.join(homeDir, ".codex", "skills"),
      "global-codex",
      ["---", "name: global-codex", "description: Global Codex", "---", "", "# Global"].join("\n"),
    );

    const dirs = skillProjectDirsFromIndexedProjects(
      [
        { path: homeDir, environmentId: "local" },
        { path: path.join(homeDir, ".codex"), environmentId: "local" },
      ],
      [],
      homeDir,
    );
    const snapshot = listInstalledSkills({ homeDir, codexHome: path.join(homeDir, ".codex"), projectDirs: dirs });

    expect(dirs).toEqual([]);
    expect(snapshot.skills.map((skill) => ({ name: skill.name, source: skill.source }))).toEqual([
      { name: "global-codex", source: "codex-user" },
    ]);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("discovers nested project directories that contain skills", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-nested-project-"));
    const projectDir = path.join(homeDir, "project");
    writeSkill(
      path.join(projectDir, "packages", "agent-tools", ".claude", "skills"),
      "nested-guide",
      ["---", "name: nested-guide", "description: Nested conventions", "---", "", "# Nested"].join("\n"),
    );

    const dirs = skillProjectDirsFromIndexedProjects([{ path: projectDir, environmentId: "local" }], []);
    const snapshot = listInstalledSkills({ homeDir, codexHome: path.join(homeDir, ".codex"), projectDirs: dirs });

    expect(dirs).toEqual([projectDir, path.join(projectDir, "packages", "agent-tools")]);
    expect(snapshot.skills.map((skill) => ({ name: skill.name, source: skill.source }))).toEqual([
      { name: "nested-guide", source: "claude-project" },
    ]);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("discovers ancestor project directories that contain skills", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-ancestor-project-"));
    const projectDir = path.join(homeDir, "project");
    const serviceDir = path.join(projectDir, "services", "api");
    fs.mkdirSync(serviceDir, { recursive: true });
    writeSkill(
      path.join(projectDir, ".codex", "skills"),
      "repo-guide",
      ["---", "name: repo-guide", "description: Repository conventions", "---", "", "# Repo"].join("\n"),
    );

    const dirs = skillProjectDirsFromIndexedProjects([{ path: serviceDir, environmentId: "local" }], []);
    const snapshot = listInstalledSkills({ homeDir, codexHome: path.join(homeDir, ".codex"), projectDirs: dirs });

    expect(dirs).toEqual([serviceDir, projectDir]);
    expect(snapshot.skills.map((skill) => ({ name: skill.name, source: skill.source }))).toEqual([
      { name: "repo-guide", source: "codex-project" },
    ]);

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
        expect.objectContaining({ source: "codex-project", exists: false, skillCount: 0 }),
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

  it("installs a remote Codex skill into the user skill root", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-install-codex-"));
    const codexHome = path.join(homeDir, ".codex");
    const remoteSkill: RemoteSkill = {
      id: "remote-review",
      name: "Review Code!",
      description: "Review code changes",
      agent: "codex",
      source: "codex-user",
      markdown: "---\nname: Review Code!\ndescription: Review code changes\n---\n\n# Review",
      localFingerprint: "fp",
      uploadedFromPath: "/old/SKILL.md",
      createdAt: "2026-06-29T10:00:00.000Z",
      updatedAt: "2026-06-29T10:01:00.000Z",
      version: 1,
      metadata: {},
    };

    const result = installRemoteSkillLocally(remoteSkill, { homeDir, codexHome });

    expect(result).toEqual({
      installedPath: path.join(codexHome, "skills", "review-code", "SKILL.md"),
      directoryPath: path.join(codexHome, "skills", "review-code"),
      overwritten: false,
    });
    expect(fs.readFileSync(result.installedPath, "utf8")).toBe(remoteSkill.markdown);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("installs a remote Claude skill into the user skill root and reports overwrite", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skills-install-claude-"));
    const remoteSkill: RemoteSkill = {
      id: "remote-deploy",
      name: "deploy-helper",
      description: "Deploy safely",
      agent: "claude",
      source: "claude-user",
      markdown: "# Deploy v2",
      localFingerprint: "fp",
      uploadedFromPath: "/old/SKILL.md",
      createdAt: "2026-06-29T10:00:00.000Z",
      updatedAt: "2026-06-29T10:01:00.000Z",
      version: 2,
      metadata: {},
    };
    const target = path.join(homeDir, ".claude", "skills", "deploy-helper", "SKILL.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "# Deploy v1", "utf8");

    const result = installRemoteSkillLocally(remoteSkill, { homeDir });

    expect(result.installedPath).toBe(target);
    expect(result.overwritten).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("# Deploy v2");

    fs.rmSync(homeDir, { recursive: true, force: true });
  });
});
