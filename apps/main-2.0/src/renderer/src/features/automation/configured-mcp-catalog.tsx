import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { ExternalLink, FolderOpen, RefreshCw } from "lucide-react";

import type { ConfigurationChange } from "@agentrecall/workspace-core";
import type { AgentMcpCatalog, AgentMcpServer } from "../../../../shared/ipc/agent-mcp";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import { ResizableSplit } from "../../components/resizable-split";
import { CatalogDetail, CatalogGroup, CatalogItem, CatalogPage, CatalogSearch } from "../../ui/catalog";
import { Badge, Button, EmptyState, IconButton, Notice } from "../../ui/primitives";
import { useTeamMcpActions, type ToolSourceApi } from "../team-workspace/team-mcp-actions";
import { useTeamCatalogs } from "../team-workspace/use-team-catalogs";
import { ipcErrorText } from "../status/status-messages";

type TeamMcpServer = Extract<ConfigurationChange, { kind: "mcp" }>["value"];
interface TeamMcp { key: string; team: { id: string; name: string }; server: TeamMcpServer }
type Selection = { kind: "agent"; server: AgentMcpServer } | { kind: "team"; item: TeamMcp };

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
}

function agentKey(server: AgentMcpServer): string {
  return `agent:${server.name}:${server.locations.map((location) => location.file).join("|")}:${server.url ?? server.command ?? ""}`;
}

/** The group a server is listed under: user-level when any agent reads it everywhere, otherwise its first project. */
function groupOf(server: AgentMcpServer): string | null {
  return server.locations.some((location) => location.scope === "user") ? null : server.locations[0]?.project ?? null;
}

/**
 * MCP servers that coding agents on this machine are configured to start, per agent and per
 * project, plus the team's servers. Read-only: agents own their files; the page opens them.
 */
export function ConfiguredMcpCatalog({ language, switcher, onOpenTeamSpace, teamApi = window.sessionSearch.teamWorkspace, toolSources }: {
  language: LanguageMode;
  switcher: ReactNode;
  onOpenTeamSpace?(): void;
  teamApi?: TeamWorkspaceApi;
  toolSources?: ToolSourceApi;
}): ReactElement {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const api = window.sessionSearch;
  const [refreshKey, setRefreshKey] = useState(0);
  const [catalog, setCatalog] = useState<AgentMcpCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "status" | "alert"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const team = useTeamCatalogs(teamApi, refreshKey);
  const { copy } = useTeamMcpActions(language, false, toolSources);

  useEffect(() => {
    let active = true;
    setError(null);
    api.listAgentMcpServers().then(
      (next) => { if (active) setCatalog(next); },
      (cause: unknown) => { if (active) { setCatalog({ servers: [], problems: [] }); setError(ipcErrorText(cause)); } },
    );
    return () => { active = false; };
  }, [api, refreshKey]);

  const teamItems = useMemo<TeamMcp[]>(() => (team.teams ?? []).flatMap(({ team: owner, catalog: teamCatalog }) =>
    (teamCatalog.assets?.configuration?.mcpServers ?? []).map((server) => ({ key: `team:${owner.id}:${server.id}`, team: { id: owner.id, name: owner.name }, server: server as TeamMcpServer }))), [team.teams]);

  const needle = query.trim().toLowerCase();
  const matches = (...texts: Array<string | null | undefined>) => !needle || texts.some((text) => text?.toLowerCase().includes(needle));
  const servers = (catalog?.servers ?? []).filter((server) => matches(server.name, server.command, server.url, ...server.args, ...server.locations.flatMap((location) => [location.agent, location.file, location.project])));
  const userServers = servers.filter((server) => groupOf(server) === null);
  const projects = [...new Set(servers.flatMap((server) => { const group = groupOf(server); return group ? [group] : []; }))];
  const shownTeam = teamItems.filter((item) => matches(item.server.name, item.team.name, item.server.transport === "http" ? item.server.url : item.server.command));
  const teams = [...new Set(shownTeam.map((item) => item.team.name))];

  const selections: Array<{ key: string; selection: Selection }> = [
    ...userServers.map((server) => ({ key: agentKey(server), selection: { kind: "agent" as const, server } })),
    ...projects.flatMap((project) => servers.filter((server) => groupOf(server) === project).map((server) => ({ key: agentKey(server), selection: { kind: "agent" as const, server } }))),
    ...shownTeam.map((item) => ({ key: item.key, selection: { kind: "team" as const, item } })),
  ];
  const current = selections.find((entry) => entry.key === selectedKey) ?? selections[0] ?? null;

  async function run(action: () => Promise<string | void>) {
    setNotice(null); setBusy(true);
    try {
      const message = await action();
      if (message) setNotice({ kind: "status", text: message });
    } catch (cause) { setNotice({ kind: "alert", text: ipcErrorText(cause) }); }
    finally { setBusy(false); }
  }

  const agents = (server: AgentMcpServer) => [...new Set(server.locations.map((location) => location.agent))];
  const transport = (kind: "stdio" | "http") => kind === "stdio" ? l("Local command", "本机命令") : "HTTP";
  const item = (key: string, title: string, metaText: string, trailing?: ReactElement) =>
    <CatalogItem key={key} title={title} meta={metaText} trailing={trailing} selected={current?.key === key} onSelect={() => { setSelectedKey(key); setNotice(null); }} />;
  const offBadge = (server: AgentMcpServer) => server.disabled ? <Badge>{l("Off", "已关闭")}</Badge> : undefined;

  const total = catalog?.servers.length ?? 0;
  const meta = catalog === null ? l("Looking for MCP servers…", "正在查找 MCP 服务…")
    : l(`${total} servers in agents${teamItems.length ? ` · ${teamItems.length} team servers` : ""}`, `Agent 中 ${total} 个${teamItems.length ? ` · 团队 ${teamItems.length} 个` : ""}`);

  const list = <div className="catalog-list" aria-label={l("Configured MCP servers", "已配置的 MCP 服务")}>
    {userServers.length > 0 ? <CatalogGroup title={l("Agents", "Agent 用户级")} hint={l("Available in every project", "在所有项目中可用")} count={userServers.length}>
      {userServers.map((server) => item(agentKey(server), server.name, agents(server).join(" · "), offBadge(server)))}
    </CatalogGroup> : null}
    {projects.map((project) => {
      const inProject = servers.filter((server) => groupOf(server) === project);
      return <CatalogGroup key={project} title={folderName(project)} hint={project} count={inProject.length}>
        {inProject.map((server) => item(agentKey(server), server.name, agents(server).join(" · "), offBadge(server)))}
      </CatalogGroup>;
    })}
    {teams.map((name) => {
      const inTeam = shownTeam.filter((entry) => entry.team.name === name);
      return <CatalogGroup key={`team:${name}`} title={l(`Team · ${name}`, `团队 · ${name}`)} count={inTeam.length}>
        {inTeam.map((entry) => item(entry.key, entry.server.name, transport(entry.server.transport)))}
      </CatalogGroup>;
    })}
    {catalog !== null && selections.length === 0 ? <p className="catalog-list-empty">{needle ? l("Nothing matches.", "没有匹配的 MCP 服务。") : l("No MCP servers found in agents.", "没有在 Agent 中找到 MCP 服务。")}</p> : null}
  </div>;

  const noticeLine = notice ? <Notice kind={notice.kind === "alert" ? "error" : "success"}>{notice.text}</Notice> : null;
  let detail: ReactElement;
  if (!current) {
    detail = <EmptyState
      title={catalog === null ? l("Looking for MCP servers…", "正在查找 MCP 服务…") : l("No MCP servers", "没有 MCP 服务")}
      description={l("AgentRecall reads the MCP settings of Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode, Cursor and ZCode, and the MCP files in projects with Sessions.", "AgentRecall 会读取 Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Cursor 和 ZCode 的 MCP 配置，以及有会话的项目里的 MCP 配置文件。")}
    />;
  } else if (current.selection.kind === "agent") {
    const server = current.selection.server;
    const first = server.locations[0]!.file;
    detail = <CatalogDetail
      title={server.name}
      subtitle={transport(server.transport)}
      facts={[
        { label: l("Agents", "Agent"), value: agents(server).join("、") },
        ...(server.disabled ? [{ label: l("Status", "状态"), value: l("Turned off in the agent's settings", "在 Agent 配置中已关闭") }] : []),
        ...(server.envNames.length ? [{ label: l("Environment variables", "环境变量"), value: server.envNames.join("、") }] : []),
        ...(server.headerNames.length ? [{ label: l("Request headers", "请求头"), value: server.headerNames.join("、") }] : []),
      ]}
      actions={<>
        <Button size="sm" variant="primary" icon={<ExternalLink size={14} />} onClick={() => void run(() => api.openAgentMcpFile(first))}>{l("Open in editor", "用编辑器打开")}</Button>
        <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void run(() => api.revealAgentMcpFile(first))}>{l("Show in folder", "在文件夹中显示")}</Button>
      </>}
    >
      {noticeLine}
      <section className="catalog-section">
        <h4>{server.transport === "stdio" ? l("Command", "启动命令") : l("Address", "地址")}</h4>
        <pre className="catalog-code">{server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}</pre>
        <p className="catalog-detail-status">{l("Values of variables, headers and credential-like arguments are not shown.", "环境变量、请求头和疑似密钥的参数值不会显示。")}</p>
      </section>
      <section className="catalog-section">
        <h4>{l("Configured in", "配置位置")}</h4>
        <ul className="catalog-locations">
          {server.locations.map((location) => <li key={`${location.agent}:${location.file}:${location.project ?? ""}`}>
            <span><strong>{location.agent}</strong><small>{location.project ? l(`Project ${folderName(location.project)}`, `项目 ${folderName(location.project)}`) : l("User level", "用户级")}</small></span>
            <code>{location.file}</code>
            <IconButton size="sm" label={l("Open in editor", "用编辑器打开")} icon={<ExternalLink size={14} />} onClick={() => void run(() => api.openAgentMcpFile(location.file))} />
          </li>)}
        </ul>
      </section>
    </CatalogDetail>;
  } else {
    const entry = current.selection.item;
    const server = entry.server;
    const variables = server.transport === "stdio" ? Object.keys(server.env) : Object.keys(server.headers);
    detail = <CatalogDetail
      title={server.name}
      subtitle={l(`Team ${entry.team.name}`, `团队 ${entry.team.name}`)}
      facts={[
        { label: l("Kind", "类型"), value: transport(server.transport) },
        { label: l("Written for", "写入"), value: server.targets.map((target) => target === "codex" ? "Codex" : "Claude Code").join("、") },
        ...(variables.length ? [{ label: server.transport === "stdio" ? l("Environment variables", "环境变量") : l("Request headers", "请求头"), value: variables.join("、") }] : []),
      ]}
      actions={<>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => copy.run({ kind: "mcp", operation: "update", value: server }, entry.team))}>{copy.label}</Button>
        {onOpenTeamSpace ? <Button size="sm" onClick={onOpenTeamSpace}>{l("Edit in team space", "去团队空间编辑")}</Button> : null}
      </>}
    >
      {noticeLine}
      <section className="catalog-section">
        <h4>{server.transport === "stdio" ? l("Command", "启动命令") : l("Address", "地址")}</h4>
        <pre className="catalog-code">{server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}</pre>
        <p className="catalog-detail-status">{l("Pull writes team servers into the project files of connected working folders; each member provides the credentials locally.", "Pull 后，团队 MCP 会写进已接入工作目录的项目配置；密钥由每位成员在本机提供。")}</p>
      </section>
    </CatalogDetail>;
  }

  return <CatalogPage
    title="MCP"
    meta={meta}
    search={<CatalogSearch value={query} onChange={setQuery} label={l("Search MCP servers", "搜索 MCP 服务")} placeholder={l("Search servers, agents or projects", "搜索服务、Agent 或项目")} />}
    actions={<>{switcher}<IconButton label={l("Look again", "重新查找")} icon={<RefreshCw size={15} />} onClick={() => setRefreshKey((value) => value + 1)} /></>}
  >
    {error ? <Notice kind="error" className="catalog-error">{error}</Notice> : null}
    {(catalog?.problems ?? []).map((problem) => <Notice key={problem.file} kind="error" className="catalog-error">{problem.message}</Notice>)}
    {team.problems.map((problem) => <Notice key={problem.team} kind="error" className="catalog-error">{problem.team ? `${problem.team}: ` : ""}{problem.message}</Notice>)}
    <ResizableSplit className="catalog-split" label={l("Resize the list", "调整列表宽度")} storageKey="agent-recall-mcp-pane" initialWidth={300} minWidth={220} maxWidth={460}>
      {list}
      <div className="catalog-detail-pane">{detail}</div>
    </ResizableSplit>
  </CatalogPage>;
}
