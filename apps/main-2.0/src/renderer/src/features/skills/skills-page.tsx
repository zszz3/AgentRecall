import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  FileCode,
  FolderCode,
  FolderInput,
  FolderOpen,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Share2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { InstalledSkill, InstalledSkillsSnapshot } from "../../../../core/skill-manager";
import type {
  ManagedSkill,
  ManagedSkillInstallation,
  SkillInstallTarget,
  SkillPackageFileContent,
  SkillPackageFileEntry,
} from "../../../../core/managed-skill-library";
import { installTargetForSkillSource } from "../../../../core/agent-skill-registry";
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
import { SkillCreateDialog } from "./skill-create-dialog";
import { SkillDiscoveryPane } from "./skill-discovery-pane";
import { SkillSyncPanel } from "./skill-sync-panel";
import { SkillTargetDialog } from "./skill-target-dialog";
import { ipcErrorText } from "../status/status-messages";

type Team = TeamCatalogEntry["team"];
type SkillsView = "mine" | "team" | "discover";
type MineFilter = "all" | "active" | "inactive" | "project";
type Place =
  | { kind: "library"; skill: ManagedSkill }
  | { kind: "agent"; skill: InstalledSkill }
  | { kind: "cloud"; group: RemoteSkillGroup };
interface LocalEntry {
  key: string;
  name: string;
  description: string;
  home: Place;
  places: Place[];
  projectLabel: string | null;
}
interface TeamSkillItem {
  key: string;
  team: Team;
  id: string;
  description: string;
}
type TeamPreview = Extract<TeamPayload, { kind: "skill-preview" }>["value"];

const HOME_ORDER: Record<Place["kind"], number> = { library: 0, agent: 1, cloud: 2 };
const DEFAULT_PRIMARY_TARGETS: SkillInstallTarget[] = ["codex", "codex-shared", "claude", "antigravity", "cursor"];
const TARGET_NAMES: Record<SkillInstallTarget, string> = {
  codex: "Codex",
  "codex-shared": "Shared (.agents)",
  claude: "Claude Code",
  antigravity: "Antigravity (agy)",
  cursor: "Cursor",
  codebuddy: "CodeBuddy",
  qoder: "Qoder",
  trae: "Trae",
  pi: "Pi",
};

function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

function projectNameFromSkill(skill: InstalledSkill): string | null {
  if (!skill.source.endsWith("-project")) return null;
  const parts = skill.rootPath.split(/[\\/]/).filter(Boolean);
  // rootPath looks like .../<project>/.claude/skills or .../<project>/.agents/skills
  if (parts.length >= 3 && parts[parts.length - 1] === "skills" && parts[parts.length - 2]?.startsWith(".")) {
    return parts[parts.length - 3] ?? null;
  }
  return parts.at(-2) ?? null;
}

function installedAgentNames(entry: LocalEntry): string[] {
  const names: string[] = [];
  if (entry.home.kind === "library") {
    for (const installation of entry.home.skill.installations) {
      if (installation.state === "installed") names.push(TARGET_NAMES[installation.target]);
    }
  }
  for (const place of entry.places) {
    if (place.kind === "agent") names.push(skillSourceLabel(place.skill.source));
  }
  return [...new Set(names)];
}

function isEntryActiveInAgents(entry: LocalEntry): boolean {
  if (entry.home.kind === "agent") return true;
  if (entry.home.kind === "library") {
    return entry.home.skill.installations.some((installation) => installation.state === "installed")
      || entry.places.some((place) => place.kind === "agent");
  }
  return false;
}

function buildLocalEntries(library: ManagedSkill[], agents: InstalledSkill[], cloud: RemoteSkillGroup[]): LocalEntry[] {
  const byKey = new Map<string, LocalEntry>();
  const add = (key: string, name: string, description: string, place: Place, projectLabel: string | null = null) => {
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { key, name, description, home: place, places: [place], projectLabel });
      return;
    }
    existing.places.push(place);
    if (HOME_ORDER[place.kind] < HOME_ORDER[existing.home.kind]) {
      existing.home = place;
      existing.name = name;
      existing.description = description || existing.description;
    } else if (!existing.description) {
      existing.description = description;
    }
  };
  for (const skill of library) {
    add(skill.name.trim().toLowerCase(), skill.name, skill.description, { kind: "library", skill });
  }
  for (const skill of agents) {
    const projectLabel = projectNameFromSkill(skill);
    const key = projectLabel
      ? `project:${skill.directoryPath.toLowerCase()}`
      : skill.name.trim().toLowerCase();
    add(key, skill.name, skill.description, { kind: "agent", skill }, projectLabel);
  }
  for (const group of cloud) {
    add(group.name.trim().toLowerCase(), group.name, group.description, { kind: "cloud", group });
  }
  return [...byKey.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function partitionInstallations(installations: ManagedSkillInstallation[]): {
  primary: ManagedSkillInstallation[];
  overflow: ManagedSkillInstallation[];
} {
  const primary: ManagedSkillInstallation[] = [];
  const overflow: ManagedSkillInstallation[] = [];
  for (const installation of installations) {
    if (installation.state === "installed" || installation.state === "conflict" || installation.detected !== false) {
      primary.push(installation);
    } else {
      overflow.push(installation);
    }
  }
  if (primary.length === 0) {
    const fallback = installations.filter((item) => DEFAULT_PRIMARY_TARGETS.includes(item.target));
    const rest = installations.filter((item) => !DEFAULT_PRIMARY_TARGETS.includes(item.target));
    return { primary: fallback.length ? fallback : installations, overflow: fallback.length ? rest : [] };
  }
  return { primary, overflow };
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
  const [view, setView] = useState<SkillsView>(initialDiscoveryOpen ? "discover" : "mine");
  const [mineFilter, setMineFilter] = useState<MineFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedTeamKey, setSelectedTeamKey] = useState<string | null>(null);
  const [pendingManagedId, setPendingManagedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [targetSkill, setTargetSkill] = useState<ManagedSkill | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<InstalledSkill | null>(null);
  const [showSyncSetup, setShowSyncSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "status" | "alert"; text: string; action?: { label: string; run(): void } } | null>(null);
  const [teamRefresh, setTeamRefresh] = useState(0);
  const [teamPreview, setTeamPreview] = useState<{ key: string; value: TeamPreview | null; error: string | null } | null>(null);
  const [packageFiles, setPackageFiles] = useState<{ path: string; files: SkillPackageFileEntry[] } | null>(null);
  const [activeFile, setActiveFile] = useState("SKILL.md");
  const [loadedFile, setLoadedFile] = useState<{ skillPath: string; file: SkillPackageFileContent | null; error: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
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
    setView("discover");
    onInitialDiscoveryConsumed?.();
  }, [initialDiscoveryOpen, onInitialDiscoveryConsumed]);

  const library = useMemo(() => snapshot.skills.filter(isManagedSkill), [snapshot.skills]);
  const cloudConfigured = syncSnapshot.status.kind !== "unconfigured";
  const cloud = useMemo(
    () => (cloudConfigured
      ? buildUnifiedSkillEntries(snapshot, syncSnapshot).flatMap((entry) => (!entry.local && entry.remote ? [entry.remote] : []))
      : []),
    [cloudConfigured, snapshot, syncSnapshot],
  );
  const localEntries = useMemo(
    () => buildLocalEntries(library, localSnapshot?.skills ?? [], cloud),
    [library, localSnapshot, cloud],
  );
  const connectedTeams = useMemo(() => (team.teams ?? []).map((entry) => entry.team), [team.teams]);
  const teamSkills = useMemo<TeamSkillItem[]>(() => {
    const items: TeamSkillItem[] = [];
    for (const { team: t, catalog } of team.teams ?? []) {
      for (const skill of catalog.assets?.skills ?? []) {
        items.push({ key: `${t.id}:${skill.id}`, team: t, id: skill.id, description: skill.description ?? "" });
      }
    }
    return items.sort((left, right) => left.team.name.localeCompare(right.team.name) || left.id.localeCompare(right.id));
  }, [team.teams]);

  const findings = useMemo(
    () => new Map((evalBadgeCounts ?? []).map((item) => [item.skill.trim().toLowerCase(), item.low + item.medium])),
    [evalBadgeCounts],
  );

  // Detected targets on this machine (derived from any managed Skill snapshot, falling back to modern defaults).
  const detectedTargets = useMemo<SkillInstallTarget[]>(() => {
    const sample = library[0]?.installations;
    if (!sample) return DEFAULT_PRIMARY_TARGETS;
    const { primary } = partitionInstallations(sample);
    return primary.map((item) => item.target);
  }, [library]);

  const allKnownTargets = useMemo<SkillInstallTarget[]>(() => {
    const sample = library[0]?.installations;
    return sample ? sample.map((item) => item.target) : DEFAULT_PRIMARY_TARGETS;
  }, [library]);

  useEffect(() => {
    if (!pendingManagedId) return;
    const entry = localEntries.find((item) => item.home.kind === "library" && item.home.skill.managedId === pendingManagedId);
    if (entry) {
      setView("mine");
      setMineFilter("all");
      setSelectedKey(entry.key);
      setPendingManagedId(null);
    }
  }, [localEntries, pendingManagedId]);

  const hasTeamTab = connectedTeams.length > 0;
  const activeView: SkillsView = view === "team" && !hasTeamTab ? "mine" : view;

  const projectCount = useMemo(() => localEntries.filter((entry) => entry.projectLabel !== null).length, [localEntries]);
  const activeLocalCount = useMemo(() => localEntries.filter((entry) => !entry.projectLabel && isEntryActiveInAgents(entry)).length, [localEntries]);
  const inactiveLocalCount = useMemo(() => localEntries.filter((entry) => entry.home.kind === "library" && !isEntryActiveInAgents(entry)).length, [localEntries]);

  const needle = query.trim().toLowerCase();
  const shownLocal = useMemo(() => {
    const bySearch = needle
      ? localEntries.filter((entry) => [
        entry.name,
        entry.description,
        entry.projectLabel ?? "",
        ...installedAgentNames(entry),
      ].some((text) => text.toLowerCase().includes(needle)))
      : localEntries;

    if (needle || mineFilter === "all") return bySearch;
    if (mineFilter === "active") return bySearch.filter((entry) => !entry.projectLabel && isEntryActiveInAgents(entry));
    if (mineFilter === "inactive") return bySearch.filter((entry) => entry.home.kind === "library" && !isEntryActiveInAgents(entry));
    return bySearch.filter((entry) => entry.projectLabel !== null);
  }, [localEntries, needle, mineFilter]);

  const shownTeamSkills = useMemo(() => {
    if (!needle) return teamSkills;
    return teamSkills.filter((item) =>
      item.id.toLowerCase().includes(needle)
      || item.description.toLowerCase().includes(needle)
      || item.team.name.toLowerCase().includes(needle),
    );
  }, [teamSkills, needle]);

  const currentLocal = shownLocal.find((entry) => entry.key === selectedKey) ?? shownLocal[0] ?? null;
  const currentTeamSkill = shownTeamSkills.find((item) => item.key === selectedTeamKey) ?? shownTeamSkills[0] ?? null;

  // Load file list for the selected local/managed Skill.
  const currentSkillPath = activeView === "mine" && currentLocal && (currentLocal.home.kind === "library" || currentLocal.home.kind === "agent")
    ? currentLocal.home.skill.path
    : null;

  useEffect(() => {
    setActiveFile("SKILL.md");
    setLoadedFile(null);
    setEditing(false);
    if (!currentSkillPath || !window.sessionSearch.listSkillFiles) {
      setPackageFiles(null);
      return;
    }
    let active = true;
    void window.sessionSearch.listSkillFiles(currentSkillPath).then(
      (files) => { if (active) setPackageFiles({ path: currentSkillPath, files }); },
      () => { if (active) setPackageFiles(null); },
    );
    return () => { active = false; };
  }, [currentSkillPath]);

  // Load non-default file content when the user clicks another file tab.
  useEffect(() => {
    if (!currentSkillPath || activeFile === "SKILL.md" || !window.sessionSearch.readSkillFile) {
      setLoadedFile(null);
      return;
    }
    let active = true;
    setLoadedFile({ skillPath: currentSkillPath, file: null, error: null });
    void window.sessionSearch.readSkillFile(currentSkillPath, activeFile).then(
      (file) => { if (active) setLoadedFile({ skillPath: currentSkillPath, file, error: null }); },
      (cause) => { if (active) setLoadedFile({ skillPath: currentSkillPath, file: null, error: ipcErrorText(cause) }); },
    );
    return () => { active = false; };
  }, [currentSkillPath, activeFile]);

  // Load Team Skill preview when viewing a Team Skill.
  useEffect(() => {
    if (activeView !== "team" || !currentTeamSkill) return;
    let active = true;
    const key = currentTeamSkill.key;
    setTeamPreview({ key, value: null, error: null });
    teamApi.request({
      action: "skill-preview",
      scope: { teamId: currentTeamSkill.team.id, repository: currentTeamSkill.team.repository },
      id: currentTeamSkill.id,
    }).then(
      (reply) => {
        if (!active) return;
        setTeamPreview(reply.ok && reply.data.kind === "skill-preview"
          ? { key, value: reply.data.value, error: null }
          : { key, value: null, error: reply.ok ? l("Could not open this Skill.", "无法打开这个 Skill。") : reply.error.message });
      },
      () => { if (active) setTeamPreview({ key, value: null, error: l("Could not open this Skill.", "无法打开这个 Skill。") }); },
    );
    return () => { active = false; };
  }, [activeView, currentTeamSkill, teamApi]);

  async function openTeamFile(item: TeamSkillItem, file: string) {
    const key = item.key;
    setTeamPreview({ key, value: null, error: null });
    try {
      const reply = await teamApi.request({
        action: "skill-preview",
        scope: { teamId: item.team.id, repository: item.team.repository },
        id: item.id,
        file,
      });
      setTeamPreview(reply.ok && reply.data.kind === "skill-preview"
        ? { key, value: reply.data.value, error: null }
        : { key, value: null, error: reply.ok ? l("Could not open this file.", "无法打开该文件。") : reply.error.message });
    } catch {
      setTeamPreview({ key, value: null, error: l("Could not open this file.", "无法打开该文件。") });
    }
  }

  async function run(action: () => Promise<{ text: string; action?: { label: string; run(): void } } | string | void>) {
    setNotice(null);
    setBusy(true);
    try {
      const result = await action();
      if (typeof result === "string") setNotice({ kind: "status", text: result });
      else if (result) setNotice({ kind: "status", text: result.text, action: result.action });
    } catch (cause) {
      setNotice({ kind: "alert", text: ipcErrorText(cause) });
    } finally {
      setBusy(false);
    }
  }

  function refreshAll() {
    onRefresh();
    void onRefreshLocal();
    setTeamRefresh((value) => value + 1);
  }

  function libraryChanged(managedId: string) {
    setPendingManagedId(managedId);
    onRefresh();
    void onRefreshLocal();
  }

  async function updateTargets(skill: ManagedSkill, targets: SkillInstallTarget[], forceTargets: SkillInstallTarget[]) {
    const result = await window.sessionSearch.updateManagedSkillTargets(skill.managedId, targets, forceTargets);
    onRefresh();
    void onRefreshLocal();
    setNotice(result.retainedBackupPaths?.length
      ? { kind: "alert", text: l(`Updated ${skill.name}, but backups were kept: ${result.retainedBackupPaths.join(", ")}`, `已更新 ${skill.name} 的启用状态，但保留了备份：${result.retainedBackupPaths.join("、")}`) }
      : { kind: "status", text: targets.length ? l(`Updated ${skill.name} targets.`, `已更新 ${skill.name} 的 Agent 启用状态。`) : l(`Disabled ${skill.name} in all agents.`, `已停用 ${skill.name} 在所有 Agent 中的分发。`) });
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

  async function adoptLocal(skill: InstalledSkill, toggleTarget?: SkillInstallTarget) {
    if (window.sessionSearch.adoptLocalSkill) {
      const result = await window.sessionSearch.adoptLocalSkill(skill.path, toggleTarget);
      libraryChanged(result.managedId);
      return toggleTarget
        ? l(`Updated ${skill.name} for ${TARGET_NAMES[toggleTarget]}.`, `已为 ${skill.name} 更新 ${TARGET_NAMES[toggleTarget]} 的启用状态。`)
        : l(`Managed ${skill.name} in AgentRecall.`, `已将 ${skill.name} 纳入统一托管。`);
    }
    const [result] = await window.sessionSearch.importLocalSkills([skill.path]);
    if (!result?.managedId) throw new Error(l("The Skill could not be imported.", "Skill 未能加入 Skill 库。"));
    libraryChanged(result.managedId);
    return l(`Added ${skill.name} to the Skill library.`, `已把 ${skill.name} 加入 Skill 库。`);
  }

  async function shareSkillToTeam(targetTeam: Team, place: Extract<Place, { kind: "library" | "agent" }>) {
    let managedId: string;
    if (place.kind === "library") {
      managedId = place.skill.managedId;
    } else if (window.sessionSearch.adoptLocalSkill) {
      const adopted = await window.sessionSearch.adoptLocalSkill(place.skill.path);
      managedId = adopted.managedId;
      onRefresh();
      void onRefreshLocal();
    } else {
      const [imported] = await window.sessionSearch.importLocalSkills([place.skill.path]);
      if (!imported?.managedId) throw new Error(l("Could not prepare this Skill for sharing.", "无法准备分享此 Skill。"));
      managedId = imported.managedId;
      onRefresh();
    }
    const reply = await teamApi.request({
      action: "workspace-stage",
      scope: { teamId: targetTeam.id, repository: targetTeam.repository },
      items: [{ kind: "library-skill", key: `library-skill:${managedId}`, skill: managedId }],
    });
    if (!reply.ok) throw new Error(reply.error.message);
    return {
      text: l(`Staged “${place.skill.name}” for team ${targetTeam.name}. Push in Team Space to publish.`, `已将「${place.skill.name}」加入团队 ${targetTeam.name} 的待发布清单。`),
      action: onOpenTeamSpace ? { label: l("Open Team Space", "去团队空间发布"), run: onOpenTeamSpace } : undefined,
    };
  }

  async function copyTeamSkillToLocal(item: TeamSkillItem) {
    const reply = await teamApi.request({
      action: "skill-copy",
      scope: { teamId: item.team.id, repository: item.team.repository },
      id: item.id,
    });
    if (!reply.ok) throw new Error(reply.error.message);
    onRefresh();
    void onRefreshLocal();
    return {
      text: reply.data.kind === "complete" ? reply.data.message : l(`Installed “${item.id}” to My Skills.`, `已将「${item.id}」安装到我的 Skills。`),
      action: {
        label: l("Open in My Skills", "前往我的 Skills 启用"),
        run: () => {
          setPendingManagedId(item.id);
          setView("mine");
          setMineFilter("all");
        },
      },
    };
  }

  async function importFromFolder() {
    if (!window.sessionSearch.importSkillFolder) return;
    await run(async () => {
      const result = await window.sessionSearch.importSkillFolder();
      if (!result) return;
      libraryChanged(result.managedId);
      return l(`Imported “${result.skill.name}” from folder.`, `已从本地目录导入「${result.skill.name}」。`);
    });
  }

  async function openExternalEditor(skillPath: string) {
    if (window.sessionSearch.openSkillFile) {
      await run(async () => {
        await window.sessionSearch.openSkillFile(skillPath);
      });
    } else {
      onReveal(skillPath);
    }
  }

  async function saveInlineEdit(skill: ManagedSkill) {
    if (!window.sessionSearch.updateManagedSkillFile) return;
    await run(async () => {
      const saved = await window.sessionSearch.updateManagedSkillFile(skill.managedId, activeFile, editDraft);
      setEditing(false);
      if (activeFile !== "SKILL.md") {
        setLoadedFile({ skillPath: skill.path, file: saved, error: null });
      }
      onRefresh();
      return l(`Saved ${activeFile}.`, `已保存 ${activeFile}。`);
    });
  }

  async function confirmDelete(skill: InstalledSkill) {
    setConfirmingDelete(null);
    await run(async () => {
      await onDelete(skill);
      if (!isManagedSkill(skill)) await onRefreshLocal();
    });
  }

  function localMeta(entry: LocalEntry): string {
    if (entry.projectLabel) return l(`Project · ${entry.projectLabel}`, `项目 · ${entry.projectLabel}`);
    if (entry.home.kind === "library") {
      const agents = installedAgentNames(entry);
      if (agents.length > 0) return agents.join(" · ");
      return entry.home.skill.origin.kind === "builtin"
        ? l("Built-in · Not enabled", "内置 · 未启用")
        : l("In library · Not enabled", "库中未启用");
    }
    if (entry.home.kind === "agent") {
      return installedAgentNames(entry).join(" · ");
    }
    return l("Cloud backup", "云端备份");
  }

  const globalActiveEntries = shownLocal.filter((entry) => !entry.projectLabel && entry.home.kind !== "cloud" && isEntryActiveInAgents(entry));
  const projectEntries = shownLocal.filter((entry) => entry.projectLabel !== null);
  const inactiveEntries = shownLocal.filter((entry) => !entry.projectLabel && entry.home.kind === "library" && !isEntryActiveInAgents(entry));
  const cloudOnlyEntries = shownLocal.filter((entry) => entry.home.kind === "cloud");

  const renderLocalItem = (entry: LocalEntry) => {
    const count = findings.get(entry.key) ?? 0;
    const icon = entry.projectLabel ? <FolderCode size={13} />
      : entry.home.kind === "cloud" ? <Cloud size={13} />
      : <Package size={13} />;
    return (
      <CatalogItem
        key={entry.key}
        title={entry.name}
        meta={localMeta(entry)}
        icon={icon}
        selected={currentLocal?.key === entry.key}
        onSelect={() => { setSelectedKey(entry.key); setNotice(null); setConfirmingDelete(null); }}
        trailing={count > 0 ? <Badge tone="warning">{l(`${count} findings`, `${count} 个发现`)}</Badge> : undefined}
      />
    );
  };

  const renderShareButton = (place: Extract<Place, { kind: "library" | "agent" }>) => {
    if (connectedTeams.length === 0) return null;
    if (connectedTeams.length === 1) {
      const onlyTeam = connectedTeams[0]!;
      return (
        <Button
          size="sm"
          icon={<Share2 size={14} />}
          disabled={busy}
          onClick={() => void run(() => shareSkillToTeam(onlyTeam, place))}
        >
          {l("Share to team", "分享到团队")}
        </Button>
      );
    }
    return (
      <MenuButton
        label={l("Share to team", "分享到团队")}
        text={l("Share to team", "分享到团队")}
        icon={<Share2 size={14} />}
        className={buttonClass("secondary", "sm")}
        disabled={busy}
        items={connectedTeams.map((targetTeam) => ({
          key: targetTeam.id,
          label: targetTeam.name,
          onSelect: () => void run(() => shareSkillToTeam(targetTeam, place)),
        }))}
      />
    );
  };

  const noticeLine = notice ? (
    <Notice kind={notice.kind === "alert" ? "error" : "success"} className="skill-notice-bar">
      <span>{notice.text}</span>
      {notice.action ? (
        <Button size="sm" variant="secondary" onClick={notice.action.run}>{notice.action.label}</Button>
      ) : null}
    </Notice>
  ) : null;

  const deleteConfirm = (skill: InstalledSkill) => confirmingDelete?.path === skill.path ? (
    <div className="catalog-confirm" role="group" aria-label={l("Confirm deletion", "确认删除")}>
      <span>
        {isManagedSkill(skill)
          ? l(`Delete ${skill.name} from the Skill library? It is also removed from every enabled agent.`, `从 Skill 库删除 ${skill.name}？它也会从已启用的 Agent 中移除。`)
          : l(`Delete ${skill.name} from ${skillSourceLabel(skill.source)}? This permanently deletes its folder.`, `从 ${skillSourceLabel(skill.source)} 删除 ${skill.name}？这会永久删除它的目录。`)}
      </span>
      <Button size="sm" onClick={() => setConfirmingDelete(null)}>{l("Cancel", "取消")}</Button>
      <Button size="sm" variant="danger" disabled={busy} onClick={() => void confirmDelete(skill)}>{l("Delete", "删除")}</Button>
    </div>
  ) : null;

  const renderSkillContent = (skill: InstalledSkill, managed: ManagedSkill | null) => {
    const files = packageFiles?.path === skill.path ? packageFiles.files : [];
    const currentText = activeFile === "SKILL.md"
      ? skill.markdown
      : (loadedFile?.skillPath === skill.path ? loadedFile.file?.content ?? "" : "");
    const isBinary = activeFile !== "SKILL.md" && loadedFile?.skillPath === skill.path && loadedFile.file?.encoding === "binary";
    const fileError = activeFile !== "SKILL.md" && loadedFile?.skillPath === skill.path ? loadedFile.error : null;
    const isLoadingFile = activeFile !== "SKILL.md" && loadedFile?.skillPath === skill.path && !loadedFile.file && !loadedFile.error;

    return (
      <section className="catalog-section">
        <div className="skill-content-header">
          {files.length > 1 ? (
            <div className="skill-file-tabs" role="tablist" aria-label={l("Skill files", "Skill 文件")}>
              {files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  role="tab"
                  aria-selected={activeFile === file.path}
                  onClick={() => { setActiveFile(file.path); setEditing(false); }}
                >
                  <FileCode size={12} aria-hidden="true" />
                  <span>{file.path}</span>
                </button>
              ))}
            </div>
          ) : (
            <h4>{activeFile}</h4>
          )}
          {managed && !isBinary && !isLoadingFile && !fileError && typeof window.sessionSearch.updateManagedSkillFile === "function" ? (
            editing ? (
              <div className="skill-inline-editor-actions">
                <Button size="sm" icon={<X size={13} />} disabled={busy} onClick={() => setEditing(false)}>
                  {l("Cancel", "取消")}
                </Button>
                <Button size="sm" variant="primary" icon={<Save size={13} />} disabled={busy} onClick={() => void saveInlineEdit(managed)}>
                  {l("Save", "保存")}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                icon={<Pencil size={13} />}
                onClick={() => { setEditDraft(currentText); setEditing(true); }}
              >
                {l("Edit", "编辑")}
              </Button>
            )
          ) : null}
        </div>

        {fileError ? (
          <Notice kind="error">{fileError}</Notice>
        ) : isLoadingFile ? (
          <p className="catalog-detail-status">{l("Loading file…", "正在读取文件…")}</p>
        ) : isBinary ? (
          <p className="catalog-detail-status">{l("Binary file — open the folder to inspect it.", "二进制文件，请打开目录查看。")}</p>
        ) : editing ? (
          <textarea
            className="skill-inline-editor"
            aria-label={l(`Edit ${activeFile}`, `编辑 ${activeFile}`)}
            value={editDraft}
            rows={18}
            onChange={(event) => setEditDraft(event.currentTarget.value)}
          />
        ) : isMarkdownPath(activeFile) ? (
          <div className="catalog-markdown">
            <Markdown
              text={markdownPreview(
                activeFile.toLowerCase() === "skill.md" ? skillMarkdownBody(currentText) : currentText,
                24_000,
                l("… (truncated)", "…（已截断）"),
              )}
              language={language}
            />
          </div>
        ) : (
          <pre className="catalog-code">{currentText}</pre>
        )}
      </section>
    );
  };

  let mineDetail: ReactNode;
  if (!currentLocal) {
    mineDetail = (
      <EmptyState
        title={loading || localLoading ? l("Looking for Skills…", "正在扫描本机 Skills…") : l("No Skills yet", "还没有 Skill")}
        description={l("Browse skills.sh in Discover, import a local folder, or author your first Skill.", "去「发现市场」搜索 skills.sh、导入本地目录，或新建你的第一个 Skill。")}
        action={
          <div className="skill-empty-actions">
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>{l("New Skill", "新建 Skill")}</Button>
            <Button icon={<Download size={14} />} onClick={() => setView("discover")}>{l("Browse Discover", "逛逛发现市场")}</Button>
          </div>
        }
      />
    );
  } else if (currentLocal.home.kind === "library") {
    const skill = currentLocal.home.skill;
    const { primary: primaryInstallations, overflow: overflowInstallations } = partitionInstallations(skill.installations);
    const installedNames = skill.installations
      .filter((installation) => installation.state === "installed")
      .map((installation) => TARGET_NAMES[installation.target]);
    const hasConflict = skill.installations.some((installation) => installation.state === "conflict");
    const count = findings.get(currentLocal.key) ?? 0;
    const cloudSyncVisible = cloudConfigured || showSyncSetup;
    const more: MenuItem[] = [
      { key: "reveal", label: revealLabel, icon: <FolderOpen size={14} />, onSelect: () => onReveal(skill.path) },
      { key: "copy", label: l("Copy path", "复制路径"), icon: <Copy size={14} />, onSelect: () => onCopyPath(skill.path) },
      ...(hasConflict ? [{ key: "resolve", label: l("Resolve conflicts…", "处理路径冲突…"), icon: <AlertTriangle size={14} />, onSelect: () => setTargetSkill(skill) }] : []),
      ...(onNavigateToEval ? [{ key: "eval", label: count ? l(`View ${count} findings in Eval`, `在 Eval 查看 ${count} 个发现`) : l("Evaluate in Eval", "在 Eval 中评测"), onSelect: () => onNavigateToEval(skill.name) }] : []),
      ...(!cloudSyncVisible ? [{ key: "cloud-sync", label: l("Personal cloud sync…", "个人云端同步…"), icon: <Cloud size={14} />, onSelect: () => setShowSyncSetup(true) }] : []),
      { key: "delete", label: l("Delete Skill", "删除 Skill"), icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirmingDelete(skill) },
    ];

    mineDetail = (
      <CatalogDetail
        title={skill.name}
        subtitle={skill.description}
        facts={[
          {
            label: l("Source", "来源"),
            value: skill.origin.kind === "builtin" ? l("Built-in", "内置")
              : skill.origin.kind === "skills-sh" ? "skills.sh"
              : skill.origin.kind === "remote" ? l("Cloud", "云端")
              : skill.origin.label || l("Local", "本机"),
          },
          { label: l("Active in", "生效于"), value: installedNames.length ? installedNames.join("、") : l("Not enabled", "未启用") },
          ...(skill.usageCount ? [{ label: l("Used", "调用次数"), value: l(`${skill.usageCount} times`, `${skill.usageCount} 次`) }] : []),
        ]}
        actions={
          <>
            {renderShareButton(currentLocal.home)}
            <Button size="sm" icon={<ExternalLink size={14} />} onClick={() => void openExternalEditor(skill.path)}>
              {l("Open", "打开")}
            </Button>
            <MenuButton label={l("More actions", "更多操作")} icon={<MoreHorizontal size={15} />} className={buttonClass("secondary", "sm", true)} items={more} />
          </>
        }
      >
        {noticeLine}
        {deleteConfirm(skill)}
        {skill.installations.length > 0 ? (
          <section className="catalog-section">
            <h4>{l("Enable in coding agents", "在 Coding Agent 中启用")}</h4>
            <div className="skill-agent-matrix" role="group" aria-label={l("Agent distribution", "安装到 Agent")}>
              {primaryInstallations.map((installation) => {
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
                      ? l(`${label}: Path conflict. Click to resolve.`, `${label}：路径冲突，点击处理。`)
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
              {overflowInstallations.length > 0 ? (
                <MenuButton
                  label={l("More agents", "更多 Agent")}
                  text={l(`+${overflowInstallations.length} more`, `+${overflowInstallations.length} 更多`)}
                  className="skill-agent-pill skill-agent-pill-more"
                  disabled={busy}
                  items={overflowInstallations.map((installation) => ({
                    key: installation.target,
                    label: TARGET_NAMES[installation.target],
                    onSelect: () => void toggleSingleTarget(skill, installation.target),
                  }))}
                />
              ) : null}
            </div>
          </section>
        ) : null}
        {cloudSyncVisible ? (
          <SkillSyncPanel
            skill={skill}
            entry={buildUnifiedSkillEntries(snapshot, syncSnapshot).find((entry) => entry.local?.path === skill.path) ?? null}
            remoteOnlyGroups={cloud}
            snapshot={syncSnapshot}
            busy={busy || loading}
            language={language}
            onUpload={(target, force) => onUpload(target, force)}
            onInstallRemote={onInstallRemote}
            onFetchVersion={onFetchVersion}
            onRefresh={onRefreshRemote}
            onCopySetupSql={onCopySetupSql}
            onOpenSqlEditor={onOpenSqlEditor}
          />
        ) : null}
        {renderSkillContent(skill, skill)}
      </CatalogDetail>
    );
  } else if (currentLocal.home.kind === "agent") {
    const skill = currentLocal.home.skill;
    const ownTarget = installTargetForSkillSource(skill.source);
    const canAutoAdopt = ownTarget !== null && !currentLocal.projectLabel;
    const primaryAgentTargets = detectedTargets.includes(ownTarget as SkillInstallTarget)
      ? detectedTargets
      : (ownTarget ? [ownTarget, ...detectedTargets] : detectedTargets);
    const overflowAgentTargets = allKnownTargets.filter((target) => !primaryAgentTargets.includes(target));
    const more: MenuItem[] = [
      { key: "reveal", label: revealLabel, icon: <FolderOpen size={14} />, onSelect: () => onReveal(skill.path) },
      { key: "copy", label: l("Copy path", "复制路径"), icon: <Copy size={14} />, onSelect: () => onCopyPath(skill.path) },
      ...(skill.source === "codex-system" ? [] : [{ key: "delete", label: l("Delete from the agent", "从 Agent 中删除"), icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirmingDelete(skill) }]),
    ];

    mineDetail = (
      <CatalogDetail
        title={skill.name}
        subtitle={skill.description}
        facts={[
          { label: l("Location", "所在位置"), value: currentLocal.projectLabel ? l(`Project · ${currentLocal.projectLabel}`, `项目 · ${currentLocal.projectLabel}`) : skillSourceLabel(skill.source) },
          { label: l("Folder", "目录"), value: skill.directoryPath },
        ]}
        actions={
          <>
            {currentLocal.projectLabel ? (
              <Button size="sm" variant="primary" icon={<Download size={14} />} disabled={busy} onClick={() => void run(() => adoptLocal(skill))}>
                {l("Copy to global library", "复制到全局库")}
              </Button>
            ) : null}
            {canAutoAdopt ? renderShareButton(currentLocal.home) : null}
            <Button size="sm" icon={<ExternalLink size={14} />} onClick={() => void openExternalEditor(skill.path)}>
              {l("Open", "打开")}
            </Button>
            <MenuButton label={l("More actions", "更多操作")} icon={<MoreHorizontal size={15} />} className={buttonClass("secondary", "sm", true)} items={more} />
          </>
        }
      >
        {noticeLine}
        {deleteConfirm(skill)}
        {canAutoAdopt ? (
          <section className="catalog-section">
            <h4>{l("Enable in coding agents", "在 Coding Agent 中启用")}</h4>
            <div className="skill-agent-matrix" role="group" aria-label={l("Agent distribution", "安装到 Agent")}>
              {primaryAgentTargets.map((target) => {
                const active = target === ownTarget;
                const label = TARGET_NAMES[target];
                return (
                  <button
                    key={target}
                    type="button"
                    className={`skill-agent-pill${active ? " is-installed" : ""}`}
                    aria-pressed={active}
                    disabled={busy}
                    onClick={() => void run(() => adoptLocal(skill, target))}
                  >
                    {active ? <Check size={12} /> : <Plus size={12} />}
                    <span>{label}</span>
                  </button>
                );
              })}
              {overflowAgentTargets.length > 0 ? (
                <MenuButton
                  label={l("More agents", "更多 Agent")}
                  text={l(`+${overflowAgentTargets.length} more`, `+${overflowAgentTargets.length} 更多`)}
                  className="skill-agent-pill skill-agent-pill-more"
                  disabled={busy}
                  items={overflowAgentTargets.map((target) => ({
                    key: target,
                    label: TARGET_NAMES[target],
                    onSelect: () => void run(() => adoptLocal(skill, target)),
                  }))}
                />
              ) : null}
            </div>
          </section>
        ) : null}
        {renderSkillContent(skill, null)}
      </CatalogDetail>
    );
  } else {
    mineDetail = (
      <div className="catalog-detail skills-cloud-detail">
        <CloudSkillDetail
          group={currentLocal.home.group}
          busy={busy || loading}
          language={language}
          onInstall={onInstallRemote}
          onFetchVersion={onFetchVersion}
        />
      </div>
    );
  }

  let teamDetail: ReactNode;
  if (!currentTeamSkill) {
    teamDetail = (
      <EmptyState
        title={l("No team Skills", "团队还没有共享 Skill")}
        description={l("Share any Skill from My Skills or Pull updates in Team Space.", "可以从「我的 Skills」一键分享，或在团队空间拉取最新 Skills。")}
        action={onOpenTeamSpace ? <Button icon={<Users size={14} />} onClick={onOpenTeamSpace}>{l("Open Team Space", "前往团队空间")}</Button> : undefined}
      />
    );
  } else {
    const loaded = teamPreview?.key === currentTeamSkill.key ? teamPreview : null;
    const alreadyLocal = library.some((item) => item.managedId.toLowerCase() === currentTeamSkill.id.toLowerCase() || item.name.toLowerCase() === currentTeamSkill.id.toLowerCase());
    teamDetail = (
      <CatalogDetail
        title={currentTeamSkill.id}
        subtitle={currentTeamSkill.description}
        facts={[
          { label: l("Team", "所属团队"), value: currentTeamSkill.team.name },
          ...(loaded?.value ? [{ label: l("Files", "文件数"), value: String(loaded.value.files.length) }] : []),
          ...(alreadyLocal ? [{ label: l("Local status", "本机状态"), value: l("Installed in My Skills", "已在我的 Skills 中") }] : []),
        ]}
        actions={
          <>
            <Button size="sm" variant="primary" icon={<Download size={14} />} disabled={busy} onClick={() => void run(() => copyTeamSkillToLocal(currentTeamSkill))}>
              {alreadyLocal ? l("Sync to My Skills", "更新到我的 Skills") : l("Install locally", "安装到本机")}
            </Button>
            {onOpenTeamSpace ? (
              <Button size="sm" icon={<Users size={14} />} onClick={onOpenTeamSpace}>
                {l("Open Team Space", "去团队空间")}
              </Button>
            ) : null}
          </>
        }
      >
        {noticeLine}
        {loaded?.error ? <Notice kind="error">{loaded.error}</Notice> : null}
        {loaded?.value ? (
          <section className="catalog-section">
            {loaded.value.files.length > 1 ? (
              <div className="skill-file-tabs" role="tablist" aria-label={l("Team Skill files", "团队 Skill 文件")}>
                {loaded.value.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    role="tab"
                    aria-selected={loaded.value!.file === file.path}
                    onClick={() => void openTeamFile(currentTeamSkill, file.path)}
                  >
                    <FileCode size={12} aria-hidden="true" />
                    <span>{file.path}</span>
                  </button>
                ))}
              </div>
            ) : (
              <h4>{loaded.value.file}</h4>
            )}
            {loaded.value.encoding === "utf8" ? (
              isMarkdownPath(loaded.value.file) ? (
                <div className="catalog-markdown">
                  <Markdown
                    text={markdownPreview(
                      loaded.value.file.toLowerCase().endsWith("skill.md") ? skillMarkdownBody(loaded.value.content) : loaded.value.content,
                      24_000,
                      l("… (truncated)", "…（已截断）"),
                    )}
                    language={language}
                  />
                </div>
              ) : (
                <pre className="catalog-code">{loaded.value.content}</pre>
              )
            ) : (
              <p className="catalog-detail-status">{l("Binary file.", "二进制文件。")}</p>
            )}
          </section>
        ) : !loaded?.error ? (
          <p className="catalog-detail-status">{l("Loading SKILL.md…", "正在读取 SKILL.md…")}</p>
        ) : null}
      </CatalogDetail>
    );
  }

  const teamNames = [...new Set(shownTeamSkills.map((item) => item.team.name))];
  const viewOptions: Array<{ value: SkillsView; label: string; count?: number }> = [
    { value: "mine", label: l("My Skills", "我的 Skills"), count: localEntries.length },
    ...(hasTeamTab ? [{ value: "team" as const, label: l("Team", "团队 Skills"), count: teamSkills.length }] : []),
    { value: "discover", label: l("Discover", "发现市场") },
  ];

  const addMenuItems: MenuItem[] = [
    { key: "new", label: l("New Skill…", "新建 Skill…"), icon: <Plus size={14} />, onSelect: () => setCreateOpen(true) },
    ...(typeof window.sessionSearch.importSkillFolder === "function"
      ? [{ key: "folder", label: l("Import local folder…", "从本地目录导入…"), icon: <FolderInput size={14} />, onSelect: () => void importFromFolder() }]
      : []),
  ];

  const metaSummary = [
    l(`${activeLocalCount} active`, `已启用 ${activeLocalCount} 个`),
    projectCount ? l(`${projectCount} project`, `项目级 ${projectCount} 个`) : null,
    hasTeamTab ? l(`${teamSkills.length} team`, `团队 ${teamSkills.length} 个`) : null,
  ].filter(Boolean).join(" · ");

  return (
    <CatalogPage
      title="Skills"
      meta={metaSummary}
      search={activeView !== "discover" ? (
        <CatalogSearch
          value={query}
          onChange={setQuery}
          label={l("Search Skills", "搜索 Skill")}
          placeholder={l("Search names, descriptions or agents", "搜索名称、简介或 Agent")}
        />
      ) : undefined}
      actions={
        <>
          <Segmented<SkillsView>
            label={l("Skills view", "Skill 视图")}
            value={activeView}
            onChange={(next) => { setView(next); setNotice(null); setConfirmingDelete(null); }}
            options={viewOptions}
          />
          <MenuButton
            label={l("Add Skill", "添加 Skill")}
            text={l("Add", "新建")}
            icon={<Plus size={14} />}
            className={buttonClass("secondary", "sm")}
            items={addMenuItems}
          />
          <IconButton label={l("Look again", "重新扫描")} icon={<RefreshCw size={15} />} disabled={loading} onClick={refreshAll} />
        </>
      }
    >
      {feedback ? <Notice kind={feedback.kind} className="catalog-error">{feedback.message}</Notice> : null}
      {localError ? <Notice kind="error" className="catalog-error">{localError}</Notice> : null}
      {team.problems.map((problem) => (
        <Notice key={problem.team} kind="error" className="catalog-error">
          {problem.team ? `${problem.team}: ` : ""}{problem.message}
        </Notice>
      ))}

      {activeView === "discover" ? (
        <SkillDiscoveryPane
          language={language}
          availableTargets={detectedTargets}
          targetLabels={TARGET_NAMES}
          onImported={(managedId, installedTargets) => {
            libraryChanged(managedId);
            setNotice({
              kind: "status",
              text: installedTargets.length
                ? l(`Installed to ${installedTargets.map((t) => TARGET_NAMES[t]).join(", ")}.`, `已安装并启用到 ${installedTargets.map((t) => TARGET_NAMES[t]).join("、")}。`)
                : l("Added to My Skills.", "已加入我的 Skills。"),
            });
          }}
          onCreateNew={() => setCreateOpen(true)}
          onImportFolder={() => void importFromFolder()}
        />
      ) : activeView === "team" ? (
        <ResizableSplit className="catalog-split" label={l("Resize the list", "调整列表宽度")} storageKey="agent-recall-skills-pane.v2" initialWidth={272} minWidth={210} maxWidth={380}>
          <div className="catalog-list" aria-label={l("Team Skills", "团队 Skill 列表")}>
            {teamNames.map((name) => {
              const items = shownTeamSkills.filter((item) => item.team.name === name);
              return (
                <CatalogGroup key={`team:${name}`} title={name} count={items.length}>
                  {items.map((item) => {
                    const installedLocally = library.some((skill) => skill.managedId.toLowerCase() === item.id.toLowerCase() || skill.name.toLowerCase() === item.id.toLowerCase());
                    return (
                      <CatalogItem
                        key={item.key}
                        title={item.id}
                        meta={item.description || l("Team Skill", "团队 Skill")}
                        icon={<Users size={13} />}
                        selected={currentTeamSkill?.key === item.key}
                        onSelect={() => { setSelectedTeamKey(item.key); setNotice(null); }}
                        trailing={installedLocally ? <Badge tone="accent">{l("Local", "本机已有")}</Badge> : undefined}
                      />
                    );
                  })}
                </CatalogGroup>
              );
            })}
            {shownTeamSkills.length === 0 ? (
              <p className="catalog-list-empty">{needle ? l("Nothing matches.", "没有匹配的团队 Skill。") : l("No team Skills yet.", "团队还没有共享 Skill。")}</p>
            ) : null}
          </div>
          <div className="catalog-detail-pane">{teamDetail}</div>
        </ResizableSplit>
      ) : (
        <ResizableSplit className="catalog-split" label={l("Resize the list", "调整列表宽度")} storageKey="agent-recall-skills-pane.v2" initialWidth={272} minWidth={210} maxWidth={380}>
          <div className="catalog-list" aria-label={l("Skills", "Skill 列表")}>
            <div className="skill-filter-bar" role="group" aria-label={l("Filter Skills", "筛选 Skill")}>
              <button type="button" aria-pressed={mineFilter === "all"} onClick={() => setMineFilter("all")}>
                {l("All", "全部")} <span>{localEntries.length}</span>
              </button>
              <button type="button" aria-pressed={mineFilter === "active"} onClick={() => setMineFilter("active")}>
                {l("Active", "已启用")} <span>{activeLocalCount}</span>
              </button>
              <button type="button" aria-pressed={mineFilter === "inactive"} onClick={() => setMineFilter("inactive")}>
                {l("Library", "未启用")} <span>{inactiveLocalCount}</span>
              </button>
              {projectCount > 0 ? (
                <button type="button" aria-pressed={mineFilter === "project"} onClick={() => setMineFilter("project")}>
                  {l("Project", "项目级")} <span>{projectCount}</span>
                </button>
              ) : null}
            </div>

            {globalActiveEntries.length ? (
              <CatalogGroup title={l("Active in agents", "已启用")} count={globalActiveEntries.length}>
                {globalActiveEntries.map(renderLocalItem)}
              </CatalogGroup>
            ) : null}
            {projectEntries.length ? (
              <CatalogGroup title={l("Project Skills", "项目级")} count={projectEntries.length}>
                {projectEntries.map(renderLocalItem)}
              </CatalogGroup>
            ) : null}
            {inactiveEntries.length ? (
              <CatalogGroup title={l("In library (not enabled)", "库中未启用")} count={inactiveEntries.length}>
                {inactiveEntries.map(renderLocalItem)}
              </CatalogGroup>
            ) : null}
            {cloudOnlyEntries.length ? (
              <CatalogGroup title={l("Cloud backup", "云端备份")} count={cloudOnlyEntries.length}>
                {cloudOnlyEntries.map(renderLocalItem)}
              </CatalogGroup>
            ) : null}
            {shownLocal.length === 0 && !loading && !localLoading ? (
              <p className="catalog-list-empty">
                {needle ? l("Nothing matches.", "没有匹配的 Skill。") : l("No Skills in this filter.", "此筛选下没有 Skill。")}
              </p>
            ) : null}
          </div>
          <div className="catalog-detail-pane">{mineDetail}</div>
        </ResizableSplit>
      )}

      {targetSkill ? (
        <SkillTargetDialog
          open
          skill={targetSkill}
          busy={busy}
          language={language}
          onClose={() => setTargetSkill(null)}
          onSave={async (targets, forceTargets) => {
            setBusy(true);
            try {
              await updateTargets(targetSkill, targets, forceTargets);
              setTargetSkill(null);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      <SkillCreateDialog
        open={createOpen}
        language={language}
        availableTargets={detectedTargets}
        targetLabels={TARGET_NAMES}
        onClose={() => setCreateOpen(false)}
        onCreated={(managedId, installedTargets) => {
          libraryChanged(managedId);
          setNotice({
            kind: "status",
            text: installedTargets.length
              ? l(`Created “${managedId}” and enabled in ${installedTargets.map((t) => TARGET_NAMES[t]).join(", ")}.`, `已创建「${managedId}」并启用到 ${installedTargets.map((t) => TARGET_NAMES[t]).join("、")}。`)
              : l(`Created “${managedId}”.`, `已创建「${managedId}」。`),
          });
        }}
      />
    </CatalogPage>
  );
}
