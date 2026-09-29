import { useEffect, useRef, useState } from "react";
import { FileCode2, Pencil, Plug, Plus, SlidersHorizontal, X } from "lucide-react";
import type { ConfigurationChange } from "@agentrecall/workspace-core";
import { TeamConfigurationEditor } from "./team-configuration-editor";
import type { TeamCatalog } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";

type Resource = { key: string; name: string; summary: string; content: string; targets: string[]; change: ConfigurationChange };
export function TeamConfigurationPanel({ kind, selection, language, refreshKey, api, onBusy, onStage }: { kind: "instructions" | "mcp" | "environment"; selection: TeamSelection; language: LanguageMode; refreshKey: number; api: TeamWorkspaceApi; onBusy(value: boolean): void; onStage?(change: ConfigurationChange): void }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null), [error, setError] = useState(""), [reader, setReader] = useState<Resource | null>(null), [retry, setRetry] = useState(0);
  const [editor, setEditor] = useState<ConfigurationChange | null | undefined>(undefined), [notice, setNotice] = useState("");
  const panel = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
  const { team, enabled } = selection;
  useEffect(() => {
    let active = true; setCatalog(null); setReader(null); setError("");
    if (enabled) void api.request({ action: "catalog", scope: { teamId: team.id, repository: team.repository } }).then((reply) => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
      else setError(l("Could not load resources.", "资源读取失败，请重试。"));
    }).catch(() => { if (active) setError(l("Could not load resources.", "资源读取失败，请重试。")); });
    return () => { active = false; };
  }, [api, team.id, team.repository, enabled, refreshKey, retry, kind]);
  useEffect(() => { if (reader) panel.current?.focus({ preventScroll: true }); else if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); }, [reader]);
  const configuration = catalog?.assets?.configuration;
  const sections = {
    instructions: { title: l("Shared instructions", "共享指令"), emptyTitle: l("No shared instructions yet", "还没有共享指令"), description: l("Team rules, added to each agent’s instruction file.", "团队约定，合入客户端的指令文件。"), Icon: FileCode2, items: (): Resource[] => (configuration?.instructions ?? []).map((item) => ({ key: "instruction:" + item.id, name: item.name, targets: item.targets, summary: item.targets.map((target) => target === "codex" ? "AGENTS.md" : "CLAUDE.md").join(" · "), content: item.content, change: { kind: "instructions", operation: "update", value: { id: item.id, name: item.name, content: item.content, targets: item.targets } } })) },
    mcp: { title: "MCP", emptyTitle: l("No shared MCP servers yet", "还没有团队 MCP 服务"), description: l("Shared tool connections. Credentials stay on each member’s machine.", "共用的工具连接，密钥由每位成员在本机提供。"), Icon: Plug, items: (): Resource[] => (configuration?.mcpServers ?? []).map((item) => ({ key: "mcp:" + item.id, name: item.name, targets: item.targets, summary: item.transport === "stdio" ? item.command : item.url, content: JSON.stringify(item, null, 2), change: { kind: "mcp", operation: "update", value: item } })) },
    environment: { title: "Env", emptyTitle: l("No shared environment variables yet", "还没有共享环境变量"), description: l("Shared, non-secret environment values for agent commands.", "供 Agent 执行命令时使用的公共变量，请勿在此存放密钥。"), Icon: SlidersHorizontal, items: (): Resource[] => (configuration?.environment ?? []).map((item) => ({ key: "env:" + item.name, name: item.name, targets: item.targets, summary: item.value, content: `${item.name}=${item.value}`, change: { kind: "environment", operation: "update", value: item } })) },
  };
  const { title, emptyTitle, description, Icon } = sections[kind];
  const items = sections[kind].items();
  const detailsLabel = l(`${title} details`, `${title}详情`);
  return <div className={`team-documents-layout${reader ? " has-reader" : ""}`} onKeyDown={(event) => { if (event.key === "Escape" && reader) { event.stopPropagation(); setReader(null); } }}>
    <section className="team-workspace team-documents-list" aria-label={title}>
      <header className="team-workspace-head"><div><h2>{title} {catalog?.assets && <span className="team-count">{items.length}</span>}</h2><p>{description}</p></div><button className="is-primary" disabled={!enabled || selection.busy || !catalog?.assets} title={!catalog?.assets ? l("Pull first", "请先Pull 拉取") : undefined} onClick={() => setEditor(null)}><Plus size={15} />{l("Add ", "新增 ")}{title}</button></header>
      {notice && <p role="status" className="team-workspace-notice">{notice}</p>}
      {!enabled ? <p>{l("Enable teams in Settings to view shared resources.", "在设置中启用团队后，可查看共享资源。")}</p> : error ? <div role="alert" className="team-workspace-error">{error}<button onClick={() => setRetry((value) => value + 1)}>{l("Retry", "重试")}</button></div> : !catalog ? <p role="status">{l("Loading…", "正在读取…")}</p> : <>
        {catalog.notice && <p className="team-workspace-notice">{catalog.notice}</p>}
        <div className="team-resource-list">{items.map((item) => <button className="team-resource-row" key={item.key} aria-pressed={reader?.key === item.key} onClick={(event) => { trigger.current = event.currentTarget; setReader(item); }}><Icon size={17} /><span><strong>{item.name}</strong><small>{item.summary}</small></span><span>{l("View", "查看")}</span></button>)}</div>
        {catalog.assets && !items.length && <div className="team-empty"><Icon size={26} /><strong>{emptyTitle}</strong><p>{l("Published resources will appear here after syncing.", "团队发布后，点击上方「Pull 拉取」即可获取。")}</p></div>}
        {items.length > 0 && <p className="team-footnote">{kind === "mcp" ? l("Updated with Pull. The client may require trust or MCP approval.", "随「Pull 拉取」统一更新，客户端可能需要信任工作目录或确认 MCP。") : l("Updated in enabled working directories with Pull.", "随「Pull 拉取」统一更新到已启用的工作目录。")}</p>}
      </>}
    </section>
    {reader && <aside ref={panel} tabIndex={-1} className="team-document-reader team-workspace" aria-label={detailsLabel}><header className="team-document-reader-head"><div><small>{reader.targets.map((target) => target === "codex" ? "Codex" : "Claude Code").join(" · ")}</small><h3>{reader.name}</h3></div><div className="team-space-actions"><button disabled={selection.busy} onClick={() => setEditor(reader.change)}><Pencil size={14} />{l("Edit", "编辑")}</button><button className="team-icon-button" aria-label={l("Close details", "关闭详情")} onClick={() => setReader(null)}><X size={17} /></button></div></header><div className="team-document-reader-body"><pre>{reader.content}</pre></div></aside>}
    {editor !== undefined && catalog?.assets && <TeamConfigurationEditor kind={kind} initial={editor} onStage={onStage ? change => { setEditor(undefined); onStage(change); } : undefined} selection={selection} revision={catalog.assets.commit} language={language} api={api} onBusy={onBusy} onClose={() => setEditor(undefined)} onPublished={(result) => {
      setEditor(undefined); setReader(null); setRetry(value => value + 1);
      setNotice(result.cleanupRequired ? l("Published. Temporary files need cleanup; sync to check the resource before trying again.", "资源已发布，但临时文件需要清理。请先同步查看，不要重复发布。") : result.cacheUpdated ? l("Published to the team. Pull to update working directories.", "已发布到团队。点击「Pull 拉取」更新工作目录。") : l("Published, but the local cache could not be refreshed. Pull to load the resource.", "已发布，但本地缓存未刷新。请点击「Pull 拉取」获取资源。"));
    }} />}
  </div>;
}
