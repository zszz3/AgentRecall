import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, LoaderCircle, MessagesSquare, RefreshCw, Search, Wrench, X } from "lucide-react";
import type { TeamSessionFetchState, TeamSessionSnapshot, TeamSessionTurnsPage, TeamSessionPage, TeamSharedSession } from "../../../../shared/team-sessions";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamRequest } from "../../../../shared/ipc/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";
import { ResizableSplit } from "../../components/resizable-split";
import { teamSessionReadCache } from "./team-session-read-cache";
import { HighlightedSearchText } from "../../search-highlight";
import { SOURCE_LABEL } from "../../session-ui";
import { isSessionSource } from "../../../../core/session-sources";
import { TeamSessionReader } from "./team-session-reader";

const itemKey = (item: { id: number; digest: string }) => `${item.id}:${item.digest}`;
const active = (phase?: TeamSessionFetchState["phase"]) => phase === "queued" || phase === "downloading" || phase === "indexing";

export function TeamSessionsPanel({ selection, language, refreshKey = 0, api = window.sessionSearch.teamWorkspace }: { selection: TeamSelection; language: LanguageMode; refreshKey?: number; api?: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const { team, enabled } = selection;
  const cache = teamSessionReadCache(api);
  const scope = { teamId: team.id, repository: team.repository };
  const [list, setList] = useState<TeamSessionPage | null>(null);
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0), [pollVersion, setPollVersion] = useState(0);
  const [selected, setSelected] = useState<TeamSharedSession | null>(null);
  const [snapshot, setSnapshot] = useState<TeamSessionSnapshot | null>(null);
  const [firstPage, setFirstPage] = useState<TeamSessionTurnsPage | null>(null);
  const [states, setStates] = useState<TeamSessionFetchState[]>([]);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [mode, setMode] = useState<"sessions" | "turns">("turns");
  const [includeTools, setIncludeTools] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => { setSearchQuery(query.trim()); setPage(1); }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  const [loading, setLoading] = useState(false), [opening, setOpening] = useState(false);
  const [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const inFlight = useRef(new Set<string>()), generation = useRef(0);
  const stateFor = (item: TeamSharedSession): TeamSessionFetchState | undefined => {
    const cached = cache.peek({ action: "session-open", scope, id: item.id, digest: item.digest });
    if (cached?.ok && cached.data.kind === "session-open") return { id: item.id, digest: item.digest, phase: "ready", source: cached.data.value.records[0]?.source ?? states.find(state => itemKey(state) === itemKey(item))?.source };
    return states.find(state => itemKey(state) === itemKey(item));
  };
  const agentLabel = (source?: string) => source ? isSessionSource(source) ? SOURCE_LABEL[source] : source : l("Agent unknown", "Agent 未知");
  const selectedState = selected ? stateFor(selected) : undefined;
  const phaseLabel = (phase?: TeamSessionFetchState["phase"]) => {
    switch (phase) {
      case "queued": return l("Queued", "等待同步");
      case "downloading": return l("Syncing", "同步中");
      case "indexing": return l("Indexing", "建立索引");
      case "ready": return l("Ready", "可阅读");
      case "failed": return l("Failed", "失败");
      case "cancelled": return l("Cancelled", "已取消");
      default: return l("Pull required", "等待 Pull");
    }
  };
  useEffect(() => {
    let live = true;
    generation.current++;
    const request = { action: "session-list" as const, scope, page, query: searchQuery, mode, includeTools };
    const previous = enabled ? cache.peek(request) : undefined;
    const cachedList = previous?.ok && previous.data.kind === "session-list" ? previous.data.value : null;
    setList(cachedList); setSelected(null); setSnapshot(null); setFirstPage(null); setStates([]); setError(""); setPending([]);
    if (enabled) {
      setLoading(!cachedList);
      void api.request(request).then(reply => {
        if (!live) return;
        if (!reply.ok) setError(reply.error.message);
        else if (reply.data.kind === "session-list") { cache.remember(request, reply); setList(reply.data.value); }
      }).catch(() => { if (live) setError(l("Could not load shared sessions.", "共享会话读取失败，请刷新重试。")); }).finally(() => { if (live) setLoading(false); });
    }
    return () => { live = false; generation.current++; };
  }, [api, team.id, team.repository, enabled, page, refresh, refreshKey, selection.busy, searchQuery, mode, includeTools]);
  useEffect(() => {
    if (!list || !enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const reply = await api.request({ action: "session-status", scope, items: list.items.map(({ id, digest }) => ({ id, digest })) });
        if (!live) return;
        if (!reply.ok) { setError(reply.error.message); return; }
        if (reply.data.kind === "session-status") {
          setStates(reply.data.value);
          if (reply.data.value.some(state => active(state.phase))) timer = setTimeout(() => void poll(), 1000);
        }
      } catch { if (live) setError(l("Could not refresh download status.", "下载状态读取失败，请刷新重试。")); }
    };
    void poll();
    // Only polling belongs to this page. Accepted downloads belong to the app.
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [api, list, team.id, team.repository, enabled, pollVersion]);
  useEffect(() => {
    let live = true;
    if (!selected || selectedState?.phase !== "ready") { setSnapshot(null); setFirstPage(null); setOpening(false); return; }
    const request = { action: "session-open" as const, scope, id: selected.id, digest: selected.digest };
    const turnsRequest = { action: "session-turns" as const, scope, id: selected.id, digest: selected.digest, record: selected.match?.record ?? 0, offset: selected.match?.offset ?? 0 };
    const previous = cache.peek(request), previousTurns = cache.peek(turnsRequest);
    if (previous?.ok && previous.data.kind === "session-open" && previousTurns?.ok && previousTurns.data.kind === "session-turns") {
      setSnapshot(previous.data.value); setFirstPage(previousTurns.data.value); setOpening(false);
    } else {
      setSnapshot(null); setFirstPage(null); setOpening(true);
      void Promise.all([cache.read(request), cache.read(turnsRequest)]).then(([reply, turns]) => {
        if (!live) return;
        if (!reply.ok) setError(reply.error.message);
        else if (!turns.ok) setError(turns.error.message);
        else if (reply.data.kind === "session-open" && turns.data.kind === "session-turns") { setSnapshot(reply.data.value); setFirstPage(turns.data.value); }
      }).catch(() => { if (live) setError(l("Could not open session.", "会话读取失败，请重试。")); }).finally(() => { if (live) setOpening(false); });
    }
    return () => { live = false; };
  }, [api, selected, selectedState?.phase, team.id, team.repository]);
  async function run(request: TeamRequest, item: TeamSharedSession) {
    const current = generation.current, key = `${current}:${itemKey(item)}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key); setPending([...inFlight.current].filter(value => value.startsWith(`${current}:`)).map(value => value.slice(value.indexOf(":") + 1))); setError(""); setFeedback("");
    try {
      const reply = await api.request(request);
      if (current !== generation.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "session-fetch") {
        const state = reply.data.value;
        setStates(values => [...values.filter(value => itemKey(value) !== itemKey(item)), state]);
      } else if (reply.data.kind === "complete") {
        setFeedback(reply.data.message);
        if (request.action === "session-withdraw") setRefresh(value => value + 1);
      }
      setPollVersion(value => value + 1);
    } catch { if (current === generation.current) setError(l("Request failed. Try again.", "请求未完成，请重试。")); }
    finally { inFlight.current.delete(key); if (current === generation.current) setPending([...inFlight.current].filter(value => value.startsWith(`${current}:`)).map(value => value.slice(value.indexOf(":") + 1))); }
  }
  const visible = list?.items ?? [];
  return <section className="team-session-browser">
    <header className="team-session-toolbar">
      <label className="team-session-search"><Search size={14}/><input aria-label={l("Search shared sessions and turns", "搜索共享会话与 Turn")} placeholder={mode === "turns" ? l("Search local turns…", "搜索本地 Turn 内容…") : l("Search title or author…", "搜索标题、分享者…")} value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="team-session-mode-tabs" role="group" aria-label={l("Search mode", "搜索类型")}>
        <button type="button" className={mode === "turns" ? "active" : ""} onClick={() => { setMode("turns"); setPage(1); }} aria-pressed={mode === "turns"}>Turn</button>
        <button type="button" className={mode === "sessions" ? "active" : ""} onClick={() => { setMode("sessions"); setPage(1); }} aria-pressed={mode === "sessions"}>{l("Sessions", "会话")}</button>
      </div>
      {mode === "turns" && <button type="button" className={`team-session-tool-toggle ${includeTools ? "active" : ""}`} onClick={() => { setIncludeTools(value => !value); setPage(1); }} aria-pressed={includeTools} aria-label={l("Tool output", "工具输出")}><Wrench size={13}/><span>{l("Tool output", "工具输出")}</span></button>}
      <span className="team-session-count" aria-live="polite">{list ? `${list.items.length} ${l("sessions", "条")}` : ""}</span>
      <button className="team-session-refresh" aria-label={l("Refresh sessions", "刷新会话")} disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15}/></button>
    </header>
    {error && <p role="alert" className="team-workspace-error">{error}</p>}{feedback && <p role="status" className="team-workspace-notice">{feedback}</p>}
    <ResizableSplit className="team-session-split" label={l("Session list width", "会话列表宽度")} storageKey="agentrecall.team-session-list-width" initialWidth={340} minWidth={250} maxWidth={480} minContentWidth={400}>
      <div className="team-session-list-pane">
        <div className="team-session-list" aria-label={l("Shared session list", "共享会话列表")}>
          {loading ? <p className="team-session-placeholder" role="status">{l("Loading…", "正在读取…")}</p> : visible.map(item => {
            const phase = stateFor(item)?.phase, key = itemKey(item);
            return <div className={`session-row team-session-row ${selected && itemKey(selected) === key && selected.match?.turnId === item.match?.turnId ? "selected" : ""}`} key={`${key}:${item.match?.turnId ?? "session"}`}>
              <button className="team-session-select session-main" onClick={() => {
                const cached = cache.peek({ action: "session-open", scope, id: item.id, digest: item.digest });
                const turns = cache.peek({ action: "session-turns", scope, id: item.id, digest: item.digest, record: item.match?.record ?? 0, offset: item.match?.offset ?? 0 });
                setSelected(item); setError("");
                setSnapshot(cached?.ok && cached.data.kind === "session-open" && turns?.ok ? cached.data.value : null);
                setFirstPage(turns?.ok && turns.data.kind === "session-turns" ? turns.data.value : null);
              }} aria-pressed={selected?.id === item.id && selected?.match?.turnId === item.match?.turnId}>
                <span className="session-title"><span className="session-name">{item.title}</span></span>
                <span className="session-meta"><span className="team-session-agent">{agentLabel(item.source ?? stateFor(item)?.source)}</span><span>{item.author}</span><span>{new Date(item.createdAt).toLocaleDateString()}</span></span>
                {item.match && <span className="team-session-match">Turn {item.match.turnIndex + 1} · <HighlightedSearchText text={item.match.snippet} terms={[searchQuery]}/></span>}
                <span className={`team-session-status ${phase ?? "remote"}`}>{active(phase) ? <LoaderCircle size={12} className="team-session-spinner"/> : phase === "ready" ? <Check size={12}/> : null}{phaseLabel(phase)}</span>
              </button>
            </div>;
          })}
          {!loading && !visible.length && <div className="team-session-placeholder"><MessagesSquare size={24}/><p>{query ? l("No matching sessions", "没有匹配的会话") : l("No shared sessions yet", "本地没有共享会话，请先 Pull")}</p></div>}
        </div>
        <footer className="team-session-pagination"><button className="icon-button" aria-label={l("Previous page", "上一页会话")} disabled={loading || page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={15}/></button><span>{page}</span><button className="icon-button" aria-label={l("Next page", "下一页会话")} disabled={loading || !list?.hasMore || page >= 100} onClick={() => setPage(value => value + 1)}><ChevronRight size={15}/></button></footer>
      </div>
      <div className="team-session-detail-pane">
        {selected ? <>
          <header className="detail-header"><div><div className="detail-badges"><span className="source-badge">{agentLabel(selected.source ?? selectedState?.source)}</span><span className="team-session-status">{phaseLabel(selectedState?.phase)}</span></div><h3 className="detail-title-row">{selected.title}</h3><div className="session-meta"><span>{selected.author}</span><span>{new Date(selected.createdAt).toLocaleDateString()}</span></div></div>
            <div className="team-session-detail-actions"><button className="icon-button" aria-label={l("Close reader", "关闭阅读")} onClick={() => setSelected(null)}><X size={16}/></button></div>
          </header>
          <div className="team-session-detail-body">
            {snapshot ? <TeamSessionReader key={`${team.id}:${itemKey(selected)}:${selected.match?.turnId ?? "session"}`} query={searchQuery} snapshot={snapshot} initialPage={firstPage} item={selected} scope={scope} api={api} language={language}/> : <div className="team-session-placeholder">
              {opening || active(selectedState?.phase) ? <LoaderCircle size={26} className="team-session-spinner"/> : <MessagesSquare size={30}/>}
              <h3>{opening ? l("Opening…", "正在打开…") : active(selectedState?.phase) ? phaseLabel(selectedState?.phase) : l("Pull to prepare this session", "请先 Pull 同步这条会话")}</h3>
              <p>{selectedState?.error ?? (active(selectedState?.phase) ? l("You can browse other sessions. This continues in the background.", "可以继续浏览其他会话，任务会在后台继续。") : l("Use Pull above. Searching and reading use only local data.", "点击上方 Pull 完成同步；搜索和阅读仅使用本地数据。"))}</p>

            </div>}
          </div>
          {selected.canWithdraw && <footer className="team-session-reader-footer"><button className="team-subtle-action" disabled={!enabled || pending.includes(itemKey(selected))} onClick={() => void run({action:"session-withdraw",scope,id:selected.id},selected)}>{l("Withdraw share", "撤回分享")}</button></footer>}
        </> : <div className="team-session-placeholder"><MessagesSquare size={32}/><h3>{l("Select a session", "选择一条会话")}</h3><p>{l("Read shared conversations and tool calls here.", "在这里阅读团队共享的对话与工具调用。")}</p></div>}
      </div>
    </ResizableSplit>
  </section>;
}
