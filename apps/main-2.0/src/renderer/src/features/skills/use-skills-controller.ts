import { useCallback, useEffect, useRef, useState } from "react";
import type { InstalledSkill, InstalledSkillsSnapshot } from "../../../../core/skill-manager";
import type {
  RemoteSkill,
  SkillSyncSnapshot,
  SkillSyncUploadOutcome,
} from "../../../../core/skill-sync";
import type { SkillsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";
import { loadSkillsPanelData } from "../../skills-load";

const EMPTY_SKILLS: InstalledSkillsSnapshot = {
  skills: [],
  roots: [],
  scannedAt: 0,
};

const EMPTY_SKILL_SYNC: SkillSyncSnapshot = {
  status: {
    kind: "unconfigured",
    setupSql: "",
    remediation: "settings",
    message: "Configure Supabase URL and anon key in Settings to sync skills.",
  },
  remoteSkillGroups: [],
  bindings: [],
  scannedAt: 0,
};

export function useSkillsController(language: LanguageMode): {
  snapshot: InstalledSkillsSnapshot;
  syncSnapshot: SkillSyncSnapshot;
  loading: boolean;
  feedback: SkillsFeedback;
  localSnapshot: InstalledSkillsSnapshot | null;
  localLoading: boolean;
  localError: string | null;
  load(options?: { refreshUsage?: boolean; silent?: boolean }): Promise<void>;
  ensureLoaded(): void;
  ensureLocalLoaded(): void;
  refreshLoadedLocal(): void;
  refreshLocal(): Promise<void>;
  deleteSkill(skill: InstalledSkill): Promise<void>;
  upload(skill: InstalledSkill, force?: boolean): Promise<SkillSyncUploadOutcome | null>;
  installRemote(remoteSkillId: string): Promise<void>;
  fetchVersion(remoteSkillId: string): Promise<RemoteSkill>;
  copySetupSql(): Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<InstalledSkillsSnapshot>(EMPTY_SKILLS);
  const [syncSnapshot, setSyncSnapshot] = useState<SkillSyncSnapshot>(EMPTY_SKILL_SYNC);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<SkillsFeedback>(null);
  const [localSnapshot, setLocalSnapshot] = useState<InstalledSkillsSnapshot | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const syncSnapshotRef = useRef<SkillSyncSnapshot>(EMPTY_SKILL_SYNC);
  const loadedRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const localSnapshotRef = useRef<InstalledSkillsSnapshot | null>(null);
  const localLoadPromiseRef = useRef<Promise<void> | null>(null);
  const localLoadErrorVisibleRef = useRef(true);
  const t = useCallback(
    (en: string, zh: string) => localize(language, en, zh),
    [language],
  );

  useEffect(() => {
    syncSnapshotRef.current = syncSnapshot;
  }, [syncSnapshot]);

  const load = useCallback(async (
    options: { refreshUsage?: boolean; silent?: boolean } = {},
  ): Promise<void> => {
    const requestId = ++loadSequenceRef.current;
    const refreshUsage = options.refreshUsage ?? false;
    const silent = options.silent ?? false;
    setLoading(true);
    setFeedback(refreshUsage && !silent
      ? { kind: "running", message: t("Refreshing skill usage...", "正在刷新 Skill 使用统计...") }
      : null);
    try {
      let usageStatus = null;
      let usageError: unknown = null;
      if (refreshUsage) {
        try {
          usageStatus = await window.sessionSearch.refreshSkillUsage();
        } catch (error) {
          usageError = error;
        }
      }
      const {
        skillSyncSnapshot: nextSyncSnapshot,
        syncError,
      } = await loadSkillsPanelData({
        listSkills: () => window.sessionSearch.listSkills(),
        getSkillSyncSnapshot: () => window.sessionSearch.getSkillSyncSnapshot(),
        fallbackSyncSnapshot: syncSnapshotRef.current,
        onInstalledSkillsLoaded: (nextSnapshot) => {
          if (requestId !== loadSequenceRef.current) return;
          loadedRef.current = true;
          setSnapshot(nextSnapshot);
          setLoading(false);
        },
      });
      if (requestId !== loadSequenceRef.current) return;
      loadedRef.current = true;
      setSyncSnapshot(nextSyncSnapshot);
      if (usageError) {
        if (!silent) {
          setFeedback({
            kind: "error",
            message: usageError instanceof Error ? usageError.message : String(usageError),
          });
        }
        return;
      }
      if (syncError) {
        if (!silent) setFeedback({ kind: "error", message: syncError.message });
        return;
      }
      if (usageStatus && !silent) {
        const message = t(
          `Skill usage refreshed. ${usageStatus.refreshed} changed, ${usageStatus.skipped} skipped.`,
          `Skill 使用统计已刷新：${usageStatus.refreshed} 个文件有变化，${usageStatus.skipped} 个未变化。`,
        );
        setFeedback({ kind: "success", message });
        window.setTimeout(() => {
          setFeedback((current) =>
            current?.kind === "success" && current.message === message ? null : current);
        }, 2200);
      }
    } catch (error) {
      if (requestId !== loadSequenceRef.current) return;
      if (!refreshUsage) {
        setSnapshot(EMPTY_SKILLS);
        setSyncSnapshot(EMPTY_SKILL_SYNC);
      }
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (requestId === loadSequenceRef.current) setLoading(false);
    }
  }, [t]);

  const ensureLoaded = useCallback((): void => {
    if (!loadedRef.current) void load({ silent: true });
  }, [load]);

  const loadLocal = useCallback((options: {
    forceRefresh: boolean;
    reloadCachedSnapshot?: boolean;
  }): Promise<void> => {
    if (!options.forceRefresh && localSnapshotRef.current && !options.reloadCachedSnapshot) {
      return Promise.resolve();
    }
    if (localLoadPromiseRef.current) return localLoadPromiseRef.current;

    setLocalLoading(true);
    setLocalError(null);
    localLoadErrorVisibleRef.current = true;
    const request = window.sessionSearch.listSkillImportCandidates(options.forceRefresh)
      .then((nextSnapshot) => {
        localSnapshotRef.current = nextSnapshot;
        setLocalSnapshot(nextSnapshot);
      })
      .catch((error) => {
        if (!localLoadErrorVisibleRef.current) return;
        setLocalError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (localLoadPromiseRef.current !== request) return;
        localLoadPromiseRef.current = null;
        setLocalLoading(false);
      });
    localLoadPromiseRef.current = request;
    return request;
  }, []);

  const ensureLocalLoaded = useCallback((): void => {
    void loadLocal({ forceRefresh: false });
  }, [loadLocal]);

  const refreshLoadedLocal = useCallback((): void => {
    if (!localSnapshotRef.current) return;
    setLocalError(null);
    if (localLoadPromiseRef.current) {
      localLoadErrorVisibleRef.current = false;
      return;
    }
    void loadLocal({ forceRefresh: false, reloadCachedSnapshot: true });
  }, [loadLocal]);

  const refreshLocal = useCallback(
    (): Promise<void> => loadLocal({ forceRefresh: true }),
    [loadLocal],
  );

  const deleteSkill = useCallback(async (skill: InstalledSkill): Promise<void> => {
    setLoading(true);
    setFeedback({
      kind: "running",
      message: t(`Deleting ${skill.name}...`, `正在删除 ${skill.name}...`),
    });
    try {
      const result = await window.sessionSearch.deleteSkill(skill.path);
      const retainedBackupMessage = result.retainedBackupPaths.length > 0
        ? t(
            `Deleted ${result.skillName}, but a staged backup could not be removed. Backup: ${result.retainedBackupPaths.join(", ")}`,
            `已删除 ${result.skillName}，但暂存备份未能删除。备份位置：${result.retainedBackupPaths.join("、")}`,
          )
        : null;
      if (retainedBackupMessage) {
        setFeedback({
          kind: "warning",
          message: retainedBackupMessage,
        });
      }
      try {
        const [nextSnapshot, nextSyncSnapshot] = await Promise.all([
          window.sessionSearch.listSkills(),
          window.sessionSearch.getSkillSyncSnapshot(),
        ]);
        setSnapshot(nextSnapshot);
        setSyncSnapshot(nextSyncSnapshot);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setFeedback(retainedBackupMessage
          ? {
              kind: "warning",
              message: `${retainedBackupMessage} ${t(
                `The Skills list could not be refreshed: ${detail}`,
                `Skill 列表刷新失败：${detail}`,
              )}`,
            }
          : {
              kind: "error",
              message: t(
                `Deleted ${result.skillName}, but the Skills list could not be refreshed: ${detail}`,
                `已删除 ${result.skillName}，但 Skill 列表刷新失败：${detail}`,
              ),
            });
        return;
      }
      if (!retainedBackupMessage) {
        const message = t(`Deleted ${result.skillName}.`, `已删除 ${result.skillName}。`);
        setFeedback({ kind: "success", message });
        window.setTimeout(() => {
          setFeedback((current) =>
            current?.kind === "success" && current.message === message ? null : current);
        }, 2200);
      }
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      setLoading(false);
    }
  }, [t]);

  const upload = useCallback(async (
    skill: InstalledSkill,
    force = false,
  ): Promise<SkillSyncUploadOutcome | null> => {
    setLoading(true);
    setFeedback({
      kind: "running",
      message: t(`Uploading ${skill.name}...`, `正在上传 ${skill.name}...`),
    });
    try {
      const result = await window.sessionSearch.uploadSkillToSync(skill.path, force);
      if (result.status === "needs-confirmation") {
        setFeedback(null);
        return result;
      }
      await load({ silent: true });
      const message = result.status === "skipped"
        ? t(
            `${skill.name} is already the latest version (v${result.version}).`,
            `${skill.name} 已是最新版本（v${result.version}）。`,
          )
        : t(
            `Uploaded ${result.remoteSkill.name} v${result.version}.`,
            `已上传 ${result.remoteSkill.name} v${result.version}。`,
          );
      setFeedback({ kind: "success", message });
      window.setTimeout(() => {
        setFeedback((current) =>
          current?.kind === "success" && current.message === message ? null : current);
      }, 2200);
      return result;
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      setLoading(false);
    }
  }, [load, t]);

  const installRemote = useCallback(async (remoteSkillId: string): Promise<void> => {
    setLoading(true);
    setFeedback({
      kind: "running",
      message: t("Installing remote skill...", "正在安装远程 Skill..."),
    });
    try {
      const result = await window.sessionSearch.installSyncedSkill(remoteSkillId);
      await load({ silent: true });
      const verb = result.overwritten ? t("Updated", "已更新") : t("Installed", "已安装");
      const message = `${verb} ${result.remoteSkill.name} v${result.remoteSkill.version}.`;
      setFeedback({ kind: "success", message });
      window.setTimeout(() => {
        setFeedback((current) =>
          current?.kind === "success" && current.message === message ? null : current);
      }, 2200);
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [load, t]);

  const fetchVersion = useCallback(
    (remoteSkillId: string): Promise<RemoteSkill> =>
      window.sessionSearch.getSyncedSkillVersion(remoteSkillId),
    [],
  );

  const copySetupSql = useCallback(async (): Promise<void> => {
    try {
      await window.sessionSearch.copySkillSyncSetupSql();
      setFeedback({
        kind: "success",
        message: t("Supabase setup SQL copied.", "Supabase 初始化 SQL 已复制。"),
      });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [t]);

  return {
    snapshot,
    syncSnapshot,
    loading,
    feedback,
    localSnapshot,
    localLoading,
    localError,
    load,
    ensureLoaded,
    ensureLocalLoaded,
    refreshLoadedLocal,
    refreshLocal,
    deleteSkill,
    upload,
    installRemote,
    fetchVersion,
    copySetupSql,
  };
}
