import type { TeamPushDraft } from "../../../../shared/team-push";
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Code2,
  FileCode2,
  FileText,
  FolderOpen,
  Library,
  MessagesSquare,
  PackageSearch,
  Plug,
  Plus,
  RefreshCw,
  Settings,
  Terminal,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import type { DirectoryConnection, TeamSpace } from "@agentrecall/workspace-core";
import type { TeamSnapshot, TeamRequest } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import { MenuButton } from "../../ui/menu";
import { isManagedSkill } from "../skills/managed-skill";
import { TeamAssetsPanel } from "./team-assets-panel";
import { TeamConfigurationPanel } from "./team-configuration-panel";
import { TeamDocumentsPanel } from "./team-documents-panel";
import { TeamResourceImportDialog } from "./team-resource-import-dialog";
import { TeamPushDialog } from "./team-push-dialog";
import { TeamSyncControl } from "./team-sync-control";
import { TeamSessionsPanel } from "./team-sessions-panel";
import { useTeamMcpActions, type ToolSourceApi } from "./team-mcp-actions";

export type TeamSelection = { team: TeamSpace; connection?: DirectoryConnection; enabled: boolean; busy: boolean };

/** Skills of the member's AgentRecall library that can be offered to a team; `id` is the library ID. */
export type LibrarySkillChoice = { id: string; name: string };

async function loadLibrarySkills(): Promise<LibrarySkillChoice[]> {
  const snapshot = await window.sessionSearch.listSkills();
  return snapshot.skills.filter(isManagedSkill).map((skill) => ({ id: skill.managedId, name: skill.name }));
}

export function TeamWorkspacePage({
  language,
  settingsOpen,
  onOpenSettings,
  api = window.sessionSearch.teamWorkspace,
  toolSources,
  librarySkills = loadLibrarySkills,
  drafts = [],
  onPushed,
  onSkillCopied,
}: {
  language: LanguageMode;
  settingsOpen: boolean;
  onOpenSettings(): void;
  api?: TeamWorkspaceApi;
  toolSources?: ToolSourceApi;
  librarySkills?(): Promise<LibrarySkillChoice[]>;
  drafts?: TeamPushDraft[];
  onPushed?(keys: string[]): void;
  onSkillCopied?(): void;
}) {
  const l = (en: string, zh: string) => (language === "zh" ? zh : en);
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [teamId, setTeamId] = useState<string>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const version = useRef(0);

  useEffect(() => {
    if (settingsOpen) return;
    let active = true;
    const current = ++version.current;
    void api.request({ action: "snapshot" }).then((reply) => {
      if (!active || current !== version.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "snapshot") {
        setSnapshot(reply.data.value);
        setError("");
      }
    }).catch(() => {
      if (active) setError(l("Could not load teams. Try refreshing.", "团队读取失败，请刷新重试。"));
    });
    return () => { active = false; };
  }, [api, refresh, settingsOpen]);

  const teams = snapshot?.config?.teams ?? [];
  const team = teams.find((entry) => entry.id === teamId) ?? teams[0];

  const teamSwitcherItems = [
    ...teams.map((entry) => ({
      key: entry.id,
      label: entry.name,
      hint: entry.repository.replace("https://github.com/", ""),
      onSelect: () => setTeamId(entry.id),
    })),
    {
      key: "__connect__",
      label: l("Connect team…", "连接新团队…"),
      icon: <Plus size={14} />,
      onSelect: onOpenSettings,
    },
  ];

  return (
    <section className="team-space-page">
      <header className="team-space-heading">
        <div className="team-space-title">
          <span className="team-heading-icon"><UsersRound size={18} /></span>
          <div className="team-space-identity">
            {team && teams.length > 1 ? (
              <MenuButton
                className="team-switcher-button"
                label={l("Switch team", "切换团队")}
                text={team.name}
                icon={<ChevronDown size={14} />}
                items={teamSwitcherItems}
              />
            ) : (
              <h1>{team?.name ?? l("Team Space", "团队空间")}</h1>
            )}
            <p>{team ? team.repository.replace("https://github.com/", "") : l("Shared sessions, Skills, rules, MCP and docs", "团队共用的会话、技能、指令、MCP 与文档")}</p>
          </div>
        </div>
        <div className="team-space-actions">
          <button
            type="button"
            className="team-icon-button"
            aria-label={l("Refresh teams", "刷新团队")}
            title={l("Refresh teams", "刷新团队")}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            className="team-icon-button"
            aria-label={l("Team settings", "团队设置")}
            title={l("Team settings", "团队设置")}
            onClick={onOpenSettings}
          >
            <Settings size={16} />
          </button>
        </div>
      </header>

      {drafts.length > 0 && !team ? (
        <p className="team-workspace-notice team-space-banner" role="status">
          {l(`${drafts.length} items queued, not uploaded. Connect a team to review and publish them.`, `已加入 ${drafts.length} 个待上传项，尚未上传。连接团队后可查看并发布。`)}
        </p>
      ) : null}

      {error ? <p role="alert" className="team-workspace-error team-space-banner">{error}</p> : null}

      {!snapshot ? (
        <p className="team-space-loading" role="status">{l("Loading teams…", "正在读取团队…")}</p>
      ) : !team ? (
        <div className="team-empty-workspace">
          <span className="team-avatar"><UsersRound size={24} /></span>
          <h2>{l("Connect a team repository", "连接你的第一个团队仓库")}</h2>
          <p>{l("Share coding sessions, Skills, instructions, MCP servers and docs across your team via Git — zero SaaS lock-in.", "通过 Git 仓库与团队共享会话、Skills、指令规范、MCP 与文档，一键拉取到本地项目目录。")}</p>
          <button type="button" className="team-button is-primary" onClick={onOpenSettings}>
            <Plus size={14} />{l("Connect team", "连接团队")}
          </button>
        </div>
      ) : (
        <TeamContent
          key={team.id + team.repository}
          toolSources={toolSources}
          librarySkills={librarySkills}
          language={language}
          team={team}
          snapshot={snapshot}
          api={api}
          drafts={drafts.filter((item) => !item.teamId || item.teamId === team.id)}
          onPushed={onPushed}
          onSkillCopied={onSkillCopied}
          onSnapshot={(value) => { version.current += 1; setSnapshot(value); }}
        />
      )}
    </section>
  );
}

type TeamTab = "sessions" | "skills" | "instructions" | "mcp" | "documents";

function TeamContent({
  language,
  team,
  snapshot,
  api,
  onSnapshot,
  drafts,
  onPushed,
  onSkillCopied,
  toolSources,
  librarySkills,
}: {
  language: LanguageMode;
  team: TeamSpace;
  snapshot: TeamSnapshot;
  api: TeamWorkspaceApi;
  onSnapshot(value: TeamSnapshot): void;
  drafts: TeamPushDraft[];
  onPushed?(keys: string[]): void;
  onSkillCopied?(): void;
  toolSources?: ToolSourceApi;
  librarySkills(): Promise<LibrarySkillChoice[]>;
}) {
  const l = (en: string, zh: string) => (language === "zh" ? zh : en);
  const [tab, setTab] = useState<TeamTab>("sessions");
  const mcpActions = useTeamMcpActions(language, tab === "mcp", toolSources);
  const [library, setLibrary] = useState<LibrarySkillChoice[] | null>(null);
  const [actionError, setActionError] = useState("");
  const [localChanges, setLocalChanges] = useState<TeamPushDraft[]>([]);
  const [importing, setImporting] = useState(false);
  const [directoriesOpen, setDirectoriesOpen] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushNotice, setPushNotice] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [editingBusy, setEditingBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    void api.request({ action: "workspace-changes", scope: { teamId: team.id, repository: team.repository } }).then((reply) => {
      if (!active) return;
      if (reply.ok && reply.data.kind === "workspace-changes") setLocalChanges(reply.data.value);
      else if (!reply.ok) setPushNotice(reply.error.message);
    }).catch(() => {
      if (active) setPushNotice(l("Could not read local changes.", "本地变更读取失败，请刷新重试。"));
    });
    return () => { active = false; };
  }, [api, team.id, team.repository, refreshKey]);

  useEffect(() => {
    if (tab !== "skills" || library) return;
    let active = true;
    void librarySkills().then(
      (skills) => { if (active) setLibrary(skills); },
      () => { if (active) setLibrary([]); },
    );
    return () => { active = false; };
  }, [librarySkills, library, tab]);

  const directories = (snapshot.directories ?? []).filter((entry) => entry.teamId === team.id);
  const enabledDirectoryCount = directories.filter((entry) => entry.enabled).length;
  const selection: TeamSelection = {
    team,
    enabled: Boolean(snapshot.config?.teamEnabled),
    busy: snapshot.busy || syncing || editingBusy,
  };

  const savedLocally = () => {
    setRefreshKey((value) => value + 1);
    setPushNotice(l("Saved locally. Review and publish with Push.", "已保存到本地共享空间，可点击右上角「Push」查看差异并发布。"));
  };

  const shareLibrarySkill = async (skill: string) => {
    setActionError("");
    setEditingBusy(true);
    try {
      const reply = await api.request({
        action: "workspace-stage",
        scope: { teamId: team.id, repository: team.repository },
        items: [{ kind: "library-skill", key: `library-skill:${skill}`, skill }],
      });
      if (reply.ok) savedLocally();
      else setActionError(reply.error.message);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEditingBusy(false);
    }
  };

  const pendingTotal = localChanges.length + drafts.length;

  return (
    <div className="team-space-project">
      {pushing ? (
        <TeamPushDialog
          selection={selection}
          directories={directories}
          drafts={drafts}
          language={language}
          api={api}
          onClose={() => setPushing(false)}
          onBusy={setEditingBusy}
          onPublished={(keys) => {
            onPushed?.(keys);
            setRefreshKey((value) => value + 1);
            if (keys.length) {
              setPushNotice(l("Selected items processed. See the individual results.", "所选项已处理，请查看各项发布结果。"));
            }
          }}
        />
      ) : null}

      {importing ? (
        <TeamResourceImportDialog
          selection={selection}
          directories={directories}
          language={language}
          api={api}
          onClose={() => setImporting(false)}
          onSaved={() => {
            setImporting(false);
            setRefreshKey((value) => value + 1);
            setPushNotice(l("Added to the local workspace. Push to publish.", "已加入本地共享空间，点击「Push」即可发布。"));
          }}
        />
      ) : null}

      {directoriesOpen ? (
        <TeamDirectoriesDialog
          language={language}
          team={team}
          directories={directories}
          busy={selection.busy}
          api={api}
          onSnapshot={onSnapshot}
          onClose={() => setDirectoriesOpen(false)}
        />
      ) : null}

      <div className="team-resource-toolbar">
        <div className="team-space-tabs" role="group" aria-label={l("Team resources", "团队资源")}>
          <button type="button" aria-pressed={tab === "sessions"} onClick={() => setTab("sessions")}>
            <MessagesSquare size={14} />{l("Shared sessions", "共享会话")}
          </button>
          <button type="button" aria-pressed={tab === "skills"} onClick={() => setTab("skills")}>
            <PackageSearch size={14} />Skills
          </button>
          <button type="button" aria-pressed={tab === "instructions"} onClick={() => setTab("instructions")}>
            <FileCode2 size={14} />{l("Shared instructions", "共享指令")}
          </button>
          <button type="button" aria-pressed={tab === "mcp"} onClick={() => setTab("mcp")}>
            <Plug size={14} />MCP
          </button>
          <button type="button" aria-pressed={tab === "documents"} onClick={() => setTab("documents")}>
            <FileText size={14} />{l("Documents", "文档")}
          </button>
        </div>

        <div className="team-toolbar-right">
          {tab === "skills" ? (
            <MenuButton
              className="team-button"
              label={l("Add from Skill library", "从 Skill 库添加")}
              text={l("Add from Skill library", "从 Skill 库添加")}
              icon={<Library size={14} />}
              disabled={selection.busy || !selection.enabled || !library?.length}
              items={(library ?? []).map((skill) => ({
                key: skill.id,
                label: skill.name,
                hint: skill.name === skill.id ? undefined : skill.id,
                onSelect: () => void shareLibrarySkill(skill.id),
              }))}
            />
          ) : null}
          {tab === "skills" || tab === "documents" ? (
            <button
              type="button"
              className="team-button"
              disabled={selection.busy || !selection.enabled}
              onClick={() => setImporting(true)}
            >
              <Plus size={14} />{l("Add resources", "添加资源")}
            </button>
          ) : null}
          <button
            type="button"
            className={`team-button team-directories-trigger${enabledDirectoryCount > 0 ? " has-active" : ""}`}
            aria-label={l("Working directories", "工作目录")}
            onClick={() => setDirectoriesOpen(true)}
          >
            <FolderOpen size={14} />
            <span>{l("Working directories", "工作目录")}</span>
            {directories.length > 0 ? <small className="team-pill-count">{enabledDirectoryCount}/{directories.length}</small> : null}
          </button>
          <TeamSyncControl
            team={team}
            pendingCount={pendingTotal}
            enabled={selection.enabled}
            externalBusy={snapshot.busy || editingBusy || pushing}
            language={language}
            api={api}
            onBusy={setSyncing}
            onPush={() => setPushing(true)}
            onSynced={() => setRefreshKey((value) => value + 1)}
          />
        </div>
      </div>

      {pushNotice ? (
        <div role="status" className="team-workspace-notice team-space-banner">
          <span>{pushNotice}</span>
          <button type="button" className="team-banner-dismiss" aria-label={l("Dismiss notice", "关闭提示")} onClick={() => setPushNotice("")}><X size={13} /></button>
        </div>
      ) : null}
      {actionError ? (
        <div role="alert" className="team-workspace-error team-space-banner">
          <span>{actionError}</span>
          <button type="button" className="team-banner-dismiss" aria-label={l("Dismiss error", "关闭错误")} onClick={() => setActionError("")}><X size={13} /></button>
        </div>
      ) : null}

      {tab === "sessions" ? (
        <TeamSessionsPanel refreshKey={refreshKey} selection={selection} language={language} api={api} />
      ) : tab === "skills" ? (
        <TeamAssetsPanel selection={selection} refreshKey={refreshKey} language={language} api={api} onCopied={onSkillCopied} />
      ) : tab === "documents" ? (
        <TeamDocumentsPanel selection={selection} refreshKey={refreshKey} language={language} api={api} />
      ) : (
        <TeamConfigurationPanel
          key={tab}
          kind={tab}
          copy={tab === "mcp" ? mcpActions.copy : undefined}
          share={tab === "mcp" ? mcpActions.share : undefined}
          onStage={async (change) => {
            const reply = await api.request({
              action: "workspace-stage",
              scope: { teamId: team.id, repository: team.repository },
              items: [{ kind: "configuration", key: `${change.kind}:${change.value.name}`, change }],
            });
            if (!reply.ok) throw new Error(reply.error.message);
            savedLocally();
          }}
          onBusy={setEditingBusy}
          selection={selection}
          refreshKey={refreshKey}
          language={language}
          api={api}
        />
      )}
    </div>
  );
}

function TeamDirectoriesDialog({
  language,
  team,
  directories,
  busy: externalBusy,
  api,
  onSnapshot,
  onClose,
}: {
  language: LanguageMode;
  team: TeamSpace;
  directories: DirectoryConnection[];
  busy: boolean;
  api: TeamWorkspaceApi;
  onSnapshot(value: TeamSnapshot): void;
  onClose(): void;
}) {
  const l = (en: string, zh: string) => (language === "zh" ? zh : en);
  const [adding, setAdding] = useState(false);
  const [directory, setDirectory] = useState("");
  const [targets, setTargets] = useState<Array<"codex" | "claude">>(["codex"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const running = useRef(false);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    const element = dialogRef.current;
    element?.showModal();
    return () => {
      alive.current = false;
      element?.close();
    };
  }, []);

  async function run(request: TeamRequest) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const reply = await api.request(request);
      if (!alive.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "snapshot") {
        onSnapshot(reply.data.value);
        setAdding(false);
        setDirectory("");
      } else if (reply.data.kind === "folder" && reply.data.value) {
        setDirectory(reply.data.value);
      }
    } catch {
      if (alive.current) setError(l("Request failed. Try again.", "操作未完成，请重试。"));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const locked = busy || externalBusy;
  const targetLabel = (target: "codex" | "claude") =>
    target === "codex" ? l("Codex / .agents", "Codex / .agents") : "Claude Code";

  return (
    <dialog
      ref={dialogRef}
      className="team-share-dialog team-directories-dialog"
      aria-label={l("Working directories", "工作目录")}
      onCancel={(event) => { event.preventDefault(); if (!locked) onClose(); }}
      onMouseDown={(event) => { if (event.target === dialogRef.current && !locked) onClose(); }}
    >
      <section className="team-workspace">
        <header className="team-workspace-head">
          <div>
            <h2>{l("Working directories", "工作目录")}</h2>
            <p>{l("Choose local folders to receive team Skills, instructions, MCP and docs when you Pull.", "选择接入团队资产的本地目录，点击「Pull」后统一更新 Skills、指令、MCP 与文档。")}</p>
          </div>
          <div className="team-space-actions">
            {!adding ? (
              <button type="button" className="is-primary" disabled={locked} onClick={() => setAdding(true)}>
                <Plus size={14} />{l("Connect working directory", "接入工作目录")}
              </button>
            ) : null}
            <button type="button" className="team-icon-button" disabled={locked} aria-label={l("Close working directories", "关闭工作目录")} onClick={onClose}>
              <X size={17} />
            </button>
          </div>
        </header>

        {error ? <p role="alert" className="team-workspace-error">{error}</p> : null}

        {adding ? (
          <form
            className="team-directory-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run({ action: "connect-directory", teamId: team.id, directory, targets });
            }}
          >
            <label>
              {l("Local directory", "本地目录")}
              <span className="team-settings-folder">
                <input required value={directory} disabled={locked} onChange={(event) => setDirectory(event.currentTarget.value)} />
                <button type="button" disabled={locked} onClick={() => void run({ action: "choose-folder" })}>{l("Choose", "选择")}</button>
              </span>
            </label>
            <div className="team-space-actions">
              {(["codex", "claude"] as const).map((target) => (
                <label className="team-client-chip" key={target}>
                  <input
                    type="checkbox"
                    checked={targets.includes(target)}
                    disabled={locked}
                    onChange={(event) => setTargets(event.currentTarget.checked ? [...targets, target] : targets.filter((item) => item !== target))}
                  />
                  <span>
                    {target === "codex" ? <Code2 size={14} /> : <Terminal size={14} />}
                    {targetLabel(target)}
                  </span>
                </label>
              ))}
            </div>
            <small>{l("After connecting, Pull installs and updates resources. Sessions are never uploaded automatically.", "接入后点击「Pull」统一安装和更新资源；不会自动上传会话。")}</small>
            <footer>
              <button type="button" disabled={locked} onClick={() => setAdding(false)}>{l("Cancel", "取消")}</button>
              <button type="submit" className="is-primary" disabled={locked || !directory || !targets.length}>{l("Connect", "确认接入")}</button>
            </footer>
          </form>
        ) : null}

        {!directories.length && !adding ? (
          <div className="team-empty">
            <FolderOpen size={24} />
            <strong>{l("No working directories connected", "还没有接入工作目录")}</strong>
            <p>{l("You can already browse team assets and share sessions. Connect a folder to sync assets locally.", "你已经可以浏览团队资产和分享会话；接入本地目录后可将资产自动同步到项目里。")}</p>
          </div>
        ) : null}

        {directories.length > 0 ? (
          <div className="team-directory-list">
            {directories.map((entry) => (
              <section key={entry.id} className="team-directory-row">
                <span className="team-directory-icon"><FolderOpen size={17} /></span>
                <div className="team-directory-name">
                  <strong>{entry.path.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.path}</strong>
                  <small title={entry.path}>{entry.path}</small>
                </div>
                <div className="team-directory-clients">
                  {(["codex", "claude"] as const).map((target) => (
                    <label className="team-client-chip" key={target}>
                      <input
                        type="checkbox"
                        checked={entry.targets.includes(target)}
                        disabled={locked || (entry.targets.length === 1 && entry.targets.includes(target))}
                        onChange={(event) => void run({
                          action: "update-directory",
                          teamId: team.id,
                          id: entry.id,
                          directory: entry.path,
                          enabled: entry.enabled,
                          targets: event.currentTarget.checked
                            ? [...entry.targets, target]
                            : entry.targets.filter((item) => item !== target),
                        })}
                      />
                      <span>
                        {target === "codex" ? <Code2 size={13} /> : <Terminal size={13} />}
                        {targetLabel(target)}
                      </span>
                    </label>
                  ))}
                </div>
                <label className="team-directory-toggle" title={entry.enabled ? l("Disable directory", "停用目录") : l("Enable directory", "启用目录")}>
                  <input
                    className="team-switch"
                    type="checkbox"
                    aria-label={l("Enable directory: ", "启用目录：") + entry.path}
                    checked={entry.enabled}
                    disabled={locked}
                    onChange={(event) => void run({
                      action: "update-directory",
                      teamId: team.id,
                      id: entry.id,
                      directory: entry.path,
                      enabled: event.currentTarget.checked,
                      targets: entry.targets,
                    })}
                  />
                  <span>{entry.enabled ? l("On", "启用") : l("Off", "停用")}</span>
                </label>
                <button
                  type="button"
                  className="team-icon-button team-directory-remove"
                  disabled={locked}
                  aria-label={l("Disconnect directory: ", "断开工作目录：") + entry.path}
                  title={l("Disconnect directory…", "断开工作目录…")}
                  onClick={() => void run({ action: "disconnect-directory", teamId: team.id, id: entry.id, directory: entry.path })}
                >
                  <Trash2 size={14} />
                </button>
              </section>
            ))}
          </div>
        ) : null}

        {directories.length > 0 ? (
          <p className="team-footnote">{l("Disabling or disconnecting preserves installed files and shared sessions.", "停用或断开连接会保留已有文件和已分享会话。")}</p>
        ) : null}
      </section>
    </dialog>
  );
}
