import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import { Copy, Download, FolderOpen, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import type { RemoteSkill, SkillSyncSnapshot } from "../../../core/skill-sync";
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
  onInstallRemote,
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
  onUpload: (skill: InstalledSkill) => Promise<void>;
  onInstallRemote: (remoteSkillId: string) => Promise<void>;
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
  const [selectedRemoteId, setSelectedRemoteId] = useState<string | null>(null);
  const [skillContextMenu, setSkillContextMenu] = useState<{ x: number; y: number; skill: InstalledSkill } | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<InstalledSkill | null>(null);
  const [deletingSkill, setDeletingSkill] = useState(false);
  const filteredSkills = useMemo(() => {
    const filtered = filterInstalledSkills(snapshot.skills, query, sourceFilter);
    return sortInstalledSkills(filtered, sortKey);
  }, [snapshot.skills, query, sourceFilter, sortKey]);
  const visibleRoots = useMemo(() => summarizeSkillRoots(snapshot.roots), [snapshot.roots]);
  const remoteSkills = useMemo(() => filterRemoteSkills(syncSnapshot.remoteSkills, query), [syncSnapshot.remoteSkills, query]);
  const selectedSkill =
    filteredSkills.find((skill) => skill.id === selectedSkillId) ??
    filteredSkills[0] ??
    null;
  const selectedRemote =
    remoteSkills.find((skill) => skill.id === selectedRemoteId) ??
    remoteSkills[0] ??
    null;
  const selectedSkillBinding = selectedSkill ? syncSnapshot.bindings.find((binding) => binding.localSkillPath === selectedSkill.path) : null;
  const selectedRemoteBinding = selectedRemote ? syncSnapshot.bindings.find((binding) => binding.remoteSkillId === selectedRemote.id) : null;
  const syncReady = syncSnapshot.status.kind === "ready";
  const codexCount = snapshot.skills.filter((skill) => skill.agent === "codex").length;
  const claudeCount = snapshot.skills.filter((skill) => skill.agent === "claude").length;
  const activeItemRef = useRef<HTMLButtonElement>(null);

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
    if (!remoteSkills.length) {
      if (selectedRemoteId) setSelectedRemoteId(null);
      return;
    }
    if (!selectedRemoteId || !remoteSkills.some((skill) => skill.id === selectedRemoteId)) setSelectedRemoteId(remoteSkills[0].id);
  }, [remoteSkills, selectedRemoteId]);

  const handleListKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      if (deleteCandidate) setDeleteCandidate(null);
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
            Codex {formatCompactNumber(codexCount)} · Claude Code {formatCompactNumber(claudeCount)} · Remote {formatCompactNumber(syncSnapshot.remoteSkills.length)}
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
            {!loading && syncView === "remote" && remoteSkills.length === 0 ? <div className="skills-empty">{remoteEmptyLabel(syncSnapshot, language)}</div> : null}
            {!loading && syncView === "local"
              ? filteredSkills.map((skill) => (
                  <button
                    key={skill.id}
                    ref={selectedSkill?.id === skill.id ? activeItemRef : undefined}
                    type="button"
                    className={`skill-item ${selectedSkill?.id === skill.id ? "active" : ""}`}
                    onClick={() => setSelectedSkillId(skill.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setSelectedSkillId(skill.id);
                      setSkillContextMenu({ x: event.clientX, y: event.clientY, skill });
                    }}
                  >
                    <span className="skill-item-head">
                      <strong>{skill.name}</strong>
                      {skill.usageCount ? <span className="skill-usage-count" title={l("Times used", "使用次数")}>{formatCompactNumber(skill.usageCount)}</span> : null}
                      <SkillSourceBadge source={skill.source} language={language} />
                    </span>
                    <span className="skill-item-desc">{skill.description || l("No description", "无描述")}</span>
                    <span className="skill-item-path">{skill.path}</span>
                  </button>
                ))
              : null}
            {!loading && syncView === "remote"
              ? remoteSkills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    className={`skill-item ${selectedRemote?.id === skill.id ? "active" : ""}`}
                    onClick={() => setSelectedRemoteId(skill.id)}
                  >
                    <span className="skill-item-head">
                      <strong>{skill.name}</strong>
                      {syncSnapshot.bindings.some((binding) => binding.remoteSkillId === skill.id) ? <span className="skill-usage-count">{l("Local", "本地")}</span> : null}
                      <span className={`skill-source-badge ${skill.source}`}>{skill.agent === "codex" ? "Codex" : "Claude Code"}</span>
                    </span>
                    <span className="skill-item-desc">{skill.description || l("No description", "无描述")}</span>
                    <span className="skill-item-path">{new Date(skill.updatedAt).toLocaleString()}</span>
                  </button>
                ))
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
                    <button type="button" disabled={!syncReady || loading} onClick={() => void onUpload(selectedSkill)} title={!syncReady ? syncDisabledTitle(syncSnapshot, language) : ""}>
                      <Upload size={14} />
                      {selectedSkillBinding ? l("Update remote", "更新远程") : l("Upload", "上传")}
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
                      <dd>{new Date(selectedSkillBinding.lastSyncedAt).toLocaleString()}</dd>
                    </div>
                  ) : null}
                </dl>
                <pre className="skill-markdown-preview">{skillPreviewMarkdown(selectedSkill.markdown, language)}</pre>
              </>
            ) : syncView === "remote" && selectedRemote ? (
              <>
                <div className="skill-preview-head">
                  <div>
                    <div className="skill-preview-title">
                      <h3>{selectedRemote.name}</h3>
                      <span className={`skill-source-badge ${selectedRemote.source}`}>{selectedRemote.agent === "codex" ? "Codex" : "Claude Code"}</span>
                    </div>
                    <p>{selectedRemote.description || l("No description", "无描述")}</p>
                  </div>
                  <div className="skill-preview-actions">
                    <button type="button" disabled={!syncReady || loading} onClick={() => void onInstallRemote(selectedRemote.id)}>
                      <Download size={14} />
                      {selectedRemoteBinding ? l("Update local", "更新本地") : l("Install locally", "安装到本地")}
                    </button>
                  </div>
                </div>
                <dl className="skill-meta">
                  <div>
                    <dt>{l("Agent", "Agent")}</dt>
                    <dd>{selectedRemote.agent === "codex" ? "Codex" : "Claude Code"}</dd>
                  </div>
                  <div>
                    <dt>{l("Updated", "更新时间")}</dt>
                    <dd>{new Date(selectedRemote.updatedAt).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>{l("Remote ID", "远程 ID")}</dt>
                    <dd title={selectedRemote.id}>{selectedRemote.id}</dd>
                  </div>
                  {selectedRemoteBinding ? (
                    <div>
                      <dt>{l("Local", "本地")}</dt>
                      <dd title={selectedRemoteBinding.localSkillPath}>{selectedRemoteBinding.localSkillPath}</dd>
                    </div>
                  ) : null}
                </dl>
                <pre className="skill-markdown-preview">{skillPreviewMarkdown(selectedRemote.markdown, language)}</pre>
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

function filterRemoteSkills(skills: RemoteSkill[], query: string): RemoteSkill[] {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? skills.filter((skill) => [skill.name, skill.description, skill.agent, skill.source, skill.id].join("\n").toLowerCase().includes(normalizedQuery))
    : skills;
  return [...filtered].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.name.localeCompare(b.name));
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
        <span>{l(`${snapshot.remoteSkills.length} remote skills`, `${snapshot.remoteSkills.length} 个远程 Skill`)}</span>
      </div>
    );
  }
  return (
    <div className={`skill-sync-panel ${snapshot.status.kind}`}>
      <span>{snapshot.status.message}</span>
      {snapshot.status.kind === "missing-table" ? (
        <button type="button" onClick={onCopySetupSql}>
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

function skillPreviewMarkdown(markdown: string, language: LanguageMode): string {
  const limit = 12000;
  if (markdown.length <= limit) return markdown;
  return `${markdown.slice(0, limit)}\n\n${localize(language, "...(truncated)", "...（已截断）")}`;
}
