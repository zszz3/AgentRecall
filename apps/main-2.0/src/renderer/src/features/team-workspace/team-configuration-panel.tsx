import { useEffect, useRef, useState } from "react";
import { FileCode2, Plug, SlidersHorizontal, X } from "lucide-react";
import type { TeamCatalog } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";

type Resource = { key: string; name: string; summary: string; content: string; targets: string[] };
export function TeamConfigurationPanel({ selection, language, refreshKey, api }: { selection: TeamSelection; language: LanguageMode; refreshKey: number; api: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null), [error, setError] = useState(""), [reader, setReader] = useState<Resource | null>(null), [retry, setRetry] = useState(0);
  const panel = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
  const { team, enabled } = selection;
  useEffect(() => {
    let active = true; setCatalog(null); setReader(null); setError("");
    if (enabled) void api.request({ action: "catalog", scope: { teamId: team.id, repository: team.repository } }).then((reply) => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
      else setError(l("Could not load configuration.", "配置读取失败，请重试。"));
    }).catch(() => { if (active) setError(l("Could not load configuration.", "配置读取失败，请重试。")); });
    return () => { active = false; };
  }, [api, team.id, team.repository, enabled, refreshKey, retry]);
  useEffect(() => { if (reader) panel.current?.focus({ preventScroll: true }); else if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); }, [reader]);
  const configuration = catalog?.assets?.configuration;
  const sections = [
    { key: "instructions", title: l("Shared instructions", "共享指令"), description: l("Team rules, added to each agent’s instruction file.", "团队约定，合入客户端的指令文件。"), Icon: FileCode2, items: (configuration?.instructions ?? []).map((item) => ({ key: "instruction:" + item.id, name: item.name, targets: item.targets, summary: item.targets.map((target) => target === "codex" ? "AGENTS.md" : "CLAUDE.md").join(" · "), content: item.content })) },
    { key: "mcp", title: "MCP", description: l("Shared tool connections. Credentials stay on each member’s machine.", "共用的工具连接，密钥由每位成员在本机提供。"), Icon: Plug, items: (configuration?.mcpServers ?? []).map((item) => ({ key: "mcp:" + item.id, name: item.name, targets: item.targets, summary: item.transport === "stdio" ? item.command : item.url, content: JSON.stringify(item, null, 2) })) },
    { key: "environment", title: "Env", description: l("Shared, non-secret environment values for agent commands.", "供 Agent 执行命令时使用的公共变量，请勿在此存放密钥。"), Icon: SlidersHorizontal, items: (configuration?.environment ?? []).map((item) => ({ key: "env:" + item.name, name: item.name, targets: item.targets, summary: item.value, content: `${item.name}=${item.value}` })) },
  ];
  return <div className={`team-documents-layout${reader ? " has-reader" : ""}`} onKeyDown={(event) => { if (event.key === "Escape" && reader) { event.stopPropagation(); setReader(null); } }}>
    <section className="team-workspace team-documents-list" aria-label={l("Team configuration", "团队配置")}>
      <header className="team-workspace-head"><div><h2>{l("Configuration", "配置")}</h2><p>{l("Instructions, tools and environment, updated together with Sync team.", "共享指令、工具和环境变量，随「同步团队」一起更新。")}</p></div></header>
      {!enabled ? <p>{l("Enable teams in Settings to view configuration.", "在设置中启用团队后，可查看共享配置。")}</p> : error ? <div role="alert" className="team-workspace-error">{error}<button onClick={() => setRetry((value) => value + 1)}>{l("Retry", "重试")}</button></div> : !catalog ? <p role="status">{l("Loading…", "正在读取…")}</p> : <>
        {catalog.notice && <p className="team-workspace-notice">{catalog.notice}</p>}
        {sections.map(({ key, title, description, Icon, items }) => <section className="team-configuration-group" key={key} aria-label={title}><header><Icon size={17} /><h3>{title}</h3><span className="team-count">{items.length}</span></header><p>{description}</p><div className="team-resource-list">{items.map((item) => <button className="team-resource-row" key={item.key} aria-pressed={reader?.key === item.key} onClick={(event) => { trigger.current = event.currentTarget; setReader(item); }}><Icon size={17} /><span><strong>{item.name}</strong><small>{item.summary}</small></span><span>{l("View", "查看")}</span></button>)}</div>{!items.length && <small className="team-configuration-empty">{l("No resources published yet.", "团队暂未发布此类资源。")}</small>}</section>)}
        <p className="team-footnote">{l("Publish configuration in your team repository, then sync. The client may require restart and trust or MCP approval.", "在团队仓库维护配置，发布后同步。客户端可能需要重新启动、信任工作目录或确认 MCP。")}</p>
      </>}
    </section>
    {reader && <aside ref={panel} tabIndex={-1} className="team-document-reader team-workspace" aria-label={l("Configuration details", "配置详情")}><header className="team-document-reader-head"><div><small>{reader.targets.map((target) => target === "codex" ? "Codex" : "Claude Code").join(" · ")}</small><h3>{reader.name}</h3></div><button className="team-icon-button" aria-label={l("Close configuration", "关闭配置")} onClick={() => setReader(null)}><X size={17} /></button></header><div className="team-document-reader-body"><pre>{reader.content}</pre></div></aside>}
  </div>;
}
