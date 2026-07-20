import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown, Cloud, Download, RefreshCw, Trash2, Upload } from "lucide-react";
import type { ManagedSkill } from "../../../../core/managed-skill-library";
import type { SkillDiffSnapshot } from "../../../../core/skill-diff";
import type {
  RemoteSkill,
  RemoteSkillGroup,
  SkillSyncSnapshot,
  SkillSyncUploadConflict,
  SkillSyncUploadOutcome,
} from "../../../../core/skill-sync";
import { localize, type LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { markdownPreview } from "../../markdown-preview";
import type { UnifiedSkillEntry } from "../../skill-sync-view-model";
import { SupabaseSetupGuide } from "../../components/supabase-setup-guide";

export function SkillSyncPanel({
  skill,
  entry,
  remoteOnlyGroups,
  snapshot,
  busy,
  language,
  onUpload,
  onInstallRemote,
  onFetchVersion,
  onRefresh,
  onCopySetupSql,
  onOpenSqlEditor,
}: {
  skill: ManagedSkill;
  entry: UnifiedSkillEntry | null;
  remoteOnlyGroups: RemoteSkillGroup[];
  snapshot: SkillSyncSnapshot;
  busy: boolean;
  language: LanguageMode;
  onUpload: (skill: ManagedSkill, force?: boolean) => Promise<SkillSyncUploadOutcome | null>;
  onInstallRemote: (remoteSkillId: string) => Promise<void>;
  onFetchVersion: (remoteSkillId: string) => Promise<RemoteSkill>;
  onRefresh: () => void;
  onCopySetupSql: () => void;
  onOpenSqlEditor: () => void | Promise<void>;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<"versions" | "diff">("versions");
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [versionMarkdown, setVersionMarkdown] = useState<Record<string, string>>({});
  const [versionBusy, setVersionBusy] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [diff, setDiff] = useState<SkillDiffSnapshot | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [uploadConflict, setUploadConflict] = useState<SkillSyncUploadConflict | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [localFeedback, setLocalFeedback] = useState<string | null>(null);
  const remote = entry?.remote ?? null;
  const relation = entry?.relation ?? null;
  const selectedVersion = remote?.versions.find((version) => version.id === selectedVersionId) ?? remote?.latest ?? null;

  useEffect(() => {
    setSelectedVersionId(remote?.latest.id ?? null);
    setView("versions");
    setUploadConflict(null);
    setDeleteArmed(false);
    setLocalFeedback(null);
  }, [skill.managedId, remote?.latest.id]);

  useEffect(() => {
    if (!expanded || view !== "versions" || !selectedVersion || versionMarkdown[selectedVersion.id] !== undefined) return;
    let cancelled = false;
    setVersionBusy(true);
    setVersionError(null);
    onFetchVersion(selectedVersion.id)
      .then((result) => {
        if (!cancelled) setVersionMarkdown((current) => ({ ...current, [selectedVersion.id]: result.markdown }));
      })
      .catch((error) => {
        if (!cancelled) setVersionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setVersionBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, onFetchVersion, selectedVersion, versionMarkdown, view]);

  useEffect(() => {
    if (!expanded || view !== "diff" || !selectedVersion || !relation?.localSkillPath) {
      setDiff(null);
      setDiffError(null);
      return;
    }
    let cancelled = false;
    setDiffBusy(true);
    setDiffError(null);
    window.sessionSearch.getSyncedSkillDiff(relation.localSkillPath, selectedVersion.id)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((error) => {
        if (!cancelled) setDiffError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setDiffBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, relation?.localSkillPath, selectedVersion, view]);

  const changedFiles = useMemo(() => diff?.files.filter((file) => file.status !== "unchanged") ?? [], [diff]);

  const upload = async (force = false) => {
    const result = await onUpload(skill, force);
    if (result?.status === "needs-confirmation") setUploadConflict(result.conflict);
    else setUploadConflict(null);
  };

  const deleteRemote = async () => {
    if (!remote) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setLocalFeedback(null);
    try {
      const result = await window.sessionSearch.deleteSyncedSkills([remote.fingerprint]);
      setDeleteArmed(false);
      setLocalFeedback(result.failures[0]?.message ?? l("Cloud history deleted.", "云端历史已删除。"));
      onRefresh();
    } catch (error) {
      setLocalFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className={`managed-skill-sync ${expanded ? "expanded" : ""}`}>
      <button type="button" className="managed-skill-sync-toggle" onClick={() => setExpanded((value) => !value)}>
        <span><Cloud size={14} />{l("Cloud sync & versions", "云端同步与版本")}</span>
        <span className="managed-skill-sync-summary">
          {snapshot.status.kind === "ready"
            ? remote ? `v${remote.latest.version} · ${syncStateLabel(entry?.state, language)}` : l("Not uploaded", "未上传")
            : l("Not ready", "未就绪")}
          <ChevronDown size={14} />
        </span>
      </button>

      {expanded ? (
        <div className="managed-skill-sync-body">
          {snapshot.status.kind !== "ready" ? (
            <SupabaseSetupGuide
              language={language}
              tone={snapshot.status.kind === "error" ? "error" : "warning"}
              title={l("Skill sync is not ready", "Skill 同步尚未准备完成")}
              message={snapshot.status.remediation === "settings"
                ? l("Check the Supabase URL and anon key in Settings, then refresh.", "请检查设置中的 Supabase URL 和 anon key，然后刷新。")
                : undefined}
              detail={snapshot.status.kind === "unconfigured" ? null : snapshot.status.message}
              busy={busy}
              showSqlActions={snapshot.status.remediation === "sql"}
              onCopySql={onCopySetupSql}
              onOpenSqlEditor={onOpenSqlEditor}
              onRefresh={onRefresh}
            />
          ) : (
            <>
              <div className="managed-skill-sync-actions">
                <button type="button" onClick={() => void upload()} disabled={busy}>
                  <Upload size={13} />{remote ? l("Upload new version", "上传新版本") : l("Upload", "上传")}
                </button>
                {selectedVersion ? (
                  <button type="button" onClick={() => void onInstallRemote(selectedVersion.id)} disabled={busy || remote?.legacy}>
                    <Download size={13} />{l("Restore this version", "恢复此版本")}
                  </button>
                ) : null}
                {remote ? (
                  <button type="button" className={deleteArmed ? "danger-action" : ""} onClick={() => void deleteRemote()} disabled={busy}>
                    <Trash2 size={13} />{deleteArmed ? l("Confirm delete", "确认删除") : l("Delete cloud", "删除云端")}
                  </button>
                ) : null}
                <button type="button" className="icon-button" onClick={onRefresh} disabled={busy} aria-label={l("Refresh cloud Skills", "刷新云端 Skill")}>
                  <RefreshCw size={13} />
                </button>
              </div>

              {uploadConflict ? (
                <div className="managed-skill-sync-warning">
                  <span>{l(`Cloud v${uploadConflict.latestVersion} changed. Upload your local copy as a new version?`, `云端 v${uploadConflict.latestVersion} 已变化，是否把本地内容作为新版本上传？`)}</span>
                  <button type="button" onClick={() => void upload(true)}>{l("Upload anyway", "继续上传")}</button>
                  <button type="button" onClick={() => setUploadConflict(null)}>{l("Cancel", "取消")}</button>
                </div>
              ) : null}
              {localFeedback ? <div className="managed-skill-inline-feedback">{localFeedback}</div> : null}

              {remote ? (
                <>
                  <div className="managed-skill-sync-tabs" role="tablist">
                    <button type="button" className={view === "versions" ? "active" : ""} onClick={() => setView("versions")}>{l("Versions", "版本")}</button>
                    <button type="button" className={view === "diff" ? "active" : ""} onClick={() => setView("diff")} disabled={!relation?.localSkillPath}>{l("Diff", "差异")}</button>
                  </div>
                  {view === "versions" ? (
                    <div className="managed-skill-version-view">
                      <div className="managed-skill-version-list">
                        {remote.versions.map((version) => (
                          <button key={version.id} type="button" className={selectedVersion?.id === version.id ? "active" : ""} onClick={() => setSelectedVersionId(version.id)}>
                            <strong>v{version.version}</strong>
                            <span>{new Date(version.updatedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</span>
                          </button>
                        ))}
                      </div>
                      <div className="managed-skill-version-preview">
                        {versionBusy ? l("Loading version…", "正在加载版本…") : versionError ? versionError : selectedVersion ? (
                          <Markdown text={markdownPreview(versionMarkdown[selectedVersion.id] ?? "", 12_000, l("…(truncated)", "…（已截断）"))} language={language} />
                        ) : l("No cloud version.", "暂无云端版本。")}
                      </div>
                    </div>
                  ) : (
                    <div className="managed-skill-diff-view">
                      {diffBusy ? l("Comparing files…", "正在比较文件…") : diffError ? diffError : diff ? (
                        <>
                          <p>{diff.state === "identical" ? l("Local and cloud files are identical.", "本地与云端文件完全一致。") : l(`${changedFiles.length} files changed.`, `${changedFiles.length} 个文件有差异。`)}</p>
                          {changedFiles.map((file) => (
                            <details key={file.relativePath} open={file.relativePath === "SKILL.md"}>
                              <summary><span>{file.status}</span><code>{file.relativePath}</code></summary>
                              {file.diff ? <pre>{file.diff}</pre> : <p>{l("Binary preview unavailable.", "二进制文件无法预览。")}</p>}
                            </details>
                          ))}
                        </>
                      ) : l("Choose a version to compare.", "请选择要比较的版本。")}
                    </div>
                  )}
                </>
              ) : <p className="managed-skill-sync-empty">{l("This Skill has no cloud version yet.", "这个 Skill 还没有云端版本。")}</p>}

              {remoteOnlyGroups.length > 0 ? (
                <details className="managed-skill-cloud-only">
                  <summary>{l(`${remoteOnlyGroups.length} cloud-only Skills`, `${remoteOnlyGroups.length} 个仅云端 Skill`)}</summary>
                  {remoteOnlyGroups.map((group) => (
                    <div key={group.fingerprint}>
                      <span><strong>{group.name}</strong><small>v{group.latest.version}</small></span>
                      <button type="button" onClick={() => void onInstallRemote(group.latest.id)} disabled={busy || group.legacy}>
                        <Download size={12} />{l("Add to library", "加入 Skill 库")}
                      </button>
                    </div>
                  ))}
                </details>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function syncStateLabel(state: UnifiedSkillEntry["state"] | undefined, language: LanguageMode): string {
  const labels: Record<NonNullable<UnifiedSkillEntry["state"]>, [string, string]> = {
    "local-only": ["local only", "仅本地"],
    synced: ["synced", "已同步"],
    "local-newer": ["local newer", "本地较新"],
    "remote-newer": ["cloud newer", "云端较新"],
    "remote-only": ["cloud only", "仅云端"],
    conflict: ["conflict", "冲突"],
    legacy: ["legacy", "旧版"],
  };
  return state ? localize(language, ...labels[state]) : localize(language, "linked", "已关联");
}
