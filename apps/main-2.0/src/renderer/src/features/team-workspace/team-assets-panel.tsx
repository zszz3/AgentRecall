import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, PackageSearch, Search, X } from "lucide-react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamCatalog, TeamPayload } from "../../../../shared/ipc/team-workspace";
import type { TeamSelection } from "./team-workspace-page";
import type { LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { markdownPreview, skillMarkdownBody } from "../../markdown-preview";
import { SkillFileTabs } from "../skills/skill-file-tabs";

type Preview = Extract<TeamPayload, { kind: "skill-preview" }>["value"];

function isMarkdownFile(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

/** `onCopied` runs after a team Skill was added to the member's Skill library, so the library view can reload. */
export function TeamAssetsPanel({
  onCopied,
  language,
  selection,
  refreshKey = 0,
  api = window.sessionSearch.teamWorkspace,
}: {
  onCopied?(): void;
  language: LanguageMode;
  selection: TeamSelection;
  refreshKey?: number;
  api?: TeamWorkspaceApi;
}) {
  const l = (en: string, zh: string) => (language === "zh" ? zh : en);
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [exportError, setExportError] = useState("");
  const requestVersion = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const { team, enabled } = selection;
  const scope = { teamId: team.id, repository: team.repository };

  useEffect(() => {
    let active = true;
    requestVersion.current += 1;
    setCatalog(null);
    setPreview(null);
    setSelected(null);
    setError("");
    if (enabled) {
      void api.request({ action: "catalog", scope }).then((reply) => {
        if (!active) return;
        if (!reply.ok) setError(reply.error.message);
        else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
      }).catch(() => {
        if (active) setError(l("Could not read team Skills.", "团队 Skills 读取失败，请刷新重试。"));
      });
    }
    return () => {
      active = false;
      requestVersion.current += 1;
    };
  }, [api, team.id, team.repository, enabled, refreshKey]);

  useEffect(() => {
    if (selected) panel.current?.focus({ preventScroll: true });
    else if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  }, [selected]);

  const allSkills = catalog?.assets?.skills ?? [];
  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allSkills;
    return allSkills.filter((skill) =>
      skill.id.toLowerCase().includes(needle) || (skill.description ?? "").toLowerCase().includes(needle),
    );
  }, [allSkills, query]);

  async function open(id: string, button?: HTMLButtonElement, file?: string) {
    if (button) trigger.current = button;
    const version = ++requestVersion.current;
    setSelected(id);
    setPreview(null);
    setError("");
    try {
      const reply = await api.request({ action: "skill-preview", scope, id, ...(file ? { file } : {}) });
      if (version !== requestVersion.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "skill-preview") setPreview(reply.data.value);
      else setError(l("Could not open this Skill.", "无法打开这个 Skill，请重试。"));
    } catch {
      if (version === requestVersion.current) setError(l("Could not open this Skill.", "无法打开这个 Skill，请重试。"));
    }
  }

  async function exportSkills(ids: string[]) {
    if (exporting || !ids.length) return;
    setExporting(true);
    setExportNotice("");
    setExportError("");
    try {
      const reply = await api.request({ action: "skill-export", scope, ids });
      if (!reply.ok) setExportError(reply.error.message);
      else if (reply.data.kind === "complete") setExportNotice(reply.data.message);
    } catch {
      setExportError(l("Could not export the Skills. Try again.", "Skill 导出失败，请重试。"));
    } finally {
      setExporting(false);
    }
  }

  async function copyToLibrary(id: string) {
    setCopying(true);
    setExportNotice("");
    setExportError("");
    try {
      const reply = await api.request({ action: "skill-copy", scope, id });
      if (!reply.ok) setExportError(reply.error.message);
      else if (reply.data.kind === "complete") {
        setExportNotice(reply.data.message);
        onCopied?.();
      }
    } catch {
      setExportError(l("Could not add the Skill to your library. Try again.", "没能加入 Skill 库，请重试。"));
    } finally {
      setCopying(false);
    }
  }

  function close() {
    requestVersion.current += 1;
    setSelected(null);
    setPreview(null);
    setError("");
  }

  const renderMarkdown = Boolean(preview && preview.encoding === "utf8" && isMarkdownFile(preview.file));
  const renderedMarkdown = preview
    ? markdownPreview(
      preview.file.toLowerCase().endsWith("skill.md") ? skillMarkdownBody(preview.content) : preview.content,
      24_000,
      l("… (truncated)", "…（已截断）"),
    )
    : "";

  return (
    <div
      className={`team-documents-layout${selected ? " has-reader" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && selected) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <section className="team-workspace team-documents-list" aria-label={l("Team Skills", "团队 Skills")}>
        <header className="team-workspace-head">
          <div>
            <h2>Skills <span className="team-count">{allSkills.length}</span></h2>
            <p>{l("Skills shared by your team. Syncing updates them in enabled working directories.", "团队共用的技能，拉取时统一更新到已启用的工作目录。")}</p>
          </div>
          {allSkills.length ? (
            <button type="button" disabled={exporting || selection.busy} onClick={() => void exportSkills(allSkills.map((skill) => skill.id))}>
              <Download size={14} />{exporting ? l("Exporting…", "正在导出…") : l("Export all as ZIP", "全部导出 ZIP")}
            </button>
          ) : null}
        </header>

        {allSkills.length > 0 ? (
          <label className="team-panel-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              aria-label={l("Search team Skills", "搜索团队 Skills")}
              placeholder={l("Filter team Skills…", "筛选团队 Skills…")}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        ) : null}

        {exportNotice ? <p role="status" className="team-workspace-notice">{exportNotice}</p> : null}
        {exportError ? <p role="alert" className="team-workspace-error">{exportError}</p> : null}
        {!selected && error ? <p className="team-workspace-error" role="alert">{error}</p> : null}

        {!enabled ? (
          <p>{l("Enable teams in Settings to browse shared Skills.", "在设置中启用团队后，可浏览共享 Skills。")}</p>
        ) : !catalog && !error ? (
          <p role="status">{l("Loading…", "正在读取…")}</p>
        ) : (
          <>
            {catalog?.notice ? <p className="team-workspace-notice">{catalog.notice}</p> : null}
            {filteredSkills.length > 0 ? (
              <div className="team-resource-list">
                {filteredSkills.map((skill) => (
                  <button
                    type="button"
                    key={skill.id}
                    className="team-resource-row"
                    aria-pressed={selected === skill.id}
                    disabled={selection.busy}
                    onClick={(event) => void open(skill.id, event.currentTarget)}
                  >
                    <PackageSearch size={17} />
                    <span>
                      <strong>{skill.id}</strong>
                      {skill.description ? <small>{skill.description}</small> : null}
                    </span>
                    <span>{l("View", "查看")}</span>
                  </button>
                ))}
              </div>
            ) : allSkills.length > 0 ? (
              <p className="team-import-empty">{l("No matching Skills.", "没有匹配的 Skill。")}</p>
            ) : catalog?.assets ? (
              <div className="team-empty">
                <PackageSearch size={24} />
                <strong>{l("No team Skills yet", "团队还没有共享技能")}</strong>
                <p>{l("Add one from your Skill library above, or Pull published Skills from the team.", "可从上方「从 Skill 库添加」分享，或点击「Pull」获取团队已发布的技能。")}</p>
              </div>
            ) : null}
          </>
        )}
      </section>

      {selected ? (
        <aside ref={panel} tabIndex={-1} className="team-document-reader team-workspace" aria-label={l("Skill details", "Skill 详情")}>
          <header className="team-document-reader-head">
            <div>
              <small>{l("Team Skill", "团队 Skill")}</small>
              <h3>{selected}</h3>
              {preview ? <small>{preview.files.length} {l("files", "个文件")} · {preview.commit.slice(0, 8)}</small> : null}
            </div>
            <div className="team-space-actions">
              <button type="button" className="is-primary" disabled={copying || selection.busy} onClick={() => void copyToLibrary(selected)}>
                <Copy size={14} />{l("Add to Skill library", "加入 Skill 库")}
              </button>
              <button type="button" disabled={exporting || selection.busy} onClick={() => void exportSkills([selected])}>
                <Download size={14} />{l("Export ZIP", "导出 ZIP")}
              </button>
              <button type="button" className="team-icon-button" aria-label={l("Close Skill", "关闭 Skill")} onClick={close}>
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="team-document-reader-body">
            {error ? (
              <p role="alert" className="team-workspace-error">{error}</p>
            ) : !preview ? (
              <p role="status">{l("Opening…", "正在打开…")}</p>
            ) : (
              <>
                {preview.files.length > 1 ? (
                  <SkillFileTabs
                    files={preview.files}
                    activeFile={preview.file}
                    ariaLabel={l("Skill files", "Skill 文件")}
                    language={language}
                    onSelect={(filePath) => void open(selected, undefined, filePath)}
                  />
                ) : null}

                {preview.encoding === "base64" ? (
                  <p className="team-workspace-notice">{l("Binary file shown as Base64.", "二进制文件，以 Base64 显示。")}</p>
                ) : null}

                {renderMarkdown ? (
                  <div className="team-reader-markdown">
                    <Markdown text={renderedMarkdown} language={language} />
                  </div>
                ) : (
                  <pre className="team-code-block">{preview.content}</pre>
                )}
              </>
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
