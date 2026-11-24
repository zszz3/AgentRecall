import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { AlertTriangle, Check, Cloud, Compass, Copy, Download, FolderCode, FolderOpen, MoreHorizontal, Package, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import type { InstalledSkill, InstalledSkillsSnapshot } from "../../../../core/skill-manager";
import type { ManagedSkill, SkillInstallTarget } from "../../../../core/managed-skill-library";
import type { RemoteSkill, RemoteSkillGroup, SkillSyncSnapshot, SkillSyncUploadOutcome } from "../../../../core/skill-sync";
import type { TeamPayload } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { SkillsFeedback } from "../../app-types";
import { ResizableSplit } from "../../components/resizable-split";
import { localize, type LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { markdownPreview, skillMarkdownBody } from "../../markdown-preview";
import { skillSourceLabel } from "../../skill-manager";
import { buildUnifiedSkillEntries } from "../../skill-sync-view-model";
import { CatalogDetail, CatalogGroup, CatalogItem, CatalogPage, CatalogSearch } from "../../ui/catalog";
import { MenuButton, type MenuItem } from "../../ui/menu";
import { Badge, Button, buttonClass, EmptyState, IconButton, Notice, Segmented } from "../../ui/primitives";
import { useTeamCatalogs, type TeamCatalogEntry } from "../team-workspace/use-team-catalogs";
import { CloudSkillDetail } from "./cloud-skill-detail";
import { isManagedSkill } from "./managed-skill";
import { SkillDiscoveryDialog } from "./skill-discovery-dialog";
import { SkillSyncPanel } from "./skill-sync-panel";
import { SkillTargetDialog } from "./skill-target-dialog";
import { ipcErrorText } from "../status/status-messages";

type Team = TeamCatalogEntry["team"];
type SkillsView = "active" | "library" | "shared";
type Place =
  | { kind: "library"; skill: ManagedSkill }
  | { kind: "agent"; skill: InstalledSkill }
  | { kind: "team"; team: Team; id: string; description: string }
  | { kind: "cloud"; group: RemoteSkillGroup };
interface Entry { key: string; name: string; description: string; home: Place; places: Place[] }
type TeamPreview = Extract<TeamPayload, { kind: "skill-preview" }>["value"];

const HOME_ORDER: Record<Place["kind"], number> = { library: 0, agent: 1, team: 2, cloud: 3 };
const TARGET_NAMES: Record<SkillInstallTarget, string> = { codex: "Codex", "codex-shared": "Codex (shared)", claude: "Claude Code", codebuddy: "CodeBuddy", qoder: "Qoder", trae: "Trae", pi: "Pi" };

function installedAgentNames(entry: Entry): string[] {
  const names: string[] = [];
  if (entry.home.kind === "library") {
    for (const installation of entry.home.skill.installations) {
      if (installation.state === "installed") {
        names.push(TARGET_NAMES[installation.target]);
      }
    }
  }
  for (const place of entry.places) {
    if (place.kind === "agent") {
      names.push(skillSourceLabel(place.skill.source));
    }
  }
  return [...new Set(names)];
}

function isEntryActiveInAgents(entry: Entry): boolean {
  if (entry.home.kind === "agent") return true;
  if (entry.home.kind === "library") {
    return entry.home.skill.installations.some((installation) => installation.state === "installed")
      || entry.places.some((place) => place.kind === "agent");
  }
  return false;
}

/** The one place a Skill is shown from: the library first, then an agent's copy, a team, the cloud. */
function catalogEntries(library: ManagedSkill[], agents: InstalledSkill[], teams: TeamCatalogEntry[], cloud: RemoteSkillGroup[]): Entry[] {
  const byName = new Map<string, Entry>();
  const add = (name: string, description: string, place: Place) => {
    const key = name.trim().toLowerCase();
    const entry = byName.get(key);
    if (!entry) { byName.set(key, { key, name, description, home: place, places: [place] }); return; }
    entry.places.push(place);
    if (HOME_ORDER[place.kind] < HOME_ORDER[entry.home.kind]) { entry.home = place; entry.name = name; entry.description = description || entry.description; }
    else if (!entry.description) entry.description = description;
  };
  for (const skill of library) add(skill.name, skill.description, { kind: "library", skill });
  for (const skill of agents) add(skill.name, skill.description, { kind: "agent", skill });
  for (const { team, catalog } of teams) for (const skill of catalog.assets?.skills ?? []) add(skill.id, skill.description ?? "", { kind: "team", team, id: skill.id, description: skill.description ?? "" });
  for (const group of cloud) add(group.name, group.description, { kind: "cloud", group });
  // List order: the group a Skill is shown in, then its name, so the first entry is the first one on screen.
  const group = (entry: Entry) => `${HOME_ORDER[entry.home.kind]}${entry.home.kind === "team" ? entry.home.team.name : ""}`;
  return [...byName.values()].sort((left, right) => group(left).localeCompare(group(right)) || left.name.localeCompare(right.name));
}

export function SkillsPage({
  snapshot, syncSnapshot, loading, feedback, localSnapshot, localLoading, localError, language, revealLabel,
  onRefresh, onEnsureLocalLoaded, onRefreshLoadedLocal, onRefreshLocal, onUpload, onInstallRemote, onFetchVersion,
  onRefreshRemote, onCopySetupSql, onOpenSqlEditor, onCopyPath, onReveal, onDelete, evalBadgeCounts, onNavigateToEval,
  initialDiscoveryOpen, onInitialDiscoveryConsumed, onOpenTeamSpace, teamApi = window.sessionSearch.teamWorkspace,
}: {
  snapshot: InstalledSkillsSnapshot;
  syncSnapshot: SkillSyncSnapshot;
  loading: boolean;
  feedback: SkillsFeedback;
  localSnapshot: InstalledSkillsSnapshot | null;
  localLoading: boolean;
  localError: string | null;
  language: LanguageMode;
  revealLabel: string;
  onRefresh: () => void;
  onEnsureLocalLoaded: () => void;
  onRefreshLoadedLocal: () => void;
  onRefreshLocal: () => void | Promise<void>;
  onUpload: (skill: InstalledSkill, force?: boolean) => Promise<SkillSyncUploadOutcome | null>;
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
  initialDiscoveryOpen?: boolean;
  onInitialDiscoveryConsumed?: () => void;
  onOpenTeamSpace?: () => void;
  teamApi?: TeamWorkspaceApi;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<SkillsView>("active");
  const [userPickedView, setUserPickedView] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pendingManagedId, setPendingManagedId] = useState<string | null>(null);
  const [discoveryOpen, setDiscoveryOpen] = useState(Boolean(initialDiscoveryOpen));
  const [targetSkill, setTargetSkill] = useState<ManagedSkill | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<InstalledSkill | null>(null);
  const [showSyncSetup, setShowSyncSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "status" | "alert"; text: string } | null>(null);
  const [teamRefresh, setTeamRefresh] = useState(0);
  const [teamPreview, setTeamPreview] = useState<{ key: string; value: TeamPreview | null; error: string | null } | null>(null);
  const team = useTeamCatalogs(teamApi, teamRefresh);
  const refreshedOnMount = useRef(false);

  useEffect(() => {
    onEnsureLocalLoaded();
    if (refreshedOnMount.current) return;
    refreshedOnMount.current = true;
    onRefreshLoadedLocal();
  }, [onEnsureLocalLoaded, onRefreshLoadedLocal]);

  useEffect(() => {
    if (!initialDiscoveryOpen) return;
    setDiscoveryOpen(true);
    onInitialDiscoveryConsumed?.();
  }, [initialDiscoveryOpen, onInitialDiscoveryConsumed]);

  const library = useMemo(() => snapshot.skills.filter(isManagedSkill), [snapshot.skills]);
  const cloud = useMemo(() => buildUnifiedSkillEntries(snapshot, syncSnapshot).flatMap((entry) => !entry.local && entry.remote ? [entry.remote] : []), [snapshot, syncSnapshot]);
  const entries = useMemo(() => catalogEntries(library, localSnapshot?.skills ?? [], team.teams ?? [], cloud), [library, localSnapshot, team.teams, cloud]);
  const findings = useMemo(() => new Map((evalBadgeCounts ?? []).map((item) => [item.skill.trim().toLowerCase(), item.low + item.medium])), [evalBadgeCounts]);

  useEffect(() => {
    if (!pendingManagedId) return;
    const entry = entries.find((item) => item.home.kind === "library" && item.home.skill.managedId === pendingManagedId);
    if (entry) {
      setSelectedKey(entry.key);
      if (!isEntryActiveInAgents(entry)) {
        setView("library");
        setUserPickedView(true);
      }
      setPendingManagedId(null);
    }
  }, [entries, pendingManagedId]);

  function placeName(place: Place): string {
    if (place.kind === "library") return l("Skill library", "Skill 库");
    if (place.kind === "agent") return skillSourceLabel(place.skill.source);
    if (place.kind === "team") return l(`Team ${place.team.name}`, `团队 ${place.team.name}`);
    return l("Cloud", "云端");
  }

  const allActiveEntries = useMemo(() => entries.filter(isEntryActiveInAgents), [entries]);
  const allLibraryEntries = useMemo(() => entries.filter((entry) => entry.home.kind === "library"), [entries]);
  const allSharedEntries = useMemo(() => entries.filter((entry) => entry.home.kind === "team" || entry.home.kind === "cloud"), [entries]);
  const hasSharedTab = allSharedEntries.length > 0 || syncSnapshot.status.kind !== "unconfigured";

  const activeView: SkillsView = userPickedView
    ? (view === "shared" && !hasSharedTab ? "active" : view)
    : allActiveEntries.length > 0
      ? "active"
      : allLibraryEntries.length > 0
        ? "library"
        : hasSharedTab
          ? "shared"
          : "active";

  const needle = query.trim().toLowerCase();
  const matchesEntry = (entry: Entry) => [
    entry.name,
    entry.description,
    ...installedAgentNames(entry),
    ...entry.places.map((place) => placeName(place)),
  ].some((text) => text.toLowerCase().includes(needle));

  // Searching spans every view so a Skill is never hidden behind another tab.
  const shown = needle
    ? entries.filter(matchesEntry)
    : activeView === "active"
      ? allActiveEntries
      : activeView === "library"
        ? allLibraryEntries
        : allSharedEntries;

  const current = shown.find((entry) => entry.key === selectedKey) ?? shown[0] ?? null;

  const currentTeamPlace = current?.home.kind === "team" ? current.home : null;
  useEffect(() => {
    if (!currentTeamPlace || !current) return;
    let active = true;
    const key = current.key;
    setTeamPreview({ key, value: null, error: null });
    teamApi.request({ action: "skill-preview", scope: { teamId: currentTeamPlace.team.id, repository: currentTeamPlace.team.repository }, id: currentTeamPlace.id }).then(
      (reply) => { if (!active) return; setTeamPreview(reply.ok && reply.data.kind === "skill-preview" ? { key, value: reply.data.value, error: null } : { key, value: null, error: reply.ok ? l("Could not open this Skill.", "无法打开这个 Skill。") : reply.error.message }); },
      () => { if (active) setTeamPreview({ key, value: null, error: l("Could not open this Skill.", "无法打开这个 Skill。") }); },
    );
    return () => { active = false; };
  }, [current?.key, currentTeamPlace, teamApi]);

  function entryMeta(entry: Entry): string {
    if (entry.home.kind === "library") {
      const agents = installedAgentNames(entry);
      if (agents.length > 0) return agents.join(" · ");
      return entry.home.skill.origin.kind === "builtin"
        ? l("Built-in · Not installed", "内置 · 未安装")
        : l("Not installed", "未安装到 Agent");
    }
    if (entry.home.kind === "agent") {
      const agents = installedAgentNames(entry);
      return `${agents.join(" · ")} · ${l("Unmanaged", "未入库")}`;
    }
    if (entry.home.kind === "team") return l(`Team ${entry.home.team.name}`, `团队 ${entry.home.team.name}`);
    return l("Cloud only", "仅云端");
  }

  async function run(action: () => Promise<string | void>) {
    setNotice(null); setBusy(true);
    try {
      const message = await action();
      if (message) setNotice({ kind: "status", text: message });
    } catch (cause) { setNotice({ kind: "alert", text: ipcErrorText(cause) }); }
    finally { setBusy(false); }
  }
  function select(key: string) { setSelectedKey(key); setNotice(null); setConfirmingDelete(null); }
  function switchView(next: SkillsView) { setView(next); setUserPickedView(true); setNotice(null); setConfirmingDelete(null); }
  function refreshAll() { onRefresh(); void onRefreshLocal(); setTeamRefresh((value) => value + 1); }
  function libraryChanged(managedId: string) { setPendingManagedId(managedId); onRefresh(); }

  async function importToLibrary(skill: InstalledSkill) {
    const [result] = await window.sessionSearch.importLocalSkills([skill.path]);
    if (!result?.managedId) throw new Error(l("The Skill was not added to the Skill library.", "Skill 未能加入 Skill 库。"));
    libraryChanged(result.managedId);
    return l(`Added ${skill.name} to the Skill library.`, `已把 ${skill.name} 加入 Skill 库。`);
  }
  async function copyTeamSkill(place: Extract<Place, { kind: "team" }>) {
    const reply = await teamApi.request({ action: "skill-copy", scope: { teamId: place.team.id, repository: place.team.repository }, id: place.id });
    if (!reply.ok) throw new Error(reply.error.message);
    onRefresh();
    return reply.data.kind === "complete" ? reply.data.message : undefined;
  }
  async function updateTargets(skill: ManagedSkill, targets: SkillInstallTarget[], forceTargets: SkillInstallTarget[]) {
    const result = await window.sessionSearch.updateManagedSkillTargets(skill.managedId, targets, forceTargets);
    onRefresh();
    setNotice(result.retainedBackupPaths?.length
      ? { kind: "alert", text: l(`Updated where ${skill.name} is installed, but backups were kept: ${result.retainedBackupPaths.join(", ")}`, `已更新 ${skill.name} 的安装位置，但保留了备份：${result.retainedBackupPaths.join("、")}`) }
      : { kind: "status", text: targets.length ? l(`Updated where ${skill.name} is installed.`, `${skill.name} 的安装位置已更新。`) : l(`Removed ${skill.name} from every agent.`, `${skill.name} 已从所有 Agent 移除。`) });
  }
  async function toggleSingleTarget(skill: ManagedSkill, target: SkillInstallTarget) {
    const currentInstalled = skill.installations
      .filter((installation) => installation.state === "installed")
      .map((installation) => installation.target);
    const nextTargets = currentInstalled.includes(target)
      ? currentInstalled.filter((item) => item !== target)
      : [...currentInstalled, target];
    await run(async () => {
      await updateTargets(skill, nextTargets, []);
    });
  }
  async function confirmDelete(skill: InstalledSkill) {
    setConfirmingDelete(null);
    await run(async () => { await onDelete(skill); if (!isManagedSkill(skill)) await onRefreshLocal(); });
  }

  const installedLibraryEntries = shown.filter((entry) => entry.home.kind === "library" && isEntryActiveInAgents(entry));
  const uninstalledLibraryEntries = shown.filter((entry) => entry.home.kind === "library" && !isEntryActiveInAgents(entry));
  const agentEntries = shown.filter((entry) => entry.home.kind === "agent");
  const teamNames = [...new Set(shown.flatMap((entry) => entry.home.kind === "team" ? [entry.home.team.name] : []))];
  const cloudEntries = shown.filter((entry) => entry.home.kind === "cloud");
  const item = (entry: Entry) => {
    const count = findings.get(entry.key) ?? 0;
    const icon = entry.home.kind === "library" ? <Package size={13} />
      : entry.home.kind === "agent" ? <FolderCode size={13} />
      : entry.home.kind === "team" ? <Users size={13} />
      : <Cloud size={13} />;
    return <CatalogItem key={entry.key} title={entry.name} meta={entryMeta(entry)} icon={icon} selected={current?.key === entry.key} onSelect={() => select(entry.key)}
      trailing={count > 0 ? <Badge tone="warning">{l(`${count} findings`, `${count} 个发现`)}</Badge> : undefined} />;
  };

  const counts = [
    l(`${allActiveEntries.length} active`, `已生效 ${allActiveEntries.length} 个`),
    l(`${library.length} in library`, `库 ${library.length} 个`),
    allSharedEntries.length ? l(`${allSharedEntries.length} shared`, `团队与云端 ${allSharedEntries.length} 个`) : null,
  ].filter(Boolean).join(" · ");

  const list = <div className="catalog-list" aria-label={l("Skills", "Skill 列表")}>
    {installedLibraryEntries.length ? <CatalogGroup
      title={activeView === "library" && !needle ? l("Installed in agents", "已安装到 Agent") : l("Managed & active", "已托管并生效")}
      hint={l("Managed by AgentRecall and currently active in at least one agent", "由 AgentRecall 托管，且已安装到至少一个 Agent")}
      count={installedLibraryEntries.length}
    >
      {installedLibraryEntries.map(item)}
    </CatalogGroup> : null}
    {agentEntries.length ? <CatalogGroup title={l("Only in agents", "仅在 Agent 中")} hint={l("Found in agents' Skill folders; add to the library to distribute across agents", "在各 Agent 目录中发现，尚未纳入 Skill 库统一分发")} count={agentEntries.length}>
      {agentEntries.map(item)}
    </CatalogGroup> : null}
    {uninstalledLibraryEntries.length ? <CatalogGroup
      title={l("Not installed", "未安装 / 内置")}
      hint={l("Stored in AgentRecall's Skill library, not installed to any agent yet", "保存在 Skill 库中，尚未安装到本机 Agent")}
      count={uninstalledLibraryEntries.length}
    >
      {uninstalledLibraryEntries.map(item)}
    </CatalogGroup> : null}
    {teamNames.map((name) => {
      const inTeam = shown.filter((entry) => entry.home.kind === "team" && entry.home.team.name === name);
      return <CatalogGroup key={`team:${name}`} title={l(`Team · ${name}`, `团队 · ${name}`)} count={inTeam.length}>{inTeam.map(item)}</CatalogGroup>;
    })}
    {cloudEntries.length ? <CatalogGroup title={l("Cloud", "云端")} hint={l("Saved in your cloud but not on this machine", "保存在云端，本机还没有")} count={cloudEntries.length}>
      {cloudEntries.map(item)}
    </CatalogGroup> : null}
    {shown.length === 0 && !loading && !localLoading ? <p className="catalog-list-empty">{needle
      ? l("Nothing matches.", "没有匹配的 Skill。")
      : activeView === "active"
        ? l("No Skills active in agents yet.", "还没有在 Agent 中生效的 Skill。")
        : l("No Skills in this view.", "此视图下还没有 Skill。")}</p> : null}
  </div>;

  const noticeLine = notice ? <Notice kind={notice.kind === "alert" ? "error" : "success"}>{notice.text}</Notice> : null;
  const deleteConfirm = (skill: InstalledSkill) => confirmingDelete?.path === skill.path ? <div className="catalog-confirm" role="group" aria-label={l("Confirm deletion", "确认删除")}>
    <span>{isManagedSkill(skill)
      ? l(`Delete ${skill.name} from the Skill library? It is also removed from the agents it was installed into.`, `从 Skill 库删除 ${skill.name}？它也会从已安装的 Agent 中移除。`)
      : l(`Delete ${skill.name} from ${skillSourceLabel(skill.source)}? This permanently deletes its folder.`, `从 ${skillSourceLabel(skill.source)} 删除 ${skill.name}？这会永久删除它的目录。`)}</span>
    <Button size="sm" onClick={() => setConfirmingDelete(null)}>{l("Cancel", "取消")}</Button>
    <Button size="sm" variant="danger" disabled={busy} onClick={() => void confirmDelete(skill)}>{l("Delete", "删除")}</Button>
  </div> : null;
  const preview = (markdown: string) => <section className="catalog-section">
    <h4>SKILL.md</h4>
    <div className="catalog-markdown"><Markdown text={markdownPreview(skillMarkdownBody(markdown), 18_000, l("… (truncated)", "…（已截断）"))} language={language} /></div>
  </section>;
  const elsewhere = (entry: Entry, home: Place) => {
    const others = entry.places.filter((place) => place !== home);
    if (!others.length) return null;
    return <section className="catalog-section">
      <h4>{l("Also found in", "也在这些地方")}</h4>
      <ul className="catalog-locations">
        {others.map((place, index) => <li key={index}>
          <span><strong>{placeName(place)}</strong>{place.kind === "agent" || place.kind === "library" ? <small>{place.skill.agent}</small> : null}</span>
          <code>{place.kind === "agent" || place.kind === "library" ? place.skill.directoryPath : place.kind === "team" ? place.id : place.group.relativePath}</code>
          {place.kind === "agent" || place.kind === "library" ? <IconButton size="sm" label={revealLabel} icon={<FolderOpen size={14} />} onClick={() => onReveal(place.skill.path)} /> : <span />}
        </li>)}
      </ul>
    </section>;
  };

  let detail: ReactNode;
  if (!current) {
    detail = <EmptyState
      title={loading || localLoading ? l("Looking for Skills…", "正在查找 Skill…") : l("No Skills", "没有 Skill")}
      description={l("AgentRecall lists the Skill library, the Skill folders of agents on this machine, team Skills and Skills saved in your cloud.", "AgentRecall 会列出 Skill 库、本机各 Agent 的 Skill 目录、团队 Skill 和云端保存的 Skill。")}
      action={<Button icon={<Compass size={14} />} onClick={() => setDiscoveryOpen(true)}>{l("Discover Skills", "发现 Skill")}</Button>}
    />;
  } else if (current.home.kind === "library") {
    const skill = current.home.skill;
    const installed = skill.installations.filter((installation) => installation.state === "installed").map((installation) => TARGET_NAMES[installation.target]);
    const count = findings.get(current.key) ?? 0;
    const cloudSyncVisible = syncSnapshot.status.kind !== "unconfigured" || showSyncSetup;
    const more: MenuItem[] = [
      { key: "copy", label: l("Copy path", "复制路径"), icon: <Copy size={14} />, onSelect: () => onCopyPath(skill.path) },
      ...(!cloudSyncVisible ? [{ key: "cloud-sync", label: l("Cloud sync setup…", "云端同步设置…"), icon: <Cloud size={14} />, onSelect: () => setShowSyncSetup(true) }] : []),
      ...(onNavigateToEval ? [{ key: "eval", label: count ? l(`View ${count} findings in Eval`, `在 Eval 中查看 ${count} 个发现`) : l("Evaluate in Eval", "在 Eval 中评测"), onSelect: () => onNavigateToEval(skill.name) }] : []),
      { key: "delete", label: l("Delete from the Skill library", "从 Skill 库删除"), icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirmingDelete(skill) },
    ];
    detail = <CatalogDetail
      title={skill.name}
      subtitle={skill.description}
      facts={[
        { label: l("Source", "来源"), value: skill.origin.kind === "builtin" ? l("Built-in", "内置") : skill.origin.kind === "skills-sh" ? "skills.sh" : skill.origin.kind === "remote" ? l("Cloud", "云端") : skill.origin.label || l("Local", "本机") },
        { label: l("Installed in", "已安装到"), value: installed.length ? installed.join("、") : l("No agent yet", "还没有安装") },
        ...(skill.usageCount ? [{ label: l("Used", "使用"), value: l(`${skill.usageCount} times`, `${skill.usageCount} 次`) }] : []),
      ]}
      actions={<>
        <Button size="sm" variant="primary" icon={<Download size={14} />} disabled={busy} onClick={() => setTargetSkill(skill)}>{l("Install to agents…", "安装到 Agent…")}</Button>
        <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => onReveal(skill.path)}>{revealLabel}</Button>
        <MenuButton label={l("More actions", "更多操作")} icon={<MoreHorizontal size={15} />} className={buttonClass("secondary", "sm", true)} items={more} />
      </>}
    >
      {noticeLine}
      {deleteConfirm(skill)}
      {skill.installations.length > 0 ? (
        <section className="catalog-section">
          <h4>{l("Agent distribution", "安装到 Agent")}</h4>
          <div className="skill-agent-matrix" role="group" aria-label={l("Agent distribution", "安装到 Agent")}>
            {skill.installations.map((installation) => {
              const isInstalled = installation.state === "installed";
              const isConflict = installation.state === "conflict";
              const label = TARGET_NAMES[installation.target];
              return (
                <button
                  key={installation.target}
                  type="button"
                  className={`skill-agent-pill${isInstalled ? " is-installed" : ""}${isConflict ? " is-conflict" : ""}`}
                  aria-pressed={isConflict ? undefined : isInstalled}
                  disabled={busy}
                  title={isConflict
                    ? l(`${label}: Path conflict. Click to resolve in the install dialog.`, `${label}：路径冲突，点击打开安装弹窗确认覆盖。`)
                    : installation.path}
                  onClick={() => {
                    if (isConflict) {
                      setTargetSkill(skill);
                      return;
                    }
                    void toggleSingleTarget(skill, installation.target);
                  }}
                >
                  {isConflict ? <AlertTriangle size={12} /> : isInstalled ? <Check size={12} /> : <Plus size={12} />}
                  <span>{label}</span>
                  {isConflict ? <small>{l("Conflict", "冲突")}</small> : null}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
      {cloudSyncVisible ? (
        <SkillSyncPanel skill={skill} entry={buildUnifiedSkillEntries(snapshot, syncSnapshot).find((entry) => entry.local?.path === skill.path) ?? null} remoteOnlyGroups={cloud} snapshot={syncSnapshot} busy={busy || loading} language={language}
          onUpload={(target, force) => onUpload(target, force)} onInstallRemote={onInstallRemote} onFetchVersion={onFetchVersion} onRefresh={onRefreshRemote} onCopySetupSql={onCopySetupSql} onOpenSqlEditor={onOpenSqlEditor} />
      ) : null}
      {elsewhere(current, current.home)}
      {preview(skill.markdown)}
    </CatalogDetail>;
  } else if (current.home.kind === "agent") {
    const skill = current.home.skill;
    const more: MenuItem[] = [
      { key: "copy", label: l("Copy path", "复制路径"), icon: <Copy size={14} />, onSelect: () => onCopyPath(skill.path) },
      ...(skill.source === "codex-system" ? [] : [{ key: "delete", label: l("Delete from the agent", "从 Agent 中删除"), icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirmingDelete(skill) }]),
    ];
    detail = <CatalogDetail
      title={skill.name}
      subtitle={skill.description}
      facts={[{ label: l("Found in", "所在位置"), value: skillSourceLabel(skill.source) }, { label: l("Folder", "目录"), value: skill.directoryPath }]}
      actions={<>
        <Button size="sm" variant="primary" icon={<Download size={14} />} disabled={busy} onClick={() => void run(() => importToLibrary(skill))}>{l("Add to Skill library", "加入 Skill 库")}</Button>
        <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => onReveal(skill.path)}>{revealLabel}</Button>
        <MenuButton label={l("More actions", "更多操作")} icon={<MoreHorizontal size={15} />} className={buttonClass("secondary", "sm", true)} items={more} />
      </>}
    >
      {noticeLine}
      {deleteConfirm(skill)}
      {elsewhere(current, current.home)}
      {preview(skill.markdown)}
    </CatalogDetail>;
  } else if (current.home.kind === "team") {
    const place = current.home;
    const loaded = teamPreview?.key === current.key ? teamPreview : null;
    detail = <CatalogDetail
      title={place.id}
      subtitle={place.description}
      facts={[{ label: l("Team", "团队"), value: place.team.name }, ...(loaded?.value ? [{ label: l("Files", "文件"), value: String(loaded.value.files.length) }] : [])]}
      actions={<>
        <Button size="sm" variant="primary" icon={<Download size={14} />} disabled={busy} onClick={() => void run(() => copyTeamSkill(place))}>{l("Add to Skill library", "加入 Skill 库")}</Button>
        {onOpenTeamSpace ? <Button size="sm" icon={<Users size={14} />} onClick={onOpenTeamSpace}>{l("Edit in team space", "去团队空间编辑")}</Button> : null}
      </>}
    >
      {noticeLine}
      {loaded?.error ? <Notice kind="error">{loaded.error}</Notice> : null}
      {elsewhere(current, place)}
      {loaded?.value && loaded.value.encoding === "utf8" ? preview(loaded.value.content) : !loaded?.error ? <p className="catalog-detail-status">{l("Loading SKILL.md…", "正在读取 SKILL.md…")}</p> : null}
    </CatalogDetail>;
  } else {
    detail = <div className="catalog-detail skills-cloud-detail">
      <CloudSkillDetail group={current.home.group} busy={busy || loading} language={language} onInstall={onInstallRemote} onFetchVersion={onFetchVersion} />
    </div>;
  }

  const pageFeedback = feedback ? <Notice kind={feedback.kind} className="catalog-error">{feedback.message}</Notice> : null;

  const viewOptions: Array<{ value: SkillsView; label: string; count: number }> = [
    { value: "active", label: l("Active", "已生效"), count: allActiveEntries.length },
    { value: "library", label: l("Library", "Skill 库"), count: allLibraryEntries.length },
    ...(hasSharedTab ? [{ value: "shared" as const, label: l("Team & cloud", "团队与云端"), count: allSharedEntries.length }] : []),
  ];

  return <CatalogPage
    title="Skills"
    meta={counts}
    search={<CatalogSearch value={query} onChange={setQuery} label={l("Search Skills", "搜索 Skill")} placeholder={l("Search names, descriptions or places", "搜索名称、描述或所在位置")} />}
    actions={<>
      <Segmented<SkillsView>
        label={l("Skills view", "Skill 视图")}
        value={activeView}
        onChange={switchView}
        options={viewOptions}
      />
      <Button size="sm" icon={<Compass size={14} />} onClick={() => setDiscoveryOpen(true)}>{l("Discover", "发现 Skill")}</Button>
      <IconButton label={l("Look again", "重新查找")} icon={<RefreshCw size={15} />} disabled={loading} onClick={refreshAll} />
    </>}
  >
    {pageFeedback}
    {localError ? <Notice kind="error" className="catalog-error">{localError}</Notice> : null}
    {team.problems.map((problem) => <Notice key={problem.team} kind="error" className="catalog-error">{problem.team ? `${problem.team}: ` : ""}{problem.message}</Notice>)}
    <ResizableSplit className="catalog-split" label={l("Resize the list", "调整列表宽度")} storageKey="agent-recall-skills-pane.v2" initialWidth={264} minWidth={210} maxWidth={380}>
      {list}
      <div className="catalog-detail-pane">{detail}</div>
    </ResizableSplit>
    {targetSkill ? <SkillTargetDialog open skill={targetSkill} busy={busy} language={language} onClose={() => setTargetSkill(null)}
      onSave={async (targets, forceTargets) => { setBusy(true); try { await updateTargets(targetSkill, targets, forceTargets); setTargetSkill(null); } finally { setBusy(false); } }} /> : null}
    <SkillDiscoveryDialog open={discoveryOpen} language={language} onClose={() => setDiscoveryOpen(false)} onImported={libraryChanged} />
  </CatalogPage>;
}
