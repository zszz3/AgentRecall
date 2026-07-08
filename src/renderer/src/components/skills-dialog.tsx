import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import { Copy, Download, FolderOpen, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import type { RemoteSkill, RemoteSkillGroup, RemoteSkillVersion, SkillSyncSnapshot, SkillSyncUploadConflict, SkillSyncUploadOutcome } from "../../../core/skill-sync";
import type { InstalledSkill, InstalledSkillsSnapshot, SkillRootStatus, SkillSource } from "../../../core/skill-manager";
import { formatCompactNumber } from "../format-count";
import { localize, type LanguageMode } from "../language";
import { filterInstalledSkills, sortInstalledSkills, skillSourceLabel, type SkillSortKey, type SkillSourceFilter } from "../skill-manager";
import type { SkillsFeedback } from "../app-types";
import { useClampedContextMenuStyle } from "../context-menu-position";

export function SkillsDialog({
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
  onCopyPath,
  onReveal,
  onDelete,
  onClose,
}: {
  snapshot: InstalledSkillsSnapshot;
  syncSnapshot: SkillSyncSnapshot;
  loading: boolean;
  feedback: SkillsFeedback;
  language: LanguageMode;
  revealLabel: string;
  onRefresh: () => void;
  onUpload: (skill: InstalledSkill, force?: boolean) => Promise<SkillSyncUploadOutcome | null>;
  onUploadSelected: (skills: InstalledSkill[]) => Promise<void>;
  onInstallRemote: (remoteSkillId: string) => Promise<void>;
  onFetchVersion: (remoteSkillId: string) => Promise<RemoteSkill>;
  onRefreshRemote: () => void;
  onCopySetupSql: () => void;
  onCopyPath: (skillPath: string) => void;
  onReveal: (skillPath: string) => void;
  onDelete: (skill: InstalledSkill) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [query, setQuery] = useState("");
  const [syncView, setSyncView] = useState<"local" | "remote">("local");
  const [sourceFilter, setSourceFilter] = useState<SkillSourceFilter>("all");
  const [sortKey, setSortKey] = useState<SkillSortKey>("usage");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(() => new Set());
  const [selectedGroupFingerprint, setSelectedGroupFingerprint] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [versionContent, setVersionContent] = useState<Record<string, string>>({});
  const [versionLoadingId, setVersionLoadingId] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [skillContextMenu, setSkillContextMenu] = useState<{ x: number; y: number; skill: InstalledSkill } | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<InstalledSkill | null>(null);
  const [deletingSkill, setDeletingSkill] = useState(false);
  const [uploadConfirm, setUploadConfirm] = useState<{ skill: InstalledSkill; conflict: SkillSyncUploadConflict } | null>(null);
  const filteredSkills = useMemo(() => {
    const filtered = filterInstalledSkills(snapshot.skills, query, sourceFilter);
    return sortInstalledSkills(filtered, sortKey);
  }, [snapshot.skills, query, sourceFilter, sortKey]);
  const visibleRoots = useMemo(() => summarizeSkillRoots(snapshot.roots), [snapshot.roots]);
  const remoteGroups = useMemo(() => filterRemoteSkillGroups(syncSnapshot.remoteSkillGroups, query), [syncSnapshot.remoteSkillGroups, query]);
  const selectedSkill =
    filteredSkills.find((skill) => skill.id === selectedSkillId) ??
    filteredSkills[0] ??
    null;
  const selectedGroup =
    remoteGroups.find((group) => group.fingerprint === selectedGroupFingerprint) ??
    remoteGroups[0] ??
    null;
  const selectedVersion =
    selectedGroup?.versions.find((version) => version.id === selectedVersionId) ?? selectedGroup?.latest ?? null;
  const selectedSkillBinding = selectedSkill ? syncSnapshot.bindings.find((binding) => binding.localSkillPath === selectedSkill.path) : null;
  const selectedGroupBinding = selectedGroup ? bindingForGroup(syncSnapshot, selectedGroup) : null;
  const uploadableVisibleSkills = useMemo(() => filteredSkills.filter((skill) => skill.source !== "codex-system"), [filteredSkills]);
  const selectedUploadableSkills = useMemo(() => uploadableVisibleSkills.filter((skill) => selectedSkillIds.has(skill.id)), [selectedSkillIds, uploadableVisibleSkills]);
  const allUploadableVisibleSelected = uploadableVisibleSkills.length > 0 && selectedUploadableSkills.length === uploadableVisibleSkills.length;
  const syncReady = syncSnapshot.status.kind === "ready";
  const codexCount = snapshot.skills.filter((skill) => skill.agent === "codex").length;
  const claudeCount = snapshot.skills.filter((skill) => skill.agent === "claude").length;
  const activeItemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filteredSkills.length) {
      if (selectedSkillId) setSelectedSkillId(null);
      return;
    }
    if (!selectedSkillId || !filteredSkills.some((skill) => skill.id === selectedSkillId)) setSelectedSkillId(filteredSkills[0].id);
  }, [filteredSkills, selectedSkillId]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedSkill?.id]);

  useEffect(() => {
    const uploadableIds = new Set(uploadableVisibleSkills.map((skill) => skill.id));
    setSelectedSkillIds((current) => {
      const next = new Set([...current].filter((id) => uploadableIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [uploadableVisibleSkills]);

  useEffect(() => {
    if (!remoteGroups.length) {
      if (selectedGroupFingerprint) setSelectedGroupFingerprint(null);
      return;
    }
    if (!selectedGroupFingerprint || !remoteGroups.some((group) => group.fingerprint === selectedGroupFingerprint)) {
      setSelectedGroupFingerprint(remoteGroups[0].fingerprint);
    }
  }, [remoteGroups, selectedGroupFingerprint]);

  // Default to the latest version whenever the selected skill group changes.
  useEffect(() => {
    if (!selectedGroup) {
      if (selectedVersionId) setSelectedVersionId(null);
      return;
    }
    if (!selectedVersionId || !selectedGroup.versions.some((version) => version.id === selectedVersionId)) {
      setSelectedVersionId(selectedGroup.latest.id);
    }
  }, [selectedGroup, selectedVersionId]);

  // The version list is lightweight (no markdown); fetch the body on demand for preview.
  useEffect(() => {
    const id = selectedVersion?.id;
    if (!id || versionContent[id] !== undefined) return;
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
  }, [selectedVersion?.id, versionContent, onFetchVersion]);

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
    if (syncView !== "local") return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!filteredSkills.length) return;
    event.preventDefault();
    const currentIndex = filteredSkills.findIndex((skill) => skill.id === selectedSkill?.id);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = Math.min(filteredSkills.length - 1, Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + delta));
    setSelectedSkillId(filteredSkills[nextIndex].id);
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

  const toggleSkillSelection = (skill: InstalledSkill) => {
    if (skill.source === "codex-system") return;
    setSelectedSkillIds((current) => {
      const next = new Set(current);
      if (next.has(skill.id)) next.delete(skill.id);
      else next.add(skill.id);
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedSkillIds((current) => {
      const next = new Set(current);
      if (allUploadableVisibleSelected) {
        for (const skill of uploadableVisibleSkills) next.delete(skill.id);
      } else {
        for (const skill of uploadableVisibleSkills) next.add(skill.id);
      }
      return next;
    });
  };

  const confirmUpload = async () => {
    if (!uploadConfirm) return;
    const { skill } = uploadConfirm;
    setUploadConfirm(null);
    await onUpload(skill, true);
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section
        className="command-dialog skills-dialog"
        onMouseDown={(event) => {
          event.stopPropagation();
          setSkillContextMenu(null);
        }}
        onKeyDown={handleListKeyDown}
      >
        <div className="dialog-title">
          <span>{l("Skills", "Skills 管理")}</span>
          <span className="skills-dialog-count">
            Codex {formatCompactNumber(codexCount)} · Claude Code {formatCompactNumber(claudeCount)} · Remote {formatCompactNumber(syncSnapshot.remoteSkillGroups.length)}
          </span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>

        <div className="skills-view-tabs" role="tablist" aria-label={l("Skills view", "Skills 视图")}>
          <button type="button" className={syncView === "local" ? "active" : ""} onClick={() => setSyncView("local")}>
            {l("Local", "本地")}
          </button>
          <button type="button" className={syncView === "remote" ? "active" : ""} onClick={() => setSyncView("remote")}>
            {l("Remote", "远程")}
          </button>
        </div>

        <div className="skills-toolbar">
          <label className="skills-search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={l("Search name, description, or path", "搜索名称、描述或路径")} autoFocus />
          </label>
          <div className="skills-filter" role="group" aria-label={l("Skill source filter", "Skill 来源筛选")}>
            {syncView === "local"
              ? SKILL_SOURCE_FILTERS.map((filter) => (
                  <button key={filter} className={sourceFilter === filter ? "active" : ""} onClick={() => setSourceFilter(filter)}>
                    {skillFilterLabel(filter, language)}
                  </button>
                ))
              : null}
          </div>
          {syncView === "local" ? <label className="skills-sort" title={l("Sort skills", "排序 Skills")}>
            <span>{l("Sort", "排序")}</span>
            <select value={sortKey} onChange={(event) => setSortKey(event.currentTarget.value as SkillSortKey)} aria-label={l("Sort skills", "排序 Skills")}>
              <option value="usage">{l("Most used", "最多使用")}</option>
              <option value="usage-asc">{l("Least used", "最少使用")}</option>
            </select>
          </label> : null}
          {syncView === "local" ? (
            <button
              type="button"
              className="settings-action-button"
              onClick={toggleVisibleSelection}
              disabled={loading || uploadableVisibleSkills.length === 0}
              title={l("Select visible non-system skills", "选择当前可见的非系统 Skills")}
            >
              <span>{allUploadableVisibleSelected ? l("Clear selected", "清空选择") : l("Select visible", "选择当前可见")}</span>
            </button>
          ) : null}
          {syncView === "local" ? (
            <button
              type="button"
              className="settings-action-button"
              onClick={() => void onUploadSelected(selectedUploadableSkills)}
              disabled={!syncReady || loading || selectedUploadableSkills.length === 0}
              title={!syncReady ? syncDisabledTitle(syncSnapshot, language) : l("Upload selected non-system skills", "上传选中的非系统 Skills")}
            >
              <Upload size={13} />
              <span>{l(`Upload selected (${selectedUploadableSkills.length})`, `上传选中（${selectedUploadableSkills.length}）`)}</span>
            </button>
          ) : null}
          <button className="stats-refresh" onClick={syncView === "local" ? onRefresh : onRefreshRemote} disabled={loading} title={l("Refresh skills", "刷新 Skills")} aria-label={l("Refresh skills", "刷新 Skills")}>
            <RefreshCw size={13} />
          </button>
        </div>

        {syncView === "local" ? <div className="skills-roots">
          {visibleRoots.map((root) => (
            <span key={`${root.source}:${root.path}`} className={root.exists ? "" : "missing"} title={root.path}>
              <strong>{skillSourceUiLabel(root.source, language)}</strong>
              {root.exists ? l(`${root.skillCount} skills`, `${root.skillCount} 个`) : l("Missing", "未找到")}
            </span>
          ))}
        </div> : <SkillSyncStatusPanel snapshot={syncSnapshot} language={language} onCopySetupSql={onCopySetupSql} />}

        {feedback ? <div className={`skills-feedback ${feedback.kind}`}>{feedback.message}</div> : null}
        <div className="skills-shell">
          <div className="skills-list">
            {loading ? <div className="skills-empty">{syncView === "local" ? l("Loading installed skills...", "正在加载已安装 Skills...") : l("Loading remote skills...", "正在加载远程 Skills...")}</div> : null}
            {!loading && syncView === "local" && filteredSkills.length === 0 ? <div className="skills-empty">{l("No skills found.", "没有找到 Skill。")}</div> : null}
            {!loading && syncView === "remote" && remoteGroups.length === 0 ? <div className="skills-empty">{remoteEmptyLabel(syncSnapshot, language)}</div> : null}
            {!loading && syncView === "local"
              ? filteredSkills.map((skill) => (
                  <div
                    key={skill.id}
                    ref={selectedSkill?.id === skill.id ? activeItemRef : undefined}
                    role="button"
                    tabIndex={0}
                    className={`skill-item ${selectedSkill?.id === skill.id ? "active" : ""}`}
                    onClick={() => setSelectedSkillId(skill.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedSkillId(skill.id);
                      }
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setSelectedSkillId(skill.id);
                      setSkillContextMenu({ x: event.clientX, y: event.clientY, skill });
                    }}
                  >
                    <span className="skill-item-head">
                      <label className="skill-select" title={skill.source === "codex-system" ? l("System skills are excluded from upload", "系统内置 Skills 不参与上传") : l("Select for upload", "选择上传")}>
                        <input
                          type="checkbox"
                          checked={selectedSkillIds.has(skill.id)}
                          disabled={skill.source === "codex-system"}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleSkillSelection(skill)}
                          aria-label={l(`Select ${skill.name}`, `选择 ${skill.name}`)}
                        />
                      </label>
                      <strong>{skill.name}</strong>
                      {skill.usageCount ? <span className="skill-usage-count" title={l("Times used", "使用次数")}>{formatCompactNumber(skill.usageCount)}</span> : null}
                      <SkillSourceBadge source={skill.source} language={language} />
                    </span>
                    <span className="skill-item-desc">{skill.description || l("No description", "无描述")}</span>
                    <span className="skill-item-path">{skill.path}</span>
                  </div>
                ))
              : null}
            {!loading && syncView === "remote"
              ? remoteGroups.map((group) => {
                  const binding = bindingForGroup(syncSnapshot, group);
                  return (
                    <button
                      key={group.fingerprint}
                      type="button"
                      className={`skill-item ${selectedGroup?.fingerprint === group.fingerprint ? "active" : ""}`}
                      onClick={() => setSelectedGroupFingerprint(group.fingerprint)}
                    >
                      <span className="skill-item-head">
                        <strong>{group.name}</strong>
                        <span className="skill-usage-count" title={l("Latest version", "最新版本")}>v{group.latest.version}</span>
                        {binding ? <span className="skill-usage-count">{l(`Local v${binding.remoteVersion}`, `本地 v${binding.remoteVersion}`)}</span> : null}
                        <span className={`skill-source-badge ${group.source}`}>{group.agent === "codex" ? "Codex" : "Claude Code"}</span>
                      </span>
                      <span className="skill-item-desc">{group.description || l("No description", "无描述")}</span>
                      <span className="skill-item-path">
                        {l(`${group.versions.length} versions`, `${group.versions.length} 个版本`)} · {new Date(group.latest.updatedAt).toLocaleString()}
                      </span>
                    </button>
                  );
                })
              : null}
          </div>

          <div className="skill-preview">
            {syncView === "local" && selectedSkill ? (
              <>
                <div className="skill-preview-head">
                  <div>
                    <div className="skill-preview-title">
                      <h3>{selectedSkill.name}</h3>
                      <SkillSourceBadge source={selectedSkill.source} language={language} />
                    </div>
                    <p>{selectedSkill.description || l("No description", "无描述")}</p>
                  </div>
                  <div className="skill-preview-actions">
                    <button type="button" disabled={!syncReady || loading} onClick={() => void handleUpload(selectedSkill)} title={!syncReady ? syncDisabledTitle(syncSnapshot, language) : ""}>
                      <Upload size={14} />
                      {selectedSkillBinding ? l("Upload new version", "上传新版本") : l("Upload", "上传")}
                    </button>
                  </div>
                </div>
                <dl className="skill-meta">
                  <div>
                    <dt>{l("Agent", "Agent")}</dt>
                    <dd>{selectedSkill.agent === "codex" ? "Codex" : "Claude Code"}</dd>
                  </div>
                  <div>
                    <dt>{l("Used", "使用次数")}</dt>
                    <dd>
                      {selectedSkill.usageCount
                        ? l(`${selectedSkill.usageCount} times`, `${selectedSkill.usageCount} 次`) + (selectedSkill.lastUsedAt ? ` · ${new Date(selectedSkill.lastUsedAt).toLocaleString()}` : "")
                        : l("Not yet", "暂无")}
                    </dd>
                  </div>
                  <div>
                    <dt>{l("Updated", "更新时间")}</dt>
                    <dd>{new Date(selectedSkill.mtimeMs).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>{l("Path", "路径")}</dt>
                    <dd title={selectedSkill.path}>{selectedSkill.path}</dd>
                  </div>
                  {selectedSkillBinding ? (
                    <div>
                      <dt>{l("Remote", "远程")}</dt>
                      <dd>{l(`v${selectedSkillBinding.remoteVersion} · ${new Date(selectedSkillBinding.lastSyncedAt).toLocaleString()}`, `v${selectedSkillBinding.remoteVersion} · ${new Date(selectedSkillBinding.lastSyncedAt).toLocaleString()}`)}</dd>
                    </div>
                  ) : null}
                </dl>
                <pre className="skill-markdown-preview">{skillPreviewMarkdown(selectedSkill.markdown, language)}</pre>
              </>
            ) : syncView === "remote" && selectedGroup && selectedVersion ? (
              <>
                <div className="skill-preview-head">
                  <div>
                    <div className="skill-preview-title">
                      <h3>{selectedGroup.name}</h3>
                      <span className={`skill-source-badge ${selectedGroup.source}`}>{selectedGroup.agent === "codex" ? "Codex" : "Claude Code"}</span>
                    </div>
                    <p>{selectedGroup.description || l("No description", "无描述")}</p>
                  </div>
                  <div className="skill-preview-actions">
                    <label className="skills-sort" title={l("Version", "版本")}>
                      <span>{l("Version", "版本")}</span>
                      <select
                        value={selectedVersion.id}
                        onChange={(event) => setSelectedVersionId(event.currentTarget.value)}
                        aria-label={l("Select version", "选择版本")}
                      >
                        {selectedGroup.versions.map((version) => (
                          <option key={version.id} value={version.id}>
                            {versionOptionLabel(version, selectedGroup.latest.id, language)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" disabled={!syncReady || loading} onClick={() => void onInstallRemote(selectedVersion.id)}>
                      <Download size={14} />
                      {selectedGroupBinding ? l("Update local", "更新本地") : l("Install locally", "安装到本地")}
                    </button>
                  </div>
                </div>
                <dl className="skill-meta">
                  <div>
                    <dt>{l("Agent", "Agent")}</dt>
                    <dd>{selectedGroup.agent === "codex" ? "Codex" : "Claude Code"}</dd>
                  </div>
                  <div>
                    <dt>{l("Version", "版本")}</dt>
                    <dd>{versionOptionLabel(selectedVersion, selectedGroup.latest.id, language)}</dd>
                  </div>
                  <div>
                    <dt>{l("Updated", "更新时间")}</dt>
                    <dd>{new Date(selectedVersion.updatedAt).toLocaleString()}</dd>
                  </div>
                  {selectedGroupBinding ? (
                    <div>
                      <dt>{l("Local", "本地")}</dt>
                      <dd title={selectedGroupBinding.localSkillPath}>{l(`v${selectedGroupBinding.remoteVersion}`, `v${selectedGroupBinding.remoteVersion}`)} · {selectedGroupBinding.localSkillPath}</dd>
                    </div>
                  ) : null}
                </dl>
                <pre className="skill-markdown-preview">{remoteVersionPreview(selectedVersion.id, versionContent, versionLoadingId, versionError, language)}</pre>
              </>
            ) : (
              <div className="skills-empty">{l("Select a skill to preview it.", "选择一个 Skill 查看内容。")}</div>
            )}
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
      </section>
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

function bindingForGroup(snapshot: SkillSyncSnapshot, group: RemoteSkillGroup) {
  const versionIds = new Set(group.versions.map((version) => version.id));
  return snapshot.bindings.find((binding) => versionIds.has(binding.remoteSkillId)) ?? null;
}

function versionOptionLabel(version: RemoteSkillVersion, latestId: string, language: LanguageMode): string {
  return version.id === latestId ? localize(language, `v${version.version} · latest`, `v${version.version} · 最新`) : `v${version.version}`;
}

function filterRemoteSkillGroups(groups: RemoteSkillGroup[], query: string): RemoteSkillGroup[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return groups;
  return groups.filter((group) =>
    [group.name, group.description, group.agent, group.source, group.fingerprint].join("\n").toLowerCase().includes(normalizedQuery),
  );
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
  if (snapshot.status.kind === "unconfigured") return localize(language, "Configure Supabase sync in Settings first.", "请先在设置中配置 Supabase 同步。");
  if (snapshot.status.kind === "error") return snapshot.status.message;
  return "";
}

function remoteEmptyLabel(snapshot: SkillSyncSnapshot, language: LanguageMode): string {
  if (snapshot.status.kind === "ready") return localize(language, "No remote skills found.", "没有远程 Skill。");
  return syncDisabledTitle(snapshot, language);
}

function SkillSyncStatusPanel({
  snapshot,
  language,
  onCopySetupSql,
}: {
  snapshot: SkillSyncSnapshot;
  language: LanguageMode;
  onCopySetupSql: () => void;
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
    <div className={`skill-sync-panel ${snapshot.status.kind}`}>
      <span>{snapshot.status.message}</span>
      {snapshot.status.kind === "missing-table" ? (
        <button type="button" className="setup-copy-button" onClick={onCopySetupSql}>
          <Copy size={14} />
          {l("Copy setup SQL", "复制初始化 SQL")}
        </button>
      ) : null}
    </div>
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
            `The latest remote version (v${conflict.latestVersion}) of "${skill.name}" was uploaded from a different skill.`,
            `"${skill.name}" 的最新远程版本（v${conflict.latestVersion}）是从另一个 Skill 上传的。`,
          )}
        </p>
        <p className="dialog-copy danger-copy">
          {l(
            `Uploading will add v${conflict.latestVersion + 1} to the same skill (matched by name).`,
            `上传会把 v${conflict.latestVersion + 1} 追加到同一个 Skill（按名称匹配）。`,
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
  if (markdown.length <= limit) return markdown;
  return `${markdown.slice(0, limit)}\n\n${localize(language, "...(truncated)", "...（已截断）")}`;
}
