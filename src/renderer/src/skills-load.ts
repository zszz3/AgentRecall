import type { InstalledSkillsSnapshot } from "../../core/skill-manager";
import type { SkillSyncSnapshot } from "../../core/skill-sync";

export interface SkillsPanelLoaders {
  listSkills: () => Promise<InstalledSkillsSnapshot>;
  getSkillSyncSnapshot: () => Promise<SkillSyncSnapshot>;
  fallbackSyncSnapshot: SkillSyncSnapshot;
}

export interface SkillsPanelData {
  installedSkills: InstalledSkillsSnapshot;
  skillSyncSnapshot: SkillSyncSnapshot;
  syncError: Error | null;
}

export async function loadSkillsPanelData({
  listSkills,
  getSkillSyncSnapshot,
  fallbackSyncSnapshot,
}: SkillsPanelLoaders): Promise<SkillsPanelData> {
  const [skillsResult, syncResult] = await Promise.allSettled([listSkills(), getSkillSyncSnapshot()]);
  if (skillsResult.status === "rejected") throw normalizeError(skillsResult.reason);

  if (syncResult.status === "fulfilled") {
    return {
      installedSkills: skillsResult.value,
      skillSyncSnapshot: syncResult.value,
      syncError: null,
    };
  }

  const syncError = normalizeError(syncResult.reason);
  return {
    installedSkills: skillsResult.value,
    skillSyncSnapshot: {
      status: {
        kind: "error",
        setupSql: fallbackSyncSnapshot.status.setupSql,
        message: syncError.message,
      },
      remoteSkillGroups: [],
      bindings: fallbackSyncSnapshot.bindings,
      scannedAt: Date.now(),
    },
    syncError,
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
