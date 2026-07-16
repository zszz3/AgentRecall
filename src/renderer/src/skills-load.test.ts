import { describe, expect, it } from "vitest";
import type { InstalledSkillsSnapshot } from "../../core/skill-manager";
import type { SkillSyncSnapshot } from "../../core/skill-sync";
import { loadSkillsPanelData } from "./skills-load";

const installedSkills: InstalledSkillsSnapshot = {
  skills: [
    {
      id: "codex-user:/tmp/.codex/skills/review-code/SKILL.md",
      name: "review-code",
      description: "Review changes",
      agent: "codex",
      source: "codex-user",
      path: "/tmp/.codex/skills/review-code/SKILL.md",
      directoryPath: "/tmp/.codex/skills/review-code",
      rootPath: "/tmp/.codex/skills",
      markdown: "# Review",
      mtimeMs: 100,
      usageCount: 0,
      lastUsedAt: null,
    },
  ],
  roots: [],
  scannedAt: 100,
};

const fallbackSyncSnapshot: SkillSyncSnapshot = {
  status: {
    kind: "unconfigured",
    setupSql: "setup sql",
    remediation: "settings",
    message: "Configure Supabase sync.",
  },
  remoteSkillGroups: [],
  bindings: [{ localSkillPath: "/tmp/local/SKILL.md", remoteSkillId: "remote-1", remoteUpdatedAt: "2026-06-29T10:00:00.000Z", remoteVersion: 1, lastSyncedAt: 50, direction: "upload" }],
  scannedAt: 50,
};

describe("skills panel loading", () => {
  it("keeps local skills when the remote sync snapshot fails", async () => {
    const result = await loadSkillsPanelData({
      listSkills: async () => installedSkills,
      getSkillSyncSnapshot: async () => {
        throw new Error("column agent_recall_skills.content_hash does not exist");
      },
      fallbackSyncSnapshot,
    });

    expect(result.installedSkills).toBe(installedSkills);
    expect(result.skillSyncSnapshot).toMatchObject({
      status: {
        kind: "error",
        setupSql: "setup sql",
        remediation: "settings",
        message: "column agent_recall_skills.content_hash does not exist",
      },
      remoteSkillGroups: [],
      bindings: fallbackSyncSnapshot.bindings,
    });
    expect(result.syncError).toBeInstanceOf(Error);
  });
});
