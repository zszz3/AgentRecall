import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Compass, Download, RefreshCw, Upload, X } from "lucide-react";
import type { InstalledSkill, InstalledSkillsSnapshot, SkillRootStatus, SkillSource } from "../../../../core/skill-manager";
import type { ManagedSkill, SkillInstallTarget } from "../../../../core/managed-skill-library";
import type { RemoteSkill, SkillSyncSnapshot, SkillSyncUploadOutcome } from "../../../../core/skill-sync";
import { formatCompactNumber } from "../../format-count";
import { localize, type LanguageMode } from "../../language";
import { buildUnifiedSkillEntries } from "../../skill-sync-view-model";
import type { SkillsFeedback } from "../../app-types";
import { SkillDiscoveryDialog } from "./skill-discovery-dialog";
import { SkillImportDialog } from "./skill-import-dialog";
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
  const managedSkills = useMemo(() => snapshot.skills.filter(isManagedSkill), [snapshot.skills]);
  const unifiedEntries = useMemo(() => buildUnifiedSkillEntries(snapshot, syncSnapshot), [snapshot, syncSnapshot]);
  const [query, setQuery] = useState("");
  const [originFilter, setOriginFilter] = useState<ManagedSkillOriginFilter>("all");
  const [sort, setSort] = useState<ManagedSkillSort>("usage");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<ManagedSkill | null>(null);
  const [targetBusy, setTargetBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [localFeedback, setLocalFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
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
    onRefresh();
  };

  const toggleTarget = async (skill: ManagedSkill, target: SkillInstallTarget) => {
    const installed = new Set(skill.installations.filter((item) => item.state === "installed").map((item) => item.target));
    if (installed.has(target)) installed.delete(target);
    else installed.add(target);
    setTargetBusy(true);
    setLocalFeedback(null);
    try {
      await window.sessionSearch.updateManagedSkillTargets(skill.managedId, [...installed]);
      setPendingSelection(skill.managedId);
      setLocalFeedback({
        kind: "success",
        message: installed.has(target)
          ? l(`${skill.name} is now available in ${targetLabel(target)}.`, `${skill.name} 已安装到 ${targetLabel(target)}。`)
          : l(`${skill.name} was removed from ${targetLabel(target)}.`, `${skill.name} 已从 ${targetLabel(target)} 移除。`),
      });
      onRefresh();
    } catch (error) {
      setLocalFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTargetBusy(false);
    }
  };

  const uploadChecked = async () => {
    const selected = managedSkills.filter((skill) => checkedIds.has(skill.managedId));
    if (selected.length === 0) return;
    setBatchBusy(true);
    setLocalFeedback(null);
    try {
      const result = await onUploadSelected(selected);
      const remaining = new Set(result.remainingSkillIds);
      setCheckedIds(new Set(selected.filter((skill) => remaining.has(skill.id)).map((skill) => skill.managedId)));
    } catch (error) {
      setLocalFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBatchBusy(false);
    }
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
          <div className="managed-skills-heading">
            <strong>{l("Skill library", "Skill 库")}</strong>
            <span>{formatCompactNumber(managedSkills.length)} {l("managed", "个托管 Skill")}</span>
          </div>
          <div className="managed-skills-toolbar-actions">
            <button type="button" onClick={() => setDiscoveryOpen(true)}><Compass size={14} />{l("Discover Skill", "发现 Skill")}</button>
            <button type="button" className="primary" onClick={() => setImportOpen(true)}><Download size={14} />{l("Import local Skill", "导入本机 Skill")}</button>
            <button type="button" className="icon-button" onClick={onRefresh} disabled={loading} aria-label={l("Refresh Skill library", "刷新 Skill 库")} title={l("Refresh Skill library", "刷新 Skill 库")}><RefreshCw size={14} /></button>
          </div>
        </header>

        {feedback ? <div className={`managed-skills-feedback ${feedback.kind}`}>{feedback.message}</div> : null}
        {localFeedback ? <div className={`managed-skills-feedback ${localFeedback.kind}`}>{localFeedback.message}</div> : null}
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
            onToggleTarget={(skill, target) => void toggleTarget(skill, target)}
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

      <SkillImportDialog open={importOpen} language={language} onClose={() => setImportOpen(false)} onImported={libraryChanged} />
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
  if (skill.source !== "agent-recall") return false;
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

function targetLabel(target: SkillInstallTarget): string {
  if (target === "claude") return "Claude Code";
  if (target === "trae") return "Trae";
  return "Codex";
}
