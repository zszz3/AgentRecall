import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import { Copy, Download, FolderOpen, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import type { RemoteSkill, RemoteSkillGroup, RemoteSkillVersion, SkillSyncSnapshot, SkillSyncUploadConflict, SkillSyncUploadOutcome } from "../../../../core/skill-sync";
import type { SkillDiffSnapshot } from "../../../../core/skill-diff";
import type { InstalledSkill, InstalledSkillsSnapshot, SkillRootStatus, SkillSource } from "../../../../core/skill-manager";
import { formatCompactNumber } from "../../format-count";
import { localize, type LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { markdownPreview } from "../../markdown-preview";
import { skillSourceLabel, type SkillSortKey, type SkillSourceFilter } from "../../skill-manager";
import { buildUnifiedSkillEntries, type UnifiedSkillEntry } from "../../skill-sync-view-model";
import type { SkillsFeedback } from "../../app-types";
import { useClampedContextMenuStyle } from "../../context-menu-position";
import { SupabaseSetupGuide } from "../../components/supabase-setup-guide";

export function SkillsPage({
  snapshot,
  syncSnapshot,
  loading,
  feedback,
  language,
  revealLabel,
  onRefresh,
  onUpload,
  onUploadSelected,
  onInstallRemote,
  onFetchVersion,
  onRefreshRemote,
  onCopySetupSql,
  onOpenSqlEditor,
  onCopyPath,
  onReveal,
  onDelete,
}: {
  snapshot: InstalledSkillsSnapshot;
  syncSnapshot: SkillSyncSnapshot;
  loading: boolean;
  feedback: SkillsFeedback;
  language: LanguageMode;
  revealLabel: string;
  onRefresh: () => void;
  onUpload: (skill: InstalledSkill, force?: boolean) => Promise<SkillSyncUploadOutcome | null>;
  onUploadSelected: (skills: InstalledSkill[]) => Promise<{ remainingSkillIds: string[] }>;
  onInstallRemote: (remoteSkillId: string) => Promise<void>;
  onFetchVersion: (remoteSkillId: string) => Promise<RemoteSkill>;
  onRefreshRemote: () => void;
  onCopySetupSql: () => void;
  onOpenSqlEditor: () => void | Promise<void>;
  onCopyPath: (skillPath: string) => void;
  onReveal: (skillPath: string) => void;
  onDelete: (skill: InstalledSkill) => Promise<void>;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [query, setQuery] = useState("");
  const [previewView, setPreviewView] = useState<"overview" | "details">("overview");
  const [detailView, setDetailView] = useState<"local" | "remote" | "diff">("local");
  const [sourceFilter, setSourceFilter] = useState<SkillSourceFilter>("all");
  const [sortKey, setSortKey] = useState<SkillSortKey>("usage");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(() => new Set());
  const [batchFeedback, setBatchFeedback] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [remoteDeleteConfirm, setRemoteDeleteConfirm] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [versionContent, setVersionContent] = useState<Record<string, string>>({});
  const [versionLoadingId, setVersionLoadingId] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [diffSnapshot, setDiffSnapshot] = useState<SkillDiffSnapshot | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [skillContextMenu, setSkillContextMenu] = useState<{ x: number; y: number; skill: InstalledSkill } | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<InstalledSkill | null>(null);
  const [deletingSkill, setDeletingSkill] = useState(false);
  const [uploadConfirm, setUploadConfirm] = useState<{ skill: InstalledSkill; conflict: SkillSyncUploadConflict } | null>(null);
  const entries = useMemo(() => buildUnifiedSkillEntries(snapshot, syncSnapshot), [snapshot, syncSnapshot]);
  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return entries
      .filter((entry) => {
        const matchesSource = sourceFilter === "all"
          || (sourceFilter === "codex" && (entry.local?.agent ?? entry.remote?.agent) === "codex")
          || (sourceFilter === "claude" && (entry.local?.agent ?? entry.remote?.agent) === "claude")
          || (sourceFilter === "shared" && entry.source === "codex-shared")
          || (sourceFilter === "project" && (entry.source === "codex-project" || entry.source === "claude-project"));
        if (!matchesSource || !normalizedQuery) return matchesSource;
        return [entry.name, entry.description, entry.identity, entry.local?.path ?? "", entry.remote?.relativePath ?? ""]
          .join("\n")
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .sort((a, b) => {
        const usageOrder = sortKey === "usage-asc"
          ? (a.local?.usageCount ?? 0) - (b.local?.usageCount ?? 0)
          : (b.local?.usageCount ?? 0) - (a.local?.usageCount ?? 0);
        return usageOrder || a.name.localeCompare(b.name) || a.identity.localeCompare(b.identity);
      });
  }, [entries, query, sourceFilter, sortKey]);
  const visibleRoots = useMemo(() => summarizeSkillRoots(snapshot.roots), [snapshot.roots]);
  const selectedEntry = filteredEntries.find((entry) => entry.id === selectedEntryId) ?? filteredEntries[0] ?? null;
  const selectedSkill = selectedEntry?.local ?? null;
  const selectedGroup = selectedEntry?.remote ?? null;
  const selectedVersions = selectedEntry ? skillSyncVersions(selectedEntry, language) : null;
  const selectedVersion =
    selectedGroup?.versions.find((version) => version.id === selectedVersionId) ?? selectedGroup?.latest ?? null;
  const selectedSkillBinding = selectedSkill ? syncSnapshot.bindings.find((binding) => binding.localSkillPath === selectedSkill.path) : null;
  const selectedGroupBinding = selectedGroup ? bindingForGroup(syncSnapshot, selectedGroup) : null;
  const syncReady = syncSnapshot.status.kind === "ready";
  const selectableVisibleEntries = useMemo(() => syncReady ? filteredEntries.filter((entry) => entry.syncable) : [], [filteredEntries, syncReady]);
  const selectedVisibleEntries = useMemo(() => selectableVisibleEntries.filter((entry) => selectedEntryIds.has(entry.id)), [selectableVisibleEntries, selectedEntryIds]);
  const selectedUploadableSkills = useMemo(() => selectedVisibleEntries.flatMap((entry) =>
    entry.local && (entry.state === "local-only" || entry.state === "local-newer" || entry.state === "conflict") ? [entry.local] : []
  ), [selectedVisibleEntries]);
  const selectedRemoteGroups = useMemo(() => selectedVisibleEntries.flatMap((entry) => entry.remote ? [entry.remote] : []), [selectedVisibleEntries]);
  const allSelectableVisibleSelected = selectableVisibleEntries.length > 0 && selectedVisibleEntries.length === selectableVisibleEntries.length;
  const codexCount = snapshot.skills.filter((skill) => skill.agent === "codex").length;
  const claudeCount = snapshot.skills.filter((skill) => skill.agent === "claude").length;
  const activeItemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filteredEntries.length) {
      if (selectedEntryId) setSelectedEntryId(null);
      return;
    }
    if (!selectedEntryId || !filteredEntries.some((entry) => entry.id === selectedEntryId)) setSelectedEntryId(filteredEntries[0].id);
  }, [filteredEntries, selectedEntryId]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedEntry?.id]);

  useEffect(() => {
    const selectableIds = new Set(selectableVisibleEntries.map((entry) => entry.id));
    setSelectedEntryIds((current) => {
      const next = new Set([...current].filter((id) => selectableIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [selectableVisibleEntries]);

  // Default to the latest version whenever the selected skill group changes.
  useEffect(() => {
    if (detailView === "diff" && (!selectedSkill || !selectedGroup)) {
      setDetailView(selectedSkill ? "local" : "remote");
    }
    if (!selectedGroup) {
      if (selectedVersionId) setSelectedVersionId(null);
      return;
    }
    if (!selectedVersionId || !selectedGroup.versions.some((version) => version.id === selectedVersionId)) {
      setSelectedVersionId(selectedGroup.latest.id);
    }
  }, [detailView, selectedGroup, selectedSkill, selectedVersionId]);

  // The version list is lightweight (no markdown); fetch the body on demand for preview.
  useEffect(() => {
    const id = previewView === "details" && detailView === "remote" ? selectedVersion?.id : null;
    if (!syncReady || !id || versionContent[id] !== undefined) return;
    let cancelled = false;
    setVersionLoadingId(id);
    setVersionError(null);
    onFetchVersion(id)
      .then((full) => {
        if (!cancelled) setVersionContent((current) => ({ ...current, [id]: full.markdown }));
      })
      .catch((error) => {
        if (!cancelled) setVersionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setVersionLoadingId((current) => (current === id ? null : current));
      });
    return () => {
      cancelled = true;
    };
  }, [detailView, previewView, selectedVersion?.id, versionContent, onFetchVersion, syncReady]);

  useEffect(() => {
    if (previewView !== "details" || detailView !== "diff" || !selectedEntry || !syncReady || !selectedSkill || !selectedVersion) {
      setDiffSnapshot(null);
      setDiffError(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    window.sessionSearch.getSyncedSkillDiff(selectedSkill.path, selectedVersion.id)
      .then((result) => {
        if (!cancelled) setDiffSnapshot(result);
      })
      .catch((error) => {
        if (!cancelled) setDiffError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailView, previewView, selectedEntry?.id, selectedSkill?.path, selectedVersion?.id, syncReady]);

  const handleListKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      if (uploadConfirm) setUploadConfirm(null);
      else if (deleteCandidate) setDeleteCandidate(null);
      else if (skillContextMenu) setSkillContextMenu(null);
      else return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!filteredEntries.length) return;
    event.preventDefault();
    const currentIndex = filteredEntries.findIndex((entry) => entry.id === selectedEntry?.id);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = Math.min(filteredEntries.length - 1, Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + delta));
    setSelectedEntryId(filteredEntries[nextIndex].id);
  };

  const requestDelete = (skill: InstalledSkill) => {
    setSkillContextMenu(null);
    setDeleteCandidate(skill);
  };

  const confirmDelete = async () => {
    if (!deleteCandidate) return;
    setDeletingSkill(true);
    try {
      await onDelete(deleteCandidate);
      setDeleteCandidate(null);
    } finally {
      setDeletingSkill(false);
    }
  };

  const handleUpload = async (skill: InstalledSkill) => {
    const outcome = await onUpload(skill, false);
    if (outcome && outcome.status === "needs-confirmation") setUploadConfirm({ skill, conflict: outcome.conflict });
  };

  const toggleEntrySelection = (entryId: string) => {
    setSelectedEntryIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedEntryIds((current) => {
      const next = new Set(current);
      if (allSelectableVisibleSelected) {
        for (const entry of selectableVisibleEntries) next.delete(entry.id);
      } else {
        for (const entry of selectableVisibleEntries) next.add(entry.id);
      }
      return next;
    });
  };

  const uploadSelected = async () => {
    setBatchBusy(true);
    setBatchFeedback(null);
    try {
      const result = await onUploadSelected(selectedUploadableSkills);
      const remaining = new Set(result.remainingSkillIds);
      setSelectedEntryIds(new Set(selectedVisibleEntries.filter((entry) => entry.local && remaining.has(entry.local.id)).map((entry) => entry.id)));
    } catch (error) {
      setBatchFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchBusy(false);
    }
  };

  const toggleRemoteSelection = (entryId: string) => toggleEntrySelection(entryId);

  const downloadRemote = async (groups: RemoteSkillGroup[]) => {
    setBatchBusy(true);
    setBatchFeedback(null);
    try {
      const result = await window.sessionSearch.downloadSyncedSkills(groups.map((group) => group.fingerprint));
      const retryFingerprints = new Set([...result.conflicts, ...result.failures.map((failure) => failure.id)]);
      setSelectedEntryIds(new Set(entries.filter((entry) => entry.remote && retryFingerprints.has(entry.remote.fingerprint)).map((entry) => entry.id)));
      setBatchFeedback(l(
        `${result.succeeded.length} installed · ${result.skipped.length} skipped · ${result.conflicts.length} conflicts · ${result.failures.length} failed`,
        `已安装 ${result.succeeded.length} 个 · 跳过 ${result.skipped.length} 个 · 冲突 ${result.conflicts.length} 个 · 失败 ${result.failures.length} 个`,
      ));
      onRefreshRemote();
    } catch (error) {
      setBatchFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchBusy(false);
    }
  };

  const deleteRemote = async () => {
    setBatchBusy(true);
    setBatchFeedback(null);
    try {
      const result = await window.sessionSearch.deleteSyncedSkills(selectedRemoteGroups.map((group) => group.fingerprint));
      const failures = new Set(result.failures.map((failure) => failure.id));
      setSelectedEntryIds(new Set(entries.filter((entry) => entry.remote && failures.has(entry.remote.fingerprint)).map((entry) => entry.id)));
      setBatchFeedback(l(`${result.succeeded.length} cloud Skills deleted · ${result.failures.length} failed`, `已删除 ${result.succeeded.length} 个云端 Skill · ${result.failures.length} 个失败`));
      onRefreshRemote();
    } catch (error) {
      setBatchFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchBusy(false);
    }
  };

  const confirmUpload = async () => {
    if (!uploadConfirm) return;
    const { skill } = uploadConfirm;
    setUploadConfirm(null);
    await onUpload(skill, true);
  };

  return (
    <div className="skills-page">
      <header className="app-page-head skills-page-head">
        <div>
          <h2>Skills</h2>
          <p>{l("Manage local Skills and sync them across devices.", "管理本地 Skills，并在设备之间同步。")}</p>
        </div>
      </header>
      <section
        className="command-dialog skills-dialog skills-page-surface"
        onMouseDown={(event) => {
          event.stopPropagation();
          setSkillContextMenu(null);
        }}
        onKeyDown={handleListKeyDown}
      >
        <div className="dialog-title">
          <span>{l("Skill library", "Skill 库")}</span>
          <span className="skills-dialog-count">
            Codex {formatCompactNumber(codexCount)} · Claude Code {formatCompactNumber(claudeCount)}
            {syncReady ? ` · Remote ${formatCompactNumber(syncSnapshot.remoteSkillGroups.length)}` : ""}
          </span>
        </div>

        <div className="skills-toolbar">
          <label className="skills-search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={l("Search name, description, or path", "搜索名称、描述或路径")} />
          </label>
          <div className="skills-filter" role="group" aria-label={l("Skill source filter", "Skill 来源筛选")}>
            {SKILL_SOURCE_FILTERS.map((filter) => (
              <button key={filter} className={sourceFilter === filter ? "active" : ""} onClick={() => setSourceFilter(filter)}>
                {skillFilterLabel(filter, language)}
              </button>
            ))}
          </div>
          <label className="skills-sort" title={l("Sort skills", "排序 Skills")}>
            <span>{l("Sort", "排序")}</span>
            <select value={sortKey} onChange={(event) => setSortKey(event.currentTarget.value as SkillSortKey)} aria-label={l("Sort skills", "排序 Skills")}>
              <option value="usage">{l("Most used", "最多使用")}</option>
              <option value="usage-asc">{l("Least used", "最少使用")}</option>
            </select>
          </label>
          <button type="button" className="settings-action-button" onClick={toggleVisibleSelection} disabled={loading || batchBusy || selectableVisibleEntries.length === 0}>
            {allSelectableVisibleSelected ? l("Clear selected", "清空选择") : l("Select visible", "选择当前可见")}
          </button>
          <button type="button" className="settings-action-button" onClick={() => void uploadSelected()} disabled={!syncReady || loading || batchBusy || selectedUploadableSkills.length === 0} title={!syncReady ? syncDisabledTitle(syncSnapshot, language) : l("Upload selected Skills", "上传选中的 Skills")}>
            <Upload size={13} /> {l(`Upload (${selectedUploadableSkills.length})`, `上传（${selectedUploadableSkills.length}）`)}
          </button>
          <button type="button" className="settings-action-button" onClick={() => void downloadRemote(syncSnapshot.remoteSkillGroups)} disabled={!syncReady || loading || batchBusy || syncSnapshot.remoteSkillGroups.length === 0}>
            <Download size={13} /> {l(`Download all (${syncSnapshot.remoteSkillGroups.length})`, `下载全部（${syncSnapshot.remoteSkillGroups.length}）`)}
          </button>
          <button type="button" className="settings-action-button danger" onClick={() => setRemoteDeleteConfirm(true)} disabled={!syncReady || loading || batchBusy || selectedRemoteGroups.length === 0}>
            <Trash2 size={13} /> {l(`Delete cloud (${selectedRemoteGroups.length})`, `删除云端（${selectedRemoteGroups.length}）`)}
          </button>
          <button className="stats-refresh" onClick={onRefresh} disabled={loading || batchBusy} title={l("Refresh local and cloud Skills", "刷新本地和云端 Skills")} aria-label={l("Refresh skills", "刷新 Skills")}>
            <RefreshCw size={13} />
          </button>
        </div>

        <div className="skills-roots">
          {visibleRoots.map((root) => (
            <span key={`${root.source}:${root.path}`} className={root.exists ? "" : "missing"} title={root.path}>
              <strong>{skillSourceUiLabel(root.source, language)}</strong>
              {root.exists ? l(`${root.skillCount} skills`, `${root.skillCount} 个`) : l("Missing", "未找到")}
            </span>
          ))}
        </div>

        {feedback ? <div className={`skills-feedback ${feedback.kind}`}>{feedback.message}</div> : null}
        {batchFeedback ? <div className="skills-feedback success">{batchFeedback}</div> : null}
        <div className="skills-shell">
          <div className="skills-list">
            {loading && filteredEntries.length === 0 ? <div className="skills-empty">{l("Loading Skills...", "正在加载 Skills...")}</div> : null}
            {!loading && filteredEntries.length === 0 ? <div className="skills-empty">{l("No skills found.", "没有找到 Skill。")}</div> : null}
            {filteredEntries.map((entry) => {
              const versions = skillSyncVersions(entry, language);
              return (
              <div
                key={entry.id}
                ref={selectedEntry?.id === entry.id ? activeItemRef : undefined}
                role="button"
                tabIndex={0}
                className={`skill-item ${selectedEntry?.id === entry.id ? "active" : ""}`}
                onClick={() => setSelectedEntryId(entry.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedEntryId(entry.id);
                  }
                }}
                onContextMenu={(event) => {
                  if (!entry.local) return;
                  event.preventDefault();
                  setSelectedEntryId(entry.id);
                  setSkillContextMenu({ x: event.clientX, y: event.clientY, skill: entry.local });
                }}
              >
                <span className="unified-skill-item-head">
                  {syncReady && entry.syncable ? <label className="skill-select" title={l("Select for cloud actions", "选择云端操作")}>
                    <input type="checkbox" checked={selectedEntryIds.has(entry.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleRemoteSelection(entry.id)} aria-label={l(`Select ${entry.name}`, `选择 ${entry.name}`)} />
                  </label> : null}
                  <span className="unified-skill-name">
                    <strong title={entry.name}>{entry.name}</strong>
                    <SkillSourceBadge source={entry.source} language={language} />
                  </span>
                  {entry.state ? <SkillSyncStateBadge state={entry.state} language={language} /> : null}
                </span>
                <span className="skill-item-desc">{entry.description || l("No description", "无描述")}</span>
                <span className="skill-item-path">
                  {versions.managed ?? l(`Local ${versions.local} · Cloud ${versions.cloud}`, `本地 ${versions.local} · 云端 ${versions.cloud}`)}
                </span>
              </div>
              );
            })}
          </div>

          <div className="skill-preview">
            {selectedEntry ? <>
              <div className="skill-preview-head">
                <div className="skill-preview-title">
                  <h3>{selectedEntry.name}</h3>
                  <SkillSourceBadge source={selectedEntry.source} language={language} />
                  {selectedEntry.state ? <SkillSyncStateBadge state={selectedEntry.state} language={language} /> : null}
                </div>
              </div>
              <div className="skill-preview-mode-tabs" role="tablist" aria-label={l("Skill view", "Skill 查看方式")}>
                <button type="button" role="tab" aria-selected={previewView === "overview"} className={previewView === "overview" ? "active" : ""} onClick={() => setPreviewView("overview")}>{l("Overview", "概述")}</button>
                <button type="button" role="tab" aria-selected={previewView === "details"} className={previewView === "details" ? "active" : ""} onClick={() => setPreviewView("details")}>{l("Details", "详情")}</button>
              </div>
              {previewView === "overview" ? (
                <div className="skill-overview-content">
                  <section className="skill-overview-intro">
                    <h4>{l("Description", "说明")}</h4>
                    <p>{selectedEntry.description || l("No description", "无描述")}</p>
                  </section>
                  {selectedVersions ? <div className="skill-version-strip">
                    {selectedVersions.managed ? <span className="skill-version-managed">{selectedVersions.managed}</span> : <>
                      <span className="skill-version-copy"><small>{l("Local", "本地")}</small><strong>{selectedVersions.local}</strong></span>
                      <span className="skill-version-divider" aria-hidden="true" />
                      <span className="skill-version-copy"><small>{l("Cloud", "云端")}</small><strong>{selectedVersions.cloud}</strong></span>
                    </>}
                  </div> : null}
                  <div className="skill-overview-cards">
                    <section className="skill-overview-card">
                      <h4>{l("Local copy", "本地概述")}</h4>
                      {selectedSkill ? <dl className="skill-meta">
                        <div><dt>{l("Agent", "Agent")}</dt><dd>{selectedSkill.agent === "codex" ? "Codex" : "Claude Code"}</dd></div>
                        <div><dt>{l("Management", "管理方式")}</dt><dd>{skillManagementLabel(selectedSkill.source, language) ?? l("Installed on this device", "已安装在此设备")}</dd></div>
                        <div><dt>{l("Used", "使用次数")}</dt><dd>{selectedSkill.usageCount ? l(`${selectedSkill.usageCount} times`, `${selectedSkill.usageCount} 次`) : l("Not yet", "暂无")}</dd></div>
                        <div><dt>{l("Updated", "更新时间")}</dt><dd>{new Date(selectedSkill.mtimeMs).toLocaleString()}</dd></div>
                        <div className="skill-meta-wide"><dt>{l("Path", "路径")}</dt><dd title={selectedSkill.path}>{selectedSkill.path}</dd></div>
                      </dl> : <p className="skill-overview-empty">{l("This Skill is not installed on this device.", "此设备尚未安装这个 Skill。")}</p>}
                    </section>
                    <section className="skill-overview-card">
                      <h4>{l("Cloud copy", "云端概述")}</h4>
                      {selectedGroup ? <dl className="skill-meta">
                        <div><dt>{l("Latest version", "最新版本")}</dt><dd>v{selectedGroup.latest.version}</dd></div>
                        <div><dt>{l("Versions", "版本数量")}</dt><dd>{selectedGroup.versions.length}</dd></div>
                        <div><dt>{l("Updated", "更新时间")}</dt><dd>{new Date(selectedGroup.latest.updatedAt).toLocaleString()}</dd></div>
                        <div className="skill-meta-wide"><dt>{l("Location", "位置")}</dt><dd>{selectedGroup.legacy ? l("Legacy record", "旧版记录") : `${selectedGroup.portableScope}/${selectedGroup.relativePath}`}</dd></div>
                      </dl> : <p className="skill-overview-empty">{syncReady ? l("No cloud copy yet.", "还没有云端副本。") : l("Cloud sync is not configured.", "尚未配置云端同步。")}</p>}
                    </section>
                  </div>
                </div>
              ) : <>
                <div className="skill-detail-tabs" role="tablist" aria-label={l("Skill details", "Skill 详情")}>
                  <button type="button" className={detailView === "local" ? "active" : ""} onClick={() => setDetailView("local")}>{l("Local", "本地")}</button>
                  <button type="button" className={detailView === "remote" ? "active" : ""} onClick={() => setDetailView("remote")}>{l("Remote", "云端")}</button>
                  <button type="button" className={detailView === "diff" ? "active" : ""} onClick={() => setDetailView("diff")} disabled={!selectedSkill || !selectedGroup}>{l("Diff", "差异")}</button>
                </div>
                <div className="skill-preview-content">
                  {detailView === "local" ? (
                    selectedSkill ? <>
                      <div className="skill-detail-actions">
                        <span>{skillManagementLabel(selectedSkill.source, language) ?? l("Installed on this device", "已安装在此设备")}</span>
                        {(selectedSkill.source === "codex-user" || selectedSkill.source === "claude-user" || selectedSkill.source === "codex-shared")
                          && syncReady
                          && (selectedEntry.state === "local-only" || selectedEntry.state === "local-newer" || selectedEntry.state === "conflict")
                          ? <button type="button" disabled={loading} onClick={() => void handleUpload(selectedSkill)}><Upload size={14} />{selectedSkillBinding ? l("Upload new version", "上传新版本") : l("Upload", "上传")}</button>
                          : null}
                      </div>
                      <div className="skill-markdown-preview"><Markdown text={skillPreviewMarkdown(selectedSkill.markdown, language)} language={language} /></div>
                    </> : <div className="skills-empty">{l("This Skill is not installed on this device.", "此设备尚未安装这个 Skill。")}</div>
                  ) : null}
                  {detailView === "remote" ? (
                    !syncReady ? <SkillSyncStatusPanel snapshot={syncSnapshot} language={language} busy={loading || batchBusy} onCopySetupSql={onCopySetupSql} onOpenSqlEditor={onOpenSqlEditor} onRefresh={onRefreshRemote} />
                      : selectedGroup && selectedVersion ? <>
                        <div className="skill-detail-actions">
                          <label className="skills-sort" title={l("Version", "版本")}>
                            <span>{l("Version", "版本")}</span>
                            <select value={selectedVersion.id} onChange={(event) => setSelectedVersionId(event.currentTarget.value)} aria-label={l("Select version", "选择版本")}>
                              {selectedGroup.versions.map((version) => <option key={version.id} value={version.id}>{versionOptionLabel(version, selectedGroup.latest.id, language)}</option>)}
                            </select>
                          </label>
                          <button type="button" disabled={loading || selectedGroup.legacy || selectedEntry.state === "local-newer" || selectedEntry.state === "conflict"} onClick={() => void onInstallRemote(selectedVersion.id)} title={selectedGroup.legacy ? l("Legacy record has no safe install location.", "旧版记录无法安全确定安装位置。") : ""}><Download size={14} />{selectedGroupBinding ? l("Update local", "更新本地") : l("Install locally", "安装到本地")}</button>
                        </div>
                        <div className="skill-markdown-preview"><Markdown text={remoteVersionPreview(selectedVersion.id, versionContent, versionLoadingId, versionError, language)} language={language} /></div>
                      </> : <div className="skills-empty skill-cloud-empty"><p>{l("No cloud copy yet.", "还没有云端副本。")}</p>{selectedSkill && selectedEntry.syncable ? <button type="button" onClick={() => void handleUpload(selectedSkill)}><Upload size={14} />{l("Upload this Skill", "上传这个 Skill")}</button> : null}</div>
                  ) : null}
                  {detailView === "diff" ? (
                    !syncReady ? <SkillSyncStatusPanel snapshot={syncSnapshot} language={language} busy={loading || batchBusy} onCopySetupSql={onCopySetupSql} onOpenSqlEditor={onOpenSqlEditor} onRefresh={onRefreshRemote} />
                      : diffLoading ? <div className="skills-empty">{l("Comparing local and cloud files...", "正在比较本地与云端文件...")}</div>
                        : diffError ? <div className="skills-empty danger-copy">{diffError}</div>
                          : diffSnapshot ? <SkillDiffView snapshot={diffSnapshot} language={language} />
                            : <div className="skills-empty">{l("Both a local and cloud copy are required to compare.", "需要同时存在本地和云端副本才能比较。")}</div>
                  ) : null}
                </div>
              </>}
            </> : <div className="skills-empty">{l("Select a skill to preview it.", "选择一个 Skill 查看内容。")}</div>}
          </div>
        </div>
        {skillContextMenu ? (
          <SkillContextMenu
            state={skillContextMenu}
            language={language}
            revealLabel={revealLabel}
            onCopyPath={() => {
              onCopyPath(skillContextMenu.skill.path);
              setSkillContextMenu(null);
            }}
            onReveal={() => {
              onReveal(skillContextMenu.skill.directoryPath);
              setSkillContextMenu(null);
            }}
            onDelete={() => requestDelete(skillContextMenu.skill)}
          />
        ) : null}
        {deleteCandidate ? (
          <DeleteSkillDialog
            skill={deleteCandidate}
            language={language}
            deleting={deletingSkill}
            onConfirm={() => void confirmDelete()}
            onCancel={() => {
              if (!deletingSkill) setDeleteCandidate(null);
            }}
          />
        ) : null}
        {uploadConfirm ? (
          <UploadVersionConfirmDialog
            skill={uploadConfirm.skill}
            conflict={uploadConfirm.conflict}
            language={language}
            onConfirm={() => void confirmUpload()}
            onCancel={() => setUploadConfirm(null)}
          />
        ) : null}
        {remoteDeleteConfirm ? (
          <div className="dialog-backdrop" onMouseDown={() => setRemoteDeleteConfirm(false)}>
            <div className="command-dialog delete-skill-dialog" onMouseDown={(event) => event.stopPropagation()}>
              <div className="dialog-title">
                <span>{l("Delete cloud Skills", "删除云端 Skills")}</span>
                <button type="button" className="icon-button" onClick={() => setRemoteDeleteConfirm(false)}><X size={16} /></button>
              </div>
              <p className="dialog-copy">{l(`Delete ${selectedRemoteGroups.length} selected cloud Skills and all their versions?`, `确定删除选中的 ${selectedRemoteGroups.length} 个云端 Skill 及其全部历史版本吗？`)}</p>
              <p className="dialog-copy danger-copy">{l("Only cloud copies will be deleted. Local Skill folders will not change.", "只会删除云端副本，本地 Skill 目录不会改变。")}</p>
              <div className="dialog-actions">
                <button type="button" onClick={() => setRemoteDeleteConfirm(false)}>{l("Cancel", "取消")}</button>
                <button type="button" className="danger-action" onClick={async () => { setRemoteDeleteConfirm(false); await deleteRemote(); }}>{l("Delete cloud copies", "删除云端副本")}</button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function skillSyncVersions(entry: UnifiedSkillEntry, language: LanguageMode): { managed: string | null; local: string; cloud: string } {
  const managed = entry.local ? skillManagementLabel(entry.local.source, language) : null;
  const localVersion = entry.local
    ? entry.remote && entry.relation?.remoteContentHash && entry.relation.remoteContentHash === entry.relation.localContentHash
      ? `v${entry.remote.latest.version}`
      : localize(language, "present", "已安装")
    : localize(language, "not installed", "未安装");
  const cloudVersion = entry.remote ? `v${entry.remote.latest.version}` : localize(language, "not uploaded", "未上传");
  return { managed, local: localVersion, cloud: cloudVersion };
}

function SkillDiffView({ snapshot, language }: { snapshot: SkillDiffSnapshot; language: LanguageMode }): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const changedFiles = snapshot.files.filter((file) => file.status !== "unchanged");
  return (
    <div className="skill-diff-view">
      <div className={`skill-diff-summary ${snapshot.state}`}>
        <strong>{snapshot.state === "identical" ? l("Local and cloud files are identical", "本地与云端文件完全一致") : l(`${changedFiles.length} files differ`, `${changedFiles.length} 个文件有差异`)}</strong>
        <span>{l(`${snapshot.files.length} files compared`, `已比较 ${snapshot.files.length} 个文件`)}</span>
      </div>
      <div className="skill-diff-files">
        {changedFiles.length === 0 ? <div className="skill-diff-empty">{l("No different files to display.", "没有需要显示的差异文件。")}</div> : null}
        {changedFiles.map((file) => (
          <details key={file.relativePath} className={`skill-diff-file ${file.status}`} open={file.relativePath === "SKILL.md"}>
            <summary>
              <span className="skill-diff-status">
                {file.status === "added"
                  ? l("Cloud only", "仅云端")
                  : file.status === "removed"
                    ? l("Local only", "仅本地")
                    : file.status === "modified"
                      ? l("Changed", "已修改")
                      : l("Same", "相同")}
              </span>
              <code>{file.relativePath}</code>
              <span>{file.binary ? l("Binary", "二进制") : `${file.localSize} B → ${file.remoteSize} B`}</span>
            </summary>
            {file.diff ? <pre>{file.diff}</pre> : <div className="skill-diff-note">{file.status === "unchanged" ? l("No content changes.", "内容没有变化。") : l("Preview is unavailable for binary files.", "二进制文件不提供内容预览。")}</div>}
          </details>
        ))}
      </div>
    </div>
  );
}

const SKILL_SOURCE_FILTERS: SkillSourceFilter[] = ["all", "codex", "claude", "shared", "project"];
const PROJECT_SKILL_SOURCES = new Set<SkillSource>(["codex-project", "claude-project"]);

export function summarizeSkillRoots(roots: SkillRootStatus[]): SkillRootStatus[] {
  const visible: SkillRootStatus[] = [];
  const projectRoots = new Map<SkillSource, SkillRootStatus[]>();

  for (const root of roots) {
    if (!PROJECT_SKILL_SOURCES.has(root.source)) {
      visible.push(root);
      continue;
    }
    const group = projectRoots.get(root.source) ?? [];
    group.push(root);
    projectRoots.set(root.source, group);
  }

  for (const [source, group] of projectRoots) {
    const skillCount = group.reduce((sum, root) => sum + root.skillCount, 0);
    const existingRoots = group.filter((root) => root.exists);
    if (skillCount === 0 && existingRoots.length === 0) continue;
    visible.push({
      agent: group[0].agent,
      source,
      path: existingRoots.map((root) => root.path).join("\n") || group.map((root) => root.path).join("\n"),
      exists: existingRoots.length > 0,
      skillCount,
    });
  }

  return visible;
}

function skillFilterLabel(filter: SkillSourceFilter, language: LanguageMode): string {
  if (filter === "codex") return "Codex";
  if (filter === "claude") return "Claude Code";
  if (filter === "shared") return localize(language, "Shared", "共享");
  if (filter === "project") return localize(language, "Project", "项目");
  return localize(language, "All", "全部");
}

function skillSourceUiLabel(source: SkillSource, language: LanguageMode): string {
  if (source === "codex-shared") return localize(language, "Shared", "共享");
  if (source === "codex-system") return localize(language, "Codex System", "Codex 系统");
  if (source === "codex-project") return localize(language, "Codex Project", "Codex 项目");
  if (source === "claude-project") return localize(language, "Project", "项目");
  if (source === "claude-plugin") return localize(language, "Claude Plugin", "Claude 插件");
  return skillSourceLabel(source);
}

function skillManagementLabel(source: SkillSource, language: LanguageMode): string | null {
  if (source === "claude-plugin") return localize(language, "Managed by Claude Plugin", "由 Claude Plugin 管理");
  if (source === "codex-project" || source === "claude-project") return localize(language, "Synced with the Git repository", "随 Git 仓库同步");
  if (source === "codex-system") return localize(language, "Built into the system", "系统内置");
  return null;
}

function SkillSyncStateBadge({ state, language }: { state: import("../../../../core/skill-sync").SkillSyncState; language: LanguageMode }): ReactElement {
  const labels: Record<import("../../../../core/skill-sync").SkillSyncState, [string, string]> = {
    "local-only": ["Not uploaded", "未上传"],
    synced: ["Synced", "已同步"],
    "local-newer": ["Local newer", "本地较新"],
    "remote-newer": ["Cloud newer", "云端较新"],
    "remote-only": ["Not installed", "本地未安装"],
    conflict: ["Conflict", "冲突"],
    legacy: ["Legacy record", "旧版记录"],
  };
  return <span className={`sync-state-badge ${state}`}>{localize(language, ...labels[state])}</span>;
}

function bindingForGroup(snapshot: SkillSyncSnapshot, group: RemoteSkillGroup) {
  const versionIds = new Set(group.versions.map((version) => version.id));
  return snapshot.bindings.find((binding) => versionIds.has(binding.remoteSkillId)) ?? null;
}

function versionOptionLabel(version: RemoteSkillVersion, latestId: string, language: LanguageMode): string {
  return version.id === latestId ? localize(language, `v${version.version} · latest`, `v${version.version} · 最新`) : `v${version.version}`;
}

function remoteVersionPreview(
  versionId: string,
  versionContent: Record<string, string>,
  loadingId: string | null,
  error: string | null,
  language: LanguageMode,
): string {
  if (versionContent[versionId] !== undefined) return skillPreviewMarkdown(versionContent[versionId], language);
  if (loadingId === versionId) return localize(language, "Loading version...", "正在加载版本...");
  if (error) return error;
  return localize(language, "Loading version...", "正在加载版本...");
}

function syncDisabledTitle(snapshot: SkillSyncSnapshot, language: LanguageMode): string {
  if (snapshot.status.kind === "missing-table") return localize(language, "Initialize the Supabase table first.", "请先初始化 Supabase 表。");
  if (snapshot.status.kind === "missing-storage") return localize(language, "Run the latest Supabase setup SQL first.", "请先执行最新的 Supabase 初始化 SQL。");
  if (snapshot.status.kind === "unconfigured") return localize(language, "Configure Supabase sync in Settings first.", "请先在设置中配置 Supabase 同步。");
  if (snapshot.status.kind === "error") return snapshot.status.message;
  return "";
}

function SkillSyncStatusPanel({
  snapshot,
  language,
  busy,
  onCopySetupSql,
  onOpenSqlEditor,
  onRefresh,
}: {
  snapshot: SkillSyncSnapshot;
  language: LanguageMode;
  busy: boolean;
  onCopySetupSql: () => void;
  onOpenSqlEditor: () => void | Promise<void>;
  onRefresh: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (snapshot.status.kind === "ready") {
    return (
      <div className="skill-sync-panel ready">
        <span>{l(`${snapshot.remoteSkillGroups.length} remote skills`, `${snapshot.remoteSkillGroups.length} 个远程 Skill`)}</span>
      </div>
    );
  }
  return (
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
  );
}

function SkillSourceBadge({ source, language }: { source: SkillSource; language: LanguageMode }): ReactElement {
  return <span className={`skill-source-badge ${source}`}>{skillSourceUiLabel(source, language)}</span>;
}

function SkillContextMenu({
  state,
  language,
  revealLabel,
  onCopyPath,
  onReveal,
  onDelete,
}: {
  state: { x: number; y: number; skill: InstalledSkill };
  language: LanguageMode;
  revealLabel: string;
  onCopyPath: () => void;
  onReveal: () => void;
  onDelete: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const canDelete = state.skill.source !== "codex-system";
  const menu = useClampedContextMenuStyle(state);
  return (
    <div
      ref={menu.ref}
      className="context-menu skill-context-menu"
      style={menu.style}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button type="button" onClick={onCopyPath}>
        <Copy size={14} /> {l("Copy Path", "复制路径")}
      </button>
      <button type="button" onClick={onReveal}>
        <FolderOpen size={14} /> {l(`Show in ${revealLabel}`, `在 ${revealLabel} 中显示`)}
      </button>
      <hr />
      <button
        type="button"
        className="danger"
        onClick={onDelete}
        disabled={!canDelete}
        title={canDelete ? l("Delete this skill", "删除这个 Skill") : l("Codex system skills cannot be deleted here.", "Codex 系统 Skill 不能在这里删除。")}
      >
        <Trash2 size={14} /> {l("Delete Skill", "删除 Skill")}
      </button>
    </div>
  );
}

function DeleteSkillDialog({
  skill,
  language,
  deleting,
  onConfirm,
  onCancel,
}: {
  skill: InstalledSkill;
  language: LanguageMode;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog delete-skill-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Delete Skill", "删除 Skill")}</span>
          <button type="button" className="icon-button" onClick={onCancel} disabled={deleting} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          {l("Delete", "删除")} <strong>{skill.name}</strong>
          {l(" permanently?", "？")}
        </p>
        <p className="dialog-copy danger-copy">
          {l("This deletes the whole skill folder and cannot be undone.", "这会删除整个 Skill 文件夹，无法撤销。")}
        </p>
        <div className="delete-skill-path" title={skill.directoryPath}>
          {skill.directoryPath}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={deleting}>
            {l("Cancel", "取消")}
          </button>
          <button type="button" className="danger-action" onClick={onConfirm} disabled={deleting}>
            {deleting ? l("Deleting...", "正在删除...") : l("Delete Permanently", "永久删除")}
          </button>
        </div>
      </div>
    </div>
  );
}

function UploadVersionConfirmDialog({
  skill,
  conflict,
  language,
  onConfirm,
  onCancel,
}: {
  skill: InstalledSkill;
  conflict: SkillSyncUploadConflict;
  language: LanguageMode;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog delete-skill-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Upload new version?", "上传新版本？")}</span>
          <button type="button" className="icon-button" onClick={onCancel} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          {l(
            `Cloud v${conflict.latestVersion} of "${skill.name}" changed after the last sync or has not been linked on this device.`,
            `"${skill.name}" 的云端 v${conflict.latestVersion} 在上次同步后发生了变化，或尚未与此设备建立同步关系。`,
          )}
        </p>
        <p className="dialog-copy danger-copy">
          {l(
            `Uploading will keep the cloud history and add your local copy as v${conflict.latestVersion + 1}.`,
            `继续上传会保留云端历史版本，并把当前本地内容保存为 v${conflict.latestVersion + 1}。`,
          )}
        </p>
        <div className="delete-skill-path" title={conflict.latestPath}>
          {l(`Latest from: ${conflict.latestPath || conflict.latestSource}`, `最新来自：${conflict.latestPath || conflict.latestSource}`)}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {l("Cancel", "取消")}
          </button>
          <button type="button" className="danger-action" onClick={onConfirm}>
            {l("Upload new version", "上传新版本")}
          </button>
        </div>
      </div>
    </div>
  );
}

function skillPreviewMarkdown(markdown: string, language: LanguageMode): string {
  const limit = 12000;
  return markdownPreview(markdown, limit, localize(language, "...(truncated)", "...（已截断）"));
}
