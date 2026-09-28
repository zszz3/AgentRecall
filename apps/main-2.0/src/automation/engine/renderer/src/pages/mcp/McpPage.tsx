import { useCallback, useEffect, useState } from "react";
import { Eye, FileJson, Link2, PlugZap, Power, Save, Server, Trash2, Wifi } from "lucide-react";
import type { Language } from "../../app/language";
import { APP_SAVE_REQUEST_EVENT } from "../../app/save-shortcut";
import {
  BrowserHeader,
  BrowserItem,
  DetailToolbar,
  InlineStatus,
  WorkbenchEmpty,
  WorkbenchLayout,
  WorkbenchSection,
} from "../../ui/workbench/Workbench";
import { useMcpRegistry } from "./useMcpRegistry";
import { McpClientConnectionsDialog } from "./McpClientConnectionsDialog";
import { McpToolPreview } from "./McpToolPreview";
import { McpJsonImport } from "./McpJsonImport";
import { McpJsonEdit } from "./McpJsonEdit";
import { McpReferenceEditor } from "./McpReferenceEditor";
import { toolCountLabel } from "./mcp-tools";
import type { McpServerDefinition, McpToolDefinition } from "../../../../shared/mcp/types";

function serverDisplayName(server: McpServerDefinition, zh: boolean): string {
  if (server.id === "agent-recall-session-search") {
    return zh ? "AgentRecall 会话检索" : "AgentRecall Session Search";
  }
  if (server.id === "agent-recall-skills") return zh ? "AgentRecall Skill 库" : "AgentRecall Skills";
  if (server.id === "agent-recall-workflow") return "AgentRecall Workflow";
  return server.name;
}

function serverDescription(server: McpServerDefinition, zh: boolean): string | undefined {
  if (!zh) return server.description;
  if (server.id === "agent-recall-session-search") {
    return "检索已索引的 Agent 会话、查看上下文，并准备可恢复的迁移。";
  }
  if (server.id === "agent-recall-skills") {
    return "列出 AgentRecall 已管理的 Skill，并按需读取完整说明。";
  }
  if (server.id === "agent-recall-workflow") {
    return "创建、查看并运行结构化的 AgentRecall Workflow。";
  }
  return server.description;
}

export function McpPage({ language = "en" }: { language?: Language }) {
  const zh = language === "zh";
  const model = useMcpRegistry();
  const [previewTool, setPreviewTool] = useState<McpToolDefinition>();
  const [importOpen, setImportOpen] = useState(false);
  const [jsonEditOpen, setJsonEditOpen] = useState(false);
  const [clientsOpen, setClientsOpen] = useState(false);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!model.dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [model.dirty]);
  useEffect(() => {
    const save = () => {
      if (model.dirty && model.draft) void model.save();
    };
    window.addEventListener(APP_SAVE_REQUEST_EVENT, save);
    return () => window.removeEventListener(APP_SAVE_REQUEST_EVENT, save);
  }, [model.dirty, model.draft, model.save]);
  const builtins = model.servers.filter((server) => server.managed);
  const customServers = model.servers.filter((server) => !server.managed);
  const select = useCallback(
    (id: string) => {
      if (
        model.dirty &&
        !window.confirm(
          zh
            ? "当前 MCP 修改尚未保存，确定切换吗？"
            : "Unsaved MCP changes will be lost. Continue?",
        )
      )
        return;
      model.setDirty(false);
      model.select(id);
    },
    [model, zh],
  );
  const draft = model.draft;
  const renderServerRow = (server: McpServerDefinition, title: string) => (
    <div
      key={server.id}
      className={`mcp-registry-row ${server.enabled ? "" : "is-disabled"}`}
    >
      <BrowserItem
        selected={server.id === draft?.id}
        title={title}
        meta={`${server.transport.toUpperCase()} · ${toolCountLabel(server, zh ? "工具" : "tools")}`}
        status={
          server.status === "connected"
            ? "success"
            : server.status === "error"
              ? "danger"
              : "muted"
        }
        onClick={() => select(server.id)}
      />
      <span
        className="mcp-binding-switch mcp-registry-row-switch"
        title={
          zh
            ? server.enabled
              ? "关闭后，该工具源将退出 AgentRecall Gateway 索引（配置保留）。"
              : "开启后，该工具源将加入 AgentRecall Gateway 索引。"
            : server.enabled
              ? "When off, this source leaves the AgentRecall Gateway index (its config is kept)."
              : "When on, this source joins the AgentRecall Gateway index."
        }
      >
        <input
          type="checkbox"
          aria-label={zh ? `启用 ${title}` : `Enable ${title}`}
          checked={server.enabled}
          disabled={Boolean(model.busy)}
          onChange={() => void model.toggleServerEnabled(server.id)}
        />
        <i aria-hidden="true" />
      </span>
    </div>
  );
  return (
    <section className="mcp-workbench">
      <header className="app-page-head automation-page-head">
        <div><h2>MCP</h2><p>{zh
            ? "一个 Gateway 连接 Codex 与 Claude Code，并渐进式开放 AgentRecall 的全部工具。"
            : "One Gateway connects Codex and Claude Code and progressively exposes AgentRecall tools."
        }</p></div>
          <button className="control-btn compact secondary" type="button" onClick={() => setClientsOpen(true)}>
            <Link2 size={13} />
            {zh ? "连接客户端" : "Connect clients"}
          </button>
      </header>
      <div className="mcp-gateway-overview">
        <div>
          <span>{zh ? "直接工具" : "Direct tools"}</span>
          <strong>list_skills · get_skill · search_sessions · get_session</strong>
        </div>
        <div>
          <span>{zh ? "渐进式索引" : "Progressive index"}</span>
          <strong>search_tools → get_tool → call_tool</strong>
        </div>
      </div>
      {model.error ? (
        <div className="workbench-error" role="alert">
          {model.error}
        </div>
      ) : null}
      <div className="mcp-workbench-body">
        <WorkbenchLayout
          browserResize={{ storageKey: "agent-recall-mcp-pane", label: zh ? "调整 MCP 列表宽度" : "Resize MCP list" }}
          browser={
            <>
              <BrowserHeader
                label={zh ? "工具源" : "Tool sources"}
                actionLabel={zh ? "新建 MCP Server" : "New MCP server"}
                onAdd={model.create}
                extra={
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={zh ? "从 JSON 导入" : "Import from JSON"}
                    title={zh ? "从 JSON 导入" : "Import from JSON"}
                    onClick={() => setImportOpen(true)}
                  >
                    <FileJson size={14} />
                  </button>
                }
              />
              <div className="workbench-browser-list">
                <section className="mcp-browser-group">
                  <header>
                    <span>{zh ? "AgentRecall 内置" : "AgentRecall built-ins"}</span>
                    <small>{builtins.length}</small>
                  </header>
                  {builtins.map((server) => renderServerRow(server, serverDisplayName(server, zh)))}
                </section>
                <section className="mcp-browser-group">
                  <header>
                    <span>{zh ? "自定义" : "Custom"}</span>
                    <small>{customServers.length}</small>
                  </header>
                  {customServers.length ? customServers.map((server) => renderServerRow(server, server.name)) : (
                    <p className="mcp-browser-group-empty">
                      {zh ? "还没有自定义 MCP" : "No custom MCP servers"}
                    </p>
                  )}
                </section>
              </div>
            </>
          }
        >
          {draft ? (
            <>
              <DetailToolbar
                title={serverDisplayName(draft, zh)}
                meta={`${draft.managed ? (zh ? "AgentRecall 内置" : "AgentRecall built-in") : (zh ? "自定义" : "Custom")} · ${draft.transport.toUpperCase()}`}
                actions={
                  <>
                    <InlineStatus
                      tone={
                        model.busy === "test"
                          ? "busy"
                          : draft.status === "connected"
                            ? "success"
                            : draft.status === "error"
                              ? "danger"
                              : "muted"
                      }
                    >
                      {model.busy === "test"
                        ? zh
                          ? "连接中"
                          : "Connecting"
                        : draft.status === "connected"
                          ? zh
                            ? "已连接"
                            : "Connected"
                          : draft.status === "error"
                            ? zh
                              ? "连接失败"
                              : "Connection failed"
                            : zh
                              ? "未测试"
                              : "Not tested"}
                    </InlineStatus>
                    {draft.managed ? (
                      <button
                        className="control-btn compact secondary"
                        type="button"
                        disabled={Boolean(model.busy)}
                        onClick={() => void model.toggleEnabled()}
                      >
                        <Power size={13} />
                        {draft.enabled ? (zh ? "禁用" : "Disable") : (zh ? "启用" : "Enable")}
                      </button>
                    ) : (
                      <>
                      <button
                        className="control-btn compact secondary"
                        type="button"
                        disabled={Boolean(model.busy)}
                        onClick={() => setJsonEditOpen(true)}
                      >
                        <FileJson size={13} />
                        JSON
                      </button>
                      <button
                        className="control-btn compact danger"
                        type="button"
                        disabled={Boolean(model.busy)}
                        onClick={() => {
                          if (
                            window.confirm(
                              zh
                                ? `删除 ${draft.name}？`
                                : `Delete ${draft.name}?`,
                            )
                          )
                            void model.remove();
                        }}
                      >
                        <Trash2 size={13} />
                        {zh ? "删除" : "Delete"}
                      </button>
                      </>
                    )}
                    <button
                      className="control-btn compact secondary"
                      type="button"
                      disabled={Boolean(model.busy)}
                      onClick={() => void model.test()}
                    >
                      <Wifi size={13} />
                      {model.busy === "test"
                        ? zh
                          ? "测试中"
                          : "Testing"
                        : zh
                          ? "测试连接"
                          : "Test"}
                    </button>
                    <button
                      className="control-btn compact is-active"
                      type="button"
                      disabled={Boolean(model.busy)}
                      onClick={() => void model.save()}
                    >
                      <Save size={13} />
                      {model.busy === "save"
                        ? zh
                          ? "保存中"
                          : "Saving"
                        : zh
                          ? "保存"
                          : "Save"}
                    </button>
                  </>
                }
              />
              <div className="workbench-scroll">
                <WorkbenchSection
                  title={zh ? "连接配置" : "Connection"}
                  description={
                    zh
                      ? "选择传输方式并配置启动命令或远程地址。"
                      : "Choose a transport and configure a command or remote endpoint."
                  }
                >
                  {draft.managed ? (
                    <p className="workbench-form-note">
                      <strong>{serverDescription(draft, zh)}</strong>
                      <span>
                        {zh
                          ? "启动配置由 App 统一管理，此处只读。"
                          : "Its launch configuration is managed by the app and is read-only here."}
                      </span>
                    </p>
                  ) : null}
                  <div className="workbench-form-grid">
                    <label>
                      <span>{zh ? "名称" : "Name"}</span>
                      <input
                        value={serverDisplayName(draft, zh)}
                        disabled={draft.managed}
                        onChange={(event) =>
                          model.update({ ...draft, name: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>{zh ? "传输方式" : "Transport"}</span>
                      <span className="workbench-segmented">
                        <button
                          type="button"
                          className={
                            draft.transport === "stdio" ? "is-active" : ""
                          }
                          disabled={draft.managed}
                          onClick={() =>
                            model.update({ ...draft, transport: "stdio" })
                          }
                        >
                          STDIO
                        </button>
                        <button
                          type="button"
                          className={
                            draft.transport === "http" ? "is-active" : ""
                          }
                          disabled={draft.managed}
                          onClick={() =>
                            model.update({ ...draft, transport: "http" })
                          }
                        >
                          HTTP
                        </button>
                      </span>
                    </label>
                    {draft.transport === "stdio" ? (
                      <>
                        <label>
                          <span>{zh ? "启动命令" : "Command"}</span>
                          <input
                            placeholder="npx"
                            value={draft.command ?? ""}
                            disabled={draft.managed}
                            onChange={(event) =>
                              model.update({
                                ...draft,
                                command: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          <span>{zh ? "参数" : "Arguments"}</span>
                          <input
                            placeholder="-y @modelcontextprotocol/server-filesystem"
                            value={draft.args.join(" ")}
                            disabled={draft.managed}
                            onChange={(event) =>
                              model.update({
                                ...draft,
                                args: event.target.value
                                  .split(/\s+/)
                                  .filter(Boolean),
                              })
                            }
                          />
                        </label>
                      </>
                    ) : (
                      <label className="is-wide">
                        <span>URL</span>
                        <input
                          placeholder="http://127.0.0.1:3000/mcp"
                          value={draft.url ?? ""}
                          disabled={draft.managed}
                          onChange={(event) =>
                            model.update({ ...draft, url: event.target.value })
                          }
                        />
                      </label>
                    )}
                  </div>
                  {draft.lastError ? (
                    <div className="mcp-inline-error">
                      <PlugZap size={14} />
                      <span>{draft.lastError}</span>
                    </div>
                  ) : null}
                </WorkbenchSection>
                {draft.managed ? null : (
                  <McpReferenceEditor
                    key={draft.id}
                    language={language}
                    isHttp={draft.transport === "http"}
                    references={draft.transport === "http" ? (draft.headers ?? {}) : draft.env}
                    onChange={(next) =>
                      model.update(
                        draft.transport === "http"
                          ? { ...draft, headers: next }
                          : { ...draft, env: next },
                      )
                    }
                  />
                )}
                <WorkbenchSection
                  title={zh ? "已发现工具" : "Discovered tools"}
                  description={
                    draft.tools.length
                      ? zh
                        ? `保存连接配置或手动测试后自动刷新工具清单。已启用 ${draft.tools.length - (draft.disabledTools?.length ?? 0)} / ${draft.tools.length} 个工具。`
                        : `The tool catalog refreshes after saving connection changes or testing manually. ${draft.tools.length - (draft.disabledTools?.length ?? 0)} of ${draft.tools.length} tools enabled.`
                      : zh
                        ? "保存连接配置或手动测试后自动刷新工具清单。"
                        : "The tool catalog refreshes after saving connection changes or testing manually."
                  }
                >
                  {draft.tools.length ? (
                    <div className="workbench-table-wrap">
                      <table className="workbench-table mcp-tool-table">
                        <thead>
                          <tr>
                            <th>{zh ? "启用" : "Enabled"}</th>
                            <th>{zh ? "工具" : "Tool"}</th>
                            <th>{zh ? "开放方式" : "Exposure"}</th>
                            <th>{zh ? "描述" : "Description"}</th>
                            <th aria-label={zh ? "操作" : "Actions"} />
                          </tr>
                        </thead>
                        <tbody>
                          {draft.tools.map((tool) => {
                            const toolDisabled = (draft.disabledTools ?? []).includes(tool.name);
                            return (
                              <tr key={tool.name} className={toolDisabled ? "is-disabled" : ""}>
                                <td>
                                  <span className="mcp-binding-switch">
                                    <input
                                      type="checkbox"
                                      aria-label={`${zh ? "启用" : "Enable"} ${tool.name}`}
                                      checked={!toolDisabled}
                                      onChange={() => model.toggleTool(tool.name)}
                                    />
                                    <i aria-hidden="true" />
                                  </span>
                                </td>
                                <td className="mono">
                                  <strong>{tool.name}</strong>
                                </td>
                                <td>
                                  <span className={`mcp-exposure-badge ${isDirectTool(draft.id, tool.name) ? "is-direct" : ""}`}>
                                    {isDirectTool(draft.id, tool.name)
                                      ? (zh ? "直接工具" : "Direct")
                                      : (zh ? "索引调用" : "Indexed")}
                                  </span>
                                </td>
                                <td>
                                  {tool.description ||
                                    (zh ? "无描述" : "No description")}
                                </td>
                                <td className="mcp-tool-actions">
                                  <button
                                    type="button"
                                    className="icon-btn"
                                    aria-label={`${zh ? "预览" : "Preview"} ${tool.name}`}
                                    title={zh ? "预览" : "Preview"}
                                    onClick={() => setPreviewTool(tool)}
                                  >
                                    <Eye size={13} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <WorkbenchEmpty
                      icon={<PlugZap size={20} />}
                      title={zh ? "还没有发现工具" : "No tools discovered"}
                      description={
                        zh
                          ? "保存连接配置即可自动发现工具，也可以手动测试。"
                          : "Save the connection to discover tools automatically, or test it manually."
                      }
                    />
                  )}
                </WorkbenchSection>
              </div>
            </>
          ) : (
            <WorkbenchEmpty
              icon={<Server size={22} />}
              title={zh ? "还没有 MCP Server" : "No MCP servers"}
              description={
                zh
                  ? "添加本地命令或远程 HTTP Server，让工具进入 AgentRecall Gateway 索引。"
                  : "Add a local command or remote HTTP server to the AgentRecall Gateway index."
              }
              actionLabel={zh ? "新建 Server" : "New server"}
              onAction={model.create}
            />
          )}
        </WorkbenchLayout>
      </div>
      {previewTool ? (
        <McpToolPreview
          language={language}
          tool={previewTool}
          disabled={(draft?.disabledTools ?? []).includes(previewTool.name)}
          onClose={() => setPreviewTool(undefined)}
        />
      ) : null}
      {importOpen ? (
        <McpJsonImport
          language={language}
          onClose={() => setImportOpen(false)}
          onImport={model.importServers}
        />
      ) : null}
      {jsonEditOpen && draft && !draft.managed ? (
        <McpJsonEdit
          key={draft.id}
          language={language}
          server={draft}
          onClose={() => setJsonEditOpen(false)}
          onApply={model.update}
        />
      ) : null}
      {clientsOpen ? (
        <McpClientConnectionsDialog language={language} onClose={() => setClientsOpen(false)} />
      ) : null}
    </section>
  );
}

function isDirectTool(serverId: string, toolName: string): boolean {
  return (serverId === "agent-recall-session-search" && (toolName === "search_sessions" || toolName === "get_session"))
    || (serverId === "agent-recall-skills" && (toolName === "list_skills" || toolName === "get_skill"));
}
