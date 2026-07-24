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
  load(options?: { refreshUsage?: boolean; silent?: boolean }): Promise<void>;
  ensureLoaded(): void;
  deleteSkill(skill: InstalledSkill): Promise<void>;
  upload(skill: InstalledSkill, force?: boolean): Promise<SkillSyncUploadOutcome | null>;
  uploadSelected(skills: InstalledSkill[]): Promise<{ remainingSkillIds: string[] }>;
  installRemote(remoteSkillId: string): Promise<void>;
  fetchVersion(remoteSkillId: string): Promise<RemoteSkill>;
  copySetupSql(): Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<InstalledSkillsSnapshot>(EMPTY_SKILLS);
  const [syncSnapshot, setSyncSnapshot] = useState<SkillSyncSnapshot>(EMPTY_SKILL_SYNC);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<SkillsFeedback>(null);
  const syncSnapshotRef = useRef<SkillSyncSnapshot>(EMPTY_SKILL_SYNC);
  const loadedRef = useRef(false);
  const loadSequenceRef = useRef(0);
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

  const deleteSkill = useCallback(async (skill: InstalledSkill): Promise<void> => {
    setLoading(true);
    setFeedback({
      kind: "running",
      message: t(`Deleting ${skill.name}...`, `正在删除 ${skill.name}...`),
    });
    try {
      const result = await window.sessionSearch.deleteSkill(skill.path);
      const [nextSnapshot, nextSyncSnapshot] = await Promise.all([
        window.sessionSearch.listSkills(),
        window.sessionSearch.getSkillSyncSnapshot(),
      ]);
      setSnapshot(nextSnapshot);
      setSyncSnapshot(nextSyncSnapshot);
      const message = t(`Deleted ${result.skillName}.`, `已删除 ${result.skillName}。`);
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

  const uploadSelected = useCallback(async (
    skills: InstalledSkill[],
  ): Promise<{ remainingSkillIds: string[] }> => {
    const uploadable = skills.filter((skill) => skill.source !== "codex-system");
    if (uploadable.length === 0) {
      setFeedback({
        kind: "error",
        message: t(
          "No selected non-system skills to upload.",
          "没有选中可上传的非系统 Skill。",
        ),
      });
      return { remainingSkillIds: [] };
    }

    setLoading(true);
    setFeedback({
      kind: "running",
      message: t(
        `Uploading ${uploadable.length} selected skills...`,
        `正在上传 ${uploadable.length} 个选中 Skill...`,
      ),
    });
    let uploaded = 0;
    let skipped = 0;
    let conflicts = 0;
    let failed = 0;
    const remainingSkillIds: string[] = [];
    const failureDetails: string[] = [];
    try {
      for (const skill of uploadable) {
        try {
          const result = await window.sessionSearch.uploadSkillToSync(skill.path, false);
          if (result.status === "uploaded") uploaded += 1;
          else if (result.status === "skipped") skipped += 1;
          else {
            conflicts += 1;
            remainingSkillIds.push(skill.id);
            failureDetails.push(t(
              `${skill.name}: confirm before replacing the existing remote source.`,
              `${skill.name}：需要确认是否替换现有远程来源。`,
            ));
          }
        } catch (error) {
          failed += 1;
          remainingSkillIds.push(skill.id);
          failureDetails.push(
            `${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await load({ silent: true });
      const summary = t(
        `Selected skills upload finished: ${uploaded} uploaded, ${skipped} skipped, ${conflicts} need confirmation, ${failed} failed.`,
        `选中 Skills 上传完成：${uploaded} 个已上传，${skipped} 个已跳过，${conflicts} 个需要确认，${failed} 个失败。`,
      );
      const shownFailures = failureDetails.slice(0, 3).join(" · ");
      const hiddenFailureCount = Math.max(0, failureDetails.length - 3);
      const message = shownFailures
        ? `${summary} ${t("Details", "详情")}：${shownFailures}${
            hiddenFailureCount
              ? t(` · ${hiddenFailureCount} more`, ` · 另有 ${hiddenFailureCount} 个`)
              : ""
          }`
        : summary;
      setFeedback({
        kind: failed > 0 || conflicts > 0 ? "error" : "success",
        message,
      });
      window.setTimeout(() => {
        setFeedback((current) => current?.message === message ? null : current);
      }, 4200);
      return { remainingSkillIds };
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
    load,
    ensureLoaded,
    deleteSkill,
    upload,
    uploadSelected,
    installRemote,
    fetchVersion,
    copySetupSql,
  };
}
