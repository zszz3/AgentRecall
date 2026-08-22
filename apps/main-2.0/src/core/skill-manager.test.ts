import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listInstalledSkills } from "./skill-manager";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("listInstalledSkills", () => {
  it("can limit local candidates to the Codex, Claude, and shared user roots", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-local-skill-scan-"));
    temporaryDirectories.push(homeDir);
    const codexHome = path.join(homeDir, ".codex");
    const projectDir = path.join(homeDir, "project");

    writeSkill(path.join(codexHome, "skills", "codex-user"), "Codex user");
    writeSkill(path.join(codexHome, "skills", ".system", "codex-system"), "Codex system");
    writeSkill(path.join(homeDir, ".claude", "skills", "claude-user"), "Claude user");
    writeSkill(path.join(homeDir, ".agents", "skills", "shared"), "Shared");
    writeSkill(path.join(homeDir, ".qoder", "skills", "qoder-user"), "Qoder user");
    writeSkill(path.join(projectDir, ".codex", "skills", "project-skill"), "Project Skill");
    writeSkill(
      path.join(homeDir, ".claude", "plugins", "marketplaces", "official", "plugins", "example", "skills", "plugin-skill"),
      "Plugin Skill",
    );

    const snapshot = listInstalledSkills({
      homeDir,
      codexHome,
      projectDirs: [projectDir],
      localAgentRootsOnly: true,
    });

    expect(snapshot.skills.map((skill) => skill.name)).toEqual([
      "Claude user",
      "Codex system",
      "Codex user",
      "Shared",
    ]);
    expect(snapshot.roots.map((root) => root.source)).toEqual([
      "codex-user",
      "codex-system",
      "codex-shared",
      "claude-user",
    ]);
  });

  it("skips only root-level managed Skill backup directories", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-skill-scan-"));
    temporaryDirectories.push(homeDir);
    const codexHome = path.join(homeDir, ".codex");
    const skillsRoot = path.join(codexHome, "skills");
    const backupUuid = "123e4567-e89b-42d3-a456-426614174000";
    const nestedBackupUuid = "223e4567-e89b-42d3-a456-426614174000";

    writeSkill(
      path.join(skillsRoot, `.managed-skill.agent-recall-backup-${backupUuid}`),
      "Root backup",
    );
    writeSkill(
      path.join(skillsRoot, `.nested-backup.agent-recall-backup-${nestedBackupUuid}`, "child"),
      "Nested inside root backup",
    );
    writeSkill(
      path.join(skillsRoot, `.Remote-Skill.agent-recall-backup-4321-${backupUuid}`),
      "PID backup",
    );
    writeSkill(path.join(skillsRoot, ".hidden-skill"), "Hidden Skill");
    writeSkill(
      path.join(skillsRoot, ".similar.agent-recall-backup-not-a-uuid"),
      "Similar non-backup Skill",
    );
    writeSkill(
      path.join(skillsRoot, ".similar.agent-recall-backup-123e4567-e89b-12d3-a456-426614174000"),
      "Non-v4 backup-like Skill",
    );
    writeSkill(
      path.join(skillsRoot, ".similar.agent-recall-backup-123E4567-E89B-42D3-A456-426614174000"),
      "Uppercase backup-like Skill",
    );
    writeSkill(
      path.join(skillsRoot, "collection", `.nested.agent-recall-backup-${backupUuid}`),
      "Nested backup",
    );
    writeSkill(path.join(skillsRoot, "collection", ".nested-hidden-skill"), "Nested hidden Skill");

    const snapshot = listInstalledSkills({
      homeDir,
      codexHome,
      projectDirs: [],
      claudePluginsDir: path.join(homeDir, ".claude", "plugins"),
    });

    expect(snapshot.skills.map((skill) => skill.name)).toEqual([
      "Hidden Skill",
      "Nested hidden Skill",
      "Non-v4 backup-like Skill",
      "Similar non-backup Skill",
      "Uppercase backup-like Skill",
    ]);
    expect(snapshot.skills.some((skill) => skill.name === "Root backup")).toBe(false);
    expect(snapshot.skills.some((skill) => skill.name === "Nested inside root backup")).toBe(false);
    expect(snapshot.skills.some((skill) => skill.name === "PID backup")).toBe(false);
    expect(snapshot.skills.some((skill) => skill.name === "Nested backup")).toBe(false);
    expect(snapshot.roots.find((root) => root.source === "codex-user")?.skillCount).toBe(5);
  });
});

function writeSkill(directoryPath: string, name: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.writeFileSync(
    path.join(directoryPath, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n---\n# ${name}\n`,
    "utf8",
  );
}
