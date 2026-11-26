import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search, X } from "lucide-react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamCatalog, TeamPayload } from "../../../../shared/ipc/team-workspace";
import type { LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import type { TeamSelection } from "./team-workspace-page";

type Preview = Extract<TeamPayload, { kind: "document-preview" }>["value"];
type Reader = { id: string; name: string; path: string; loading: boolean; error: string; preview?: Preview };

function isMarkdownDoc(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

export function TeamDocumentsPanel({
  selection,
  language,
  refreshKey = 0,
  api = window.sessionSearch.teamWorkspace,
}: {
  selection: TeamSelection;
  language: LanguageMode;
  refreshKey?: number;
  api?: TeamWorkspaceApi;
}) {
  const l = (en: string, zh: string) => (language === "zh" ? zh : en);
  const { team, enabled } = selection;
  const scope = { teamId: team.id, repository: team.repository };
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [reader, setReader] = useState<Reader | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const readVersion = useRef(0);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const readerPanel = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    readVersion.current += 1;
    setCatalog(null);
    setReader(null);
    setError("");
    if (enabled) {
      void api.request({ action: "catalog", scope }).then((reply) => {
        if (!active) return;
        if (!reply.ok) setError(reply.error.message);
        else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
      }).catch(() => {
        if (active) setError(l("Could not load documents.", "文档读取失败，请刷新重试。"));
      });
    }
    return () => {
      active = false;
      readVersion.current += 1;
    };
  }, [api, team.id, team.repository, enabled, refreshKey]);

  useEffect(() => {
    if (reader?.id) readerPanel.current?.focus({ preventScroll: true });
    else if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
  }, [reader?.id]);

  const allDocs = catalog?.assets?.documents ?? [];
  const filteredDocs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allDocs;
    return allDocs.filter((doc) =>
      doc.name.toLowerCase().includes(needle) || doc.target.toLowerCase().includes(needle),
    );
  }, [allDocs, query]);

  function closeReader() {
    readVersion.current += 1;
    setReader(null);
    setRawMode(false);
  }

  async function openDocument(item: { id: string; name: string; path: string }, trigger?: HTMLButtonElement) {
    if (trigger) returnFocus.current = trigger;
    const version = ++readVersion.current;
    setRawMode(false);
    setReader({ ...item, loading: true, error: "" });
    try {
      const reply = await api.request({ action: "document-preview", scope, id: item.id });
      if (version !== readVersion.current) return;
      if (!reply.ok) setReader({ ...item, loading: false, error: reply.error.message });
      else if (reply.data.kind === "document-preview") setReader({ ...item, loading: false, error: "", preview: reply.data.value });
      else setReader({ ...item, loading: false, error: l("Could not open the document.", "无法打开文档，请重试。") });
    } catch {
      if (version === readVersion.current) setReader({ ...item, loading: false, error: l("Could not open the document.", "无法打开文档，请重试。") });
    }
  }

  const showMarkdown = Boolean(reader?.preview && isMarkdownDoc(reader.path) && !rawMode);

  return (
    <div
      className={`team-documents-layout${reader ? " has-reader" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && reader) {
          event.stopPropagation();
          closeReader();
        }
      }}
    >
      <section className="team-workspace team-documents-list" aria-label={l("Document list", "文档列表")}>
        <header className="team-workspace-head">
          <div>
            <h2>{l("Documents", "文档")} <span className="team-count">{allDocs.length}</span></h2>
            <p>{l("Shared team playbooks and reference guides, updated together on Pull.", "团队共用的规范文档与参考指南，随团队拉取统一更新。")}</p>
          </div>
        </header>

        {allDocs.length > 0 ? (
          <label className="team-panel-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              aria-label={l("Search documents", "搜索文档")}
              placeholder={l("Filter documents…", "筛选文档…")}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        ) : null}

        {error ? <p className="team-workspace-error" role="alert">{error}</p> : null}

        {!enabled ? (
          <p>{l("Enable teams in Settings to view shared documents.", "在设置中启用团队后，可查看共享文档。")}</p>
        ) : !catalog && !error ? (
          <p role="status">{l("Loading…", "正在读取…")}</p>
        ) : (
          <>
            {catalog?.notice ? <p className="team-workspace-notice">{catalog.notice}</p> : null}
            {filteredDocs.length > 0 ? (
              <div className="team-resource-list">
                {filteredDocs.map((document) => (
                  <button
                    type="button"
                    className="team-resource-row"
                    key={document.id}
                    aria-pressed={reader?.id === document.id}
                    disabled={selection.busy}
                    onClick={(event) => void openDocument({ id: document.id, name: document.name, path: document.target }, event.currentTarget)}
                  >
                    <FileText size={17} />
                    <span>
                      <strong>{document.name}</strong>
                      <small>{document.target}</small>
                    </span>
                    <span>{l("View", "查看")}</span>
                  </button>
                ))}
              </div>
            ) : allDocs.length > 0 ? (
              <p className="team-import-empty">{l("No matching documents.", "没有匹配的文档。")}</p>
            ) : catalog?.assets ? (
              <div className="team-empty">
                <FileText size={24} />
                <strong>{l("No shared documents yet", "团队还没有共享文档")}</strong>
                <p>{l("Add documents from a connected working directory, or Pull published documents.", "可从上方「添加资源」引入项目文档，或点击「Pull」获取已发布的文档。")}</p>
              </div>
            ) : null}
          </>
        )}
      </section>

      {reader ? (
        <aside key={reader.id} ref={readerPanel} tabIndex={-1} className="team-document-reader team-workspace" aria-label={l("Document details", "文档详情")}>
          <header className="team-document-reader-head">
            <div>
              <small>{l("Team document", "团队文档")}</small>
              <h3>{reader.name}</h3>
              <small>{reader.path}{reader.preview ? ` · ${reader.preview.commit.slice(0, 8)}` : ""}</small>
            </div>
            <div className="team-space-actions">
              {reader.preview && isMarkdownDoc(reader.path) ? (
                <button type="button" onClick={() => setRawMode((value) => !value)}>
                  {rawMode ? l("Preview", "预览") : l("Raw", "源码")}
                </button>
              ) : null}
              <button type="button" className="team-icon-button" aria-label={l("Close document", "关闭文档")} title={l("Close · Esc", "关闭 · Esc")} onClick={closeReader}>
                <X size={16} />
              </button>
            </div>
          </header>
          <div className="team-document-reader-body">
            {reader.loading ? <p role="status">{l("Opening…", "正在打开文档…")}</p> : null}
            {reader.error ? (
              <div className="team-workspace-error" role="alert">
                <p>{reader.error}</p>
                <button type="button" onClick={() => void openDocument(reader)}>{l("Retry", "重试")}</button>
              </div>
            ) : null}
            {reader.preview ? (
              showMarkdown ? (
                <div className="team-reader-markdown">
                  <Markdown text={reader.preview.content} language={language} />
                </div>
              ) : (
                <pre className="team-code-block">{reader.preview.content}</pre>
              )
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
