import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Compass, RefreshCw, Upload, X } from "lucide-react";
import type { InstalledSkill, InstalledSkillsSnapshot, SkillRootStatus, SkillSource } from "../../../../core/skill-manager";
import type { ManagedSkill, SkillInstallTarget } from "../../../../core/managed-skill-library";
import type { RemoteSkill, SkillSyncSnapshot, SkillSyncUploadOutcome } from "../../../../core/skill-sync";
import { formatCompactNumber } from "../../format-count";
import { localize, type LanguageMode } from "../../language";
import { buildUnifiedSkillEntries } from "../../skill-sync-view-model";
import type { SkillsFeedback } from "../../app-types";
import { LocalSkillsTab } from "./local-skills-tab";
import { SkillDiscoveryDialog } from "./skill-discovery-dialog";
import { SkillLibraryDetail } from "./skill-library-detail";
import {
  filterManagedSkills,
  SkillLibraryList,
  type ManagedSkillOriginFilter,
  type ManagedSkillSort,
} from "./skill-library-list";

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
  evalBadgeCounts,
  onNavigateToEval,
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
  evalBadgeCounts?: { skill: string; low: number; medium: number }[];
  onNavigateToEval?: (skillName: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const managedSkills = useMemo(() => snapshot.skills.filter(isManagedSkill), [snapshot.skills]);
  const evalBadgeCountsMap = useMemo(() => {
    const m = new Map<string, { low: number; medium: number }>();
    for (const item of evalBadgeCounts ?? []) m.set(item.skill.trim().toLowerCase(), { low: item.low, medium: item.medium });
    return m;
  }, [evalBadgeCounts]);
  const unifiedEntries = useMemo(() => buildUnifiedSkillEntries(snapshot, syncSnapshot), [snapshot, syncSnapshot]);
  const [query, setQuery] = useState("");
  const [originFilter, setOriginFilter] = useState<ManagedSkillOriginFilter>("all");
  const [sort, setSort] = useState<ManagedSkillSort>("usage");
  const [activeTab, setActiveTab] = useState<"app" | "local">("app");
  const [localSkillCount, setLocalSkillCount] = useState(0);
  const [localRefreshVersion, setLocalRefreshVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<ManagedSkill | null>(null);
  const [targetBusy, setTargetBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [appFeedback, setAppFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const filteredSkills = useMemo(
    () => filterManagedSkills(managedSkills, query, originFilter, sort),
    [managedSkills, originFilter, query, sort],
  );
  const selectedSkill = filteredSkills.find((skill) => skill.managedId === selectedId) ?? filteredSkills[0] ?? null;
  const selectedEntry = selectedSkill
    ? unifiedEntries.find((entry) => entry.local?.path === selectedSkill.path) ?? null
    : null;
  const remoteOnlyGroups = useMemo(
    () => unifiedEntries.flatMap((entry) => !entry.local && entry.remote ? [entry.remote] : []),
    [unifiedEntries],
  );
  const managedSourcePaths = useMemo(
    () => new Set(managedSkills.flatMap((skill) => skill.origin.kind === "local" && skill.origin.sourcePath
      ? [skill.origin.sourcePath]
      : [])),
    [managedSkills],
  );

  useEffect(() => {
    if (pendingSelection && managedSkills.some((skill) => skill.managedId === pendingSelection)) {
      setSelectedId(pendingSelection);
      setPendingSelection(null);
      return;
    }
    if (!selectedId || !filteredSkills.some((skill) => skill.managedId === selectedId)) {
      setSelectedId(filteredSkills[0]?.managedId ?? null);
    }
  }, [filteredSkills, managedSkills, pendingSelection, selectedId]);

  useEffect(() => {
    const existing = new Set(managedSkills.map((skill) => skill.managedId));
    setCheckedIds((current) => {
      const next = new Set([...current].filter((id) => existing.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [managedSkills]);

  const libraryChanged = (managedId: string | null) => {
    if (managedId) setPendingSelection(managedId);
    setActiveTab("app");
    onRefresh();
  };

  const updateTargets = async (skill: ManagedSkill, targets: SkillInstallTarget[]) => {
    setTargetBusy(true);
    setAppFeedback(null);
    try {
      await window.sessionSearch.updateManagedSkillTargets(skill.managedId, targets);
      setPendingSelection(skill.managedId);
      setAppFeedback({
        kind: "success",
        message: targets.length > 0
          ? l(`${skill.name} installation was updated.`, `${skill.name} 的安装位置已更新。`)
          : l(`${skill.name} was removed from every agent.`, `${skill.name} 已从所有 Agent 移除。`),
      });
      onRefresh();
    } catch (error) {
      setAppFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      setTargetBusy(false);
    }
  };

  const uploadChecked = async () => {
    const selected = managedSkills.filter((skill) => checkedIds.has(skill.managedId));
    if (selected.length === 0) return;
    setBatchBusy(true);
    setAppFeedback(null);
    try {
      const result = await onUploadSelected(selected);
      const remaining = new Set(result.remainingSkillIds);
      setCheckedIds(new Set(selected.filter((skill) => remaining.has(skill.id)).map((skill) => skill.managedId)));
    } catch (error) {
      setAppFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBatchBusy(false);
    }
  };

  const refreshActiveTab = () => {
    if (activeTab === "local") setLocalRefreshVersion((version) => version + 1);
    else onRefresh();
  };

  const confirmDelete = async () => {
    if (!deleteCandidate) return;
    const deletedId = deleteCandidate.managedId;
    try {
      await onDelete(deleteCandidate);
      setDeleteCandidate(null);
      setCheckedIds((current) => {
        const next = new Set(current);
        next.delete(deletedId);
        return next;
      });
    } catch {
      // App-level feedback already contains the actionable filesystem error.
    }
  };

  return (
    <div className="skills-page">
      <header className="app-page-head skills-page-head">
        <div><h2>Skills</h2><p>{l("Manage the Skills available to your coding agents.", "管理 AgentRecall 中的 Skill，并按需安装到各个 Agent。")}</p></div>
      </header>

      <section className="managed-skills-surface">
        <header className="managed-skills-toolbar">
          <nav className="skill-library-tabs" role="tablist" aria-label={l("Skill collections", "Skill 分类")}>
            <button
              id="app-skills-tab"
              type="button"
              className={`skill-library-tab ${activeTab === "app" ? "active" : ""}`}
              role="tab"
              aria-selected={activeTab === "app"}
              aria-controls="app-skills-panel"
              onClick={() => setActiveTab("app")}
            >
              <span>{l("App Skills", "本 App Skill")}</span><small>{formatCompactNumber(managedSkills.length)}</small>
            </button>
            <button
              id="local-skills-tab"
              type="button"
              className={`skill-library-tab ${activeTab === "local" ? "active" : ""}`}
              role="tab"
              aria-selected={activeTab === "local"}
              aria-controls="local-skills-panel"
              onClick={() => setActiveTab("local")}
            >
              <span>{l("Local Skills", "本地 Skill")}</span><small>{formatCompactNumber(localSkillCount)}</small>
            </button>
          </nav>
          <div className="managed-skills-toolbar-actions">
            <button type="button" onClick={() => setDiscoveryOpen(true)}><Compass size={14} />{l("Discover Skill", "发现 Skill")}</button>
            <button
              type="button"
              className="icon-button"
              onClick={refreshActiveTab}
              disabled={activeTab === "app" && loading}
              aria-label={activeTab === "app" ? l("Refresh app Skills", "刷新本 App Skill") : l("Refresh local Skills", "刷新本地 Skill")}
              title={activeTab === "app" ? l("Refresh app Skills", "刷新本 App Skill") : l("Refresh local Skills", "刷新本地 Skill")}
            ><RefreshCw size={14} /></button>
          </div>
        </header>

        <section
          id="app-skills-panel"
          className="skill-tab-panel"
          role="tabpanel"
          aria-labelledby="app-skills-tab"
          hidden={activeTab !== "app"}
        >
          {feedback ? <div className={`managed-skills-feedback ${feedback.kind}`}>{feedback.message}</div> : null}
          {appFeedback ? <div className={`managed-skills-feedback ${appFeedback.kind}`}>{appFeedback.message}</div> : null}
          {checkedIds.size > 0 ? (
            <div className="managed-skills-batch-bar">
              <span>{l(`${checkedIds.size} selected`, `已选择 ${checkedIds.size} 个`)}</span>
              <button type="button" onClick={() => void uploadChecked()} disabled={loading || batchBusy || syncSnapshot.status.kind !== "ready"}><Upload size={13} />{l("Upload selected", "上传所选")}</button>
              <button type="button" onClick={() => setCheckedIds(new Set())}>{l("Clear", "清空")}</button>
            </div>
          ) : null}

          <div className="managed-skills-grid">
            <SkillLibraryList
              skills={filteredSkills}
              selectedId={selectedSkill?.managedId ?? null}
              selectedIds={checkedIds}
              query={query}
              originFilter={originFilter}
              sort={sort}
              loading={loading}
              language={language}
              onQueryChange={setQuery}
              onOriginFilterChange={setOriginFilter}
              onSortChange={setSort}
              onSelect={setSelectedId}
              onToggleChecked={(managedId) => setCheckedIds((current) => {
                const next = new Set(current);
                if (next.has(managedId)) next.delete(managedId);
                else next.add(managedId);
                return next;
              })}
              evalBadgeCounts={evalBadgeCountsMap}
              onNavigateToEval={onNavigateToEval}
            />
            <SkillLibraryDetail
              skill={selectedSkill}
              entry={selectedEntry}
              remoteOnlyGroups={remoteOnlyGroups}
              syncSnapshot={syncSnapshot}
              busy={loading || batchBusy}
              targetBusy={targetBusy}
              language={language}
              revealLabel={revealLabel}
              onUpdateTargets={updateTargets}
              onUpload={(skill, force) => onUpload(skill, force)}
              onInstallRemote={onInstallRemote}
              onFetchVersion={onFetchVersion}
              onRefreshRemote={onRefreshRemote}
              onCopySetupSql={onCopySetupSql}
              onOpenSqlEditor={onOpenSqlEditor}
              onCopyPath={onCopyPath}
              onReveal={onReveal}
              onRequestDelete={setDeleteCandidate}
            />
          </div>
        </section>

        <LocalSkillsTab
          active={activeTab === "local"}
          managedSourcePaths={managedSourcePaths}
          refreshVersion={localRefreshVersion}
          language={language}
          revealLabel={revealLabel}
          onCountChange={setLocalSkillCount}
          onImported={libraryChanged}
          onCopyPath={onCopyPath}
          onReveal={onReveal}
        />
      </section>

      <SkillDiscoveryDialog open={discoveryOpen} language={language} onClose={() => setDiscoveryOpen(false)} onImported={libraryChanged} />
      {deleteCandidate ? (
        <div className="dialog-backdrop managed-skill-dialog-backdrop" onMouseDown={() => setDeleteCandidate(null)}>
          <section className="command-dialog managed-skill-delete-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header><h3>{l("Delete from Skill library?", "从 Skill 库删除？")}</h3><button type="button" className="icon-button" onClick={() => setDeleteCandidate(null)}><X size={16} /></button></header>
            <p>{l(`AgentRecall will delete “${deleteCandidate.name}” and remove only links it owns. Existing conflicting folders remain untouched.`, `AgentRecall 会删除“${deleteCandidate.name}”，并只移除自己创建的链接；有冲突的原目录不会被修改。`)}</p>
            <code title={deleteCandidate.directoryPath}>{deleteCandidate.directoryPath}</code>
            <footer><button type="button" onClick={() => setDeleteCandidate(null)}>{l("Cancel", "取消")}</button><button type="button" className="danger-action" onClick={() => void confirmDelete()}>{l("Delete", "删除")}</button></footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export function isManagedSkill(skill: InstalledSkill): skill is ManagedSkill {
  if (skill.source !== "agent-recall-v2") return false;
  const candidate = skill as Partial<ManagedSkill>;
  return typeof candidate.managedId === "string"
    && Boolean(candidate.origin)
    && Array.isArray(candidate.installations);
}

export function summarizeSkillRoots(roots: SkillRootStatus[]): SkillRootStatus[] {
  const visible: SkillRootStatus[] = [];
  const projectRoots = new Map<SkillSource, SkillRootStatus[]>();
  for (const root of roots) {
    if (root.source !== "codex-project" && root.source !== "claude-project") {
      visible.push(root);
      continue;
    }
    const group = projectRoots.get(root.source) ?? [];
    group.push(root);
    projectRoots.set(root.source, group);
  }
  for (const [source, group] of projectRoots) {
    const existing = group.filter((root) => root.exists);
    const skillCount = group.reduce((sum, root) => sum + root.skillCount, 0);
    if (existing.length === 0 && skillCount === 0) continue;
    visible.push({
      agent: group[0].agent,
      source,
      path: (existing.length > 0 ? existing : group).map((root) => root.path).join("\n"),
      exists: existing.length > 0,
      skillCount,
    });
  }
  return visible;
}
