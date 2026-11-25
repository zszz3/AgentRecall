import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, FileCode2, KeyRound, Pencil, Plug, Plus, Search, Upload, X } from "lucide-react";
import { MenuButton } from "../../ui/menu";
import type { ConfigurationChange } from "@agentrecall/workspace-core";
import { TeamConfigurationEditor } from "./team-configuration-editor";
import type { TeamCatalog } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import type { TeamSelection } from "./team-workspace-page";

type TeamMcpServer = Extract<ConfigurationChange, { kind: "mcp" }>["value"];

type Resource = {
  key: string;
  name: string;
  summary: string;
  content: string;
  targets: string[];
  change: ConfigurationChange;
  mcp?: TeamMcpServer;
};

/** Copies one team item into the member's own resources; resolves to the message shown afterwards and rejects with a readable reason. */
export interface TeamResourceCopy {
  label: string;
  run(change: ConfigurationChange, team: { id: string; name: string }): Promise<string>;
}

/**
 * Personal items a page offers to the team. Choosing one opens the editor prefilled as a new team item,
 * so nothing reaches the team before the member saves it to the local copy and pushes it. A choice
 * without `change` is listed disabled with `problem` as the reason.
 */
export interface TeamResourceShare {
  label: string;
  choices: Array<{ key: string; label: string; hint?: string; change?: ConfigurationChange; problem?: string }>;
}

export function TeamConfigurationPanel({
  kind,
  selection,
  language,
  refreshKey,
  api,
  onBusy,
  onStage,
  copy,
  share,
}: {
  kind: "instructions" | "mcp";
  selection: TeamSelection;
  language: LanguageMode;
  refreshKey: number;
  api: TeamWorkspaceApi;
  onBusy(value: boolean): void;
  onStage?(change: ConfigurationChange): Promise<void>;
  copy?: TeamResourceCopy;
  share?: TeamResourceShare;
}) {
  const l = (en: string, zh: string) => (language === "zh" ? zh : en);
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [error, setError] = useState("");
  const [reader, setReader] = useState<Resource | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [query, setQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const [editor, setEditor] = useState<ConfigurationChange | null | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState("");
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const { team, enabled } = selection;

  useEffect(() => {
    let active = true;
    setCatalog(null);
    setReader(null);
    setRawMode(false);
    setError("");
    if (enabled) {
      void api.request({ action: "catalog", scope: { teamId: team.id, repository: team.repository } }).then((reply) => {
        if (!active) return;
        if (!reply.ok) setError(reply.error.message);
        else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
        else setError(l("Could not load resources.", "资源读取失败，请重试。"));
      }).catch(() => {
        if (active) setError(l("Could not load resources.", "资源读取失败，请重试。"));
      });
    }
    return () => { active = false; };
  }, [api, team.id, team.repository, enabled, refreshKey, retry, kind]);

  useEffect(() => {
    if (reader) panel.current?.focus({ preventScroll: true });
    else if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  }, [reader]);

  const configuration = catalog?.assets?.configuration;
  const section = kind === "instructions"
    ? {
      title: l("Shared instructions", "共享指令"),
      emptyTitle: l("No shared instructions yet", "还没有共享指令"),
      description: l("Team rules merged into AGENTS.md and CLAUDE.md on Pull.", "团队编码规范与约定，拉取时自动合入项目的 AGENTS.md / CLAUDE.md。"),
      Icon: FileCode2,
      items: (configuration?.instructions ?? []).map((item): Resource => ({
        key: "instruction:" + item.id,
        name: item.name,
        targets: item.targets,
        summary: item.targets.map((target) => (target === "codex" ? "AGENTS.md" : "CLAUDE.md")).join(" · "),
        content: item.content,
        change: { kind: "instructions", operation: "update", value: { id: item.id, name: item.name, content: item.content, targets: item.targets } },
      })),
    }
    : {
      title: "MCP",
      emptyTitle: l("No shared MCP servers yet", "还没有团队 MCP 服务"),
      description: l("Shared tool connections. Credentials stay on each member's machine.", "共用的 MCP 工具连接，密钥由每位成员通过本机环境变量提供。"),
      Icon: Plug,
      items: (configuration?.mcpServers ?? []).map((item): Resource => ({
        key: "mcp:" + item.id,
        name: item.name,
        targets: item.targets,
        summary: item.transport === "stdio" ? `${item.command}${item.args?.length ? ` ${item.args.join(" ")}` : ""}` : item.url,
        content: JSON.stringify(item, null, 2),
        change: { kind: "mcp", operation: "update", value: item },
        mcp: item,
      })),
    };

  const { title, emptyTitle, description, Icon, items } = section;
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      item.name.toLowerCase().includes(needle) || item.summary.toLowerCase().includes(needle),
    );
  }, [items, query]);

  const detailsLabel = l(`${title} details`, `${title}详情`);

  async function copyItem(item: Resource, action: TeamResourceCopy) {
    setCopying(true);
    setNotice("");
    setCopyError("");
    try {
      setNotice(await action.run(item.change, { id: team.id, name: team.name }));
    } catch (cause) {
      setCopyError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCopying(false);
    }
  }

  return (
    <div
      className={`team-documents-layout${reader ? " has-reader" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && reader) {
          event.stopPropagation();
          setReader(null);
        }
      }}
    >
      <section className="team-workspace team-documents-list" aria-label={title}>
        <header className="team-workspace-head">
          <div>
            <h2>{title} {catalog?.assets ? <span className="team-count">{items.length}</span> : null}</h2>
            <p>{description}</p>
          </div>
          <div className="team-space-actions">
            {share ? (
              <MenuButton
                label={share.label}
                text={share.label}
                icon={<Upload size={14} />}
                disabled={!enabled || selection.busy || !catalog?.assets || !share.choices.length}
                items={share.choices.map((choice) => ({
                  key: choice.key,
                  label: choice.label,
                  hint: choice.problem ?? choice.hint,
                  disabled: !choice.change,
                  onSelect: () => { if (choice.change) setEditor(choice.change); },
                }))}
              />
            ) : null}
            <button
              type="button"
              className="is-primary"
              disabled={!enabled || selection.busy || !catalog?.assets}
              title={!catalog?.assets ? l("Pull first", "请先 Pull 拉取") : undefined}
              onClick={() => setEditor(null)}
            >
              <Plus size={14} />{l("Add ", "新增 ")}{title}
            </button>
          </div>
        </header>

        {items.length > 0 ? (
          <label className="team-panel-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              aria-label={l(`Search ${title}`, `搜索${title}`)}
              placeholder={l(`Filter ${title}…`, `筛选${title}…`)}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        ) : null}

        {notice ? <p role="status" className="team-workspace-notice">{notice}</p> : null}
        {copyError ? <p role="alert" className="team-workspace-error">{copyError}</p> : null}

        {!enabled ? (
          <p>{l("Enable teams in Settings to view shared resources.", "在设置中启用团队后，可查看共享资源。")}</p>
        ) : error ? (
          <div role="alert" className="team-workspace-error">
            {error}
            <button type="button" onClick={() => setRetry((value) => value + 1)}>{l("Retry", "重试")}</button>
          </div>
        ) : !catalog ? (
          <p role="status">{l("Loading…", "正在读取…")}</p>
        ) : (
          <>
            {catalog.notice ? <p className="team-workspace-notice">{catalog.notice}</p> : null}
            {filteredItems.length > 0 ? (
              <div className="team-resource-list">
                {filteredItems.map((item) => (
                  <button
                    type="button"
                    className="team-resource-row"
                    key={item.key}
                    aria-pressed={reader?.key === item.key}
                    onClick={(event) => {
                      trigger.current = event.currentTarget;
                      setRawMode(false);
                      setReader(item);
                    }}
                  >
                    <Icon size={17} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.summary}</small>
                    </span>
                    <span>{l("View", "查看")}</span>
                  </button>
                ))}
              </div>
            ) : items.length > 0 ? (
              <p className="team-import-empty">{l("No matching items.", "没有匹配的条目。")}</p>
            ) : catalog.assets ? (
              <div className="team-empty">
                <Icon size={24} />
                <strong>{emptyTitle}</strong>
                <p>{l("Add a local resource, or Pull published resources.", "可以新增条目，或点击上方「Pull」获取团队已发布的内容。")}</p>
              </div>
            ) : null}
            {items.length > 0 ? (
              <p className="team-footnote">
                {kind === "mcp"
                  ? l("Updated with Pull. Clients may require trust or MCP approval.", "随「Pull」统一更新到已启用的工作目录，客户端可能需要确认信任。")
                  : l("Updated in enabled working directories with Pull.", "随「Pull」统一更新到已启用的工作目录。")}
              </p>
            ) : null}
          </>
        )}
      </section>

      {reader ? (
        <aside ref={panel} tabIndex={-1} className="team-document-reader team-workspace" aria-label={detailsLabel}>
          <header className="team-document-reader-head">
            <div>
              <small>{reader.targets.map((target) => (target === "codex" ? "Codex / .agents" : "Claude Code")).join(" · ")}</small>
              <h3>{reader.name}</h3>
            </div>
            <div className="team-space-actions">
              <button type="button" onClick={() => setRawMode((value) => !value)}>
                {rawMode ? l("Formatted", "视图") : kind === "mcp" ? "JSON" : l("Raw", "源码")}
              </button>
              {copy ? (
                <button type="button" className="is-primary" disabled={copying} onClick={() => void copyItem(reader, copy)}>
                  <Copy size={14} />{copy.label}
                </button>
              ) : null}
              <button type="button" disabled={selection.busy} onClick={() => setEditor(reader.change)}>
                <Pencil size={14} />{l("Edit", "编辑")}
              </button>
              <button type="button" className="team-icon-button" aria-label={l("Close details", "关闭详情")} onClick={() => setReader(null)}>
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="team-document-reader-body">
            {rawMode ? (
              <pre className="team-code-block">{reader.content}</pre>
            ) : reader.mcp ? (
              <McpDetailCard server={reader.mcp} language={language} />
            ) : (
              <div className="team-reader-markdown">
                <Markdown text={reader.content} language={language} />
              </div>
            )}
          </div>
        </aside>
      ) : null}

      {editor !== undefined && catalog?.assets ? (
        <TeamConfigurationEditor
          kind={kind}
          initial={editor}
          onStage={onStage ? async (change) => { await onStage(change); setEditor(undefined); } : undefined}
          selection={selection}
          revision={catalog.assets.commit}
          language={language}
          api={api}
          onBusy={onBusy}
          onClose={() => setEditor(undefined)}
          onPublished={(result) => {
            setEditor(undefined);
            setReader(null);
            setRetry((value) => value + 1);
            setNotice(result.cleanupRequired
              ? l("Published. Temporary files need cleanup; sync to check the resource before trying again.", "资源已发布，但临时文件需要清理。请先同步查看，不要重复发布。")
              : result.cacheUpdated
                ? l("Published to the team. Pull to update working directories.", "已发布到团队。点击「Pull」更新工作目录。")
                : l("Published, but the local cache could not be refreshed. Pull to load the resource.", "已发布，但本地缓存未刷新。请点击「Pull」获取资源。"));
          }}
        />
      ) : null}
    </div>
  );
}

function McpDetailCard({ server, language }: { server: TeamMcpServer; language: LanguageMode }) {
  const l = (en: string, zh: string) => (language === "zh" ? zh : en);
  const envEntries = server.transport === "stdio" ? Object.entries(server.env ?? {}) : [];
  const headerEntries = server.transport === "http" ? Object.entries(server.headers ?? {}) : [];

  return (
    <div className="team-mcp-card">
      <dl className="team-mcp-facts">
        <div>
          <dt>{l("ID", "标识")}</dt>
          <dd><code>{server.id}</code></dd>
        </div>
        <div>
          <dt>{l("Transport", "传输方式")}</dt>
          <dd><span className="team-mcp-badge">{server.transport === "http" ? "HTTP" : "Stdio"}</span></dd>
        </div>
        <div>
          <dt>{l("Targets", "生效客户端")}</dt>
          <dd>{server.targets.map((target) => (target === "codex" ? "Codex / .agents" : "Claude Code")).join(" · ")}</dd>
        </div>
      </dl>

      <div className="team-mcp-endpoint">
        <h4>{server.transport === "http" ? l("Endpoint URL", "服务地址") : l("Command", "启动命令")}</h4>
        <pre className="team-code-block">
          {server.transport === "http"
            ? server.url
            : [server.command, ...(server.args ?? [])].join(" ")}
        </pre>
      </div>

      {headerEntries.length > 0 ? (
        <div className="team-mcp-vars">
          <h4>{l("HTTP Headers", "请求头")}</h4>
          <ul>
            {headerEntries.map(([name, value]) => (
              <li key={name}>
                <code>{name}</code>
                <span>
                  {typeof value === "string" ? (
                    <code>{value}</code>
                  ) : (
                    <span className="team-mcp-env-ref">
                      <KeyRound size={12} aria-hidden="true" />
                      {l("Local env", "本机变量")} <code>${value.fromEnv}</code>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {envEntries.length > 0 ? (
        <div className="team-mcp-vars">
          <h4>{l("Environment variables", "环境变量")}</h4>
          <ul>
            {envEntries.map(([name, value]) => (
              <li key={name}>
                <code>{name}</code>
                <span>
                  {typeof value === "string" ? (
                    <code>{value}</code>
                  ) : (
                    <span className="team-mcp-env-ref">
                      <KeyRound size={12} aria-hidden="true" />
                      {l("Local env", "本机变量")} <code>${value.fromEnv}</code>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
