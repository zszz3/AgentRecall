import { useCallback, useEffect, useState } from "react";
import { Eye, FileJson, PlugZap, Power, Save, Server, Trash2, Wifi } from "lucide-react";
import type { Language } from "../../app/language";
import { APP_SAVE_REQUEST_EVENT } from "../../app/save-shortcut";
import {
  BrowserHeader,
  BrowserItem,
  DetailToolbar,
  InlineStatus,
  WorkbenchEmpty,
  WorkbenchHeader,
  WorkbenchLayout,
  WorkbenchSection,
  WorkbenchTabs,
} from "../../ui/workbench/Workbench";
import { useMcpRegistry } from "./useMcpRegistry";
import { McpAgentBindings } from "./McpAgentBindings";
import { McpToolPreview } from "./McpToolPreview";
import { McpJsonImport } from "./McpJsonImport";
import { McpJsonEdit } from "./McpJsonEdit";
import { McpReferenceEditor } from "./McpReferenceEditor";
import { toolCountLabel } from "./mcp-tools";
import type { ConfiguredAgent } from "../../../../shared/types";
import type { McpToolDefinition } from "../../../../shared/mcp/types";

export function McpPage({
  language = "en",
  agents,
  onSaveAgents,
}: {
  language?: Language;
  agents: ConfiguredAgent[];
  onSaveAgents?: (agents: ConfiguredAgent[]) => Promise<void>;
}) {
  const zh = language === "zh";
  const model = useMcpRegistry();
  const [view, setView] = useState<"servers" | "agents">("servers");
  const [previewTool, setPreviewTool] = useState<McpToolDefinition>();
  const [importOpen, setImportOpen] = useState(false);
  const [jsonEditOpen, setJsonEditOpen] = useState(false);
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
  return (
    <section className="mcp-workbench">
      <WorkbenchHeader
        eyebrow="CAPABILITY REGISTRY"
        title="MCP"
        description={
          zh
            ? "管理 Agent 可装配的本地与远程工具服务。"
            : "Manage local and remote tool servers available to Agents."
        }
      />
      <WorkbenchTabs
        label={zh ? "MCP 视图" : "MCP views"}
        active={view}
        onChange={setView}
        tabs={[
          { id: "servers", label: zh ? "服务器" : "Servers", count: model.servers.length },
          { id: "agents", label: zh ? "Agent 绑定" : "Agent bindings", count: agents.length },
        ]}
      />
      {view === "agents" ? <McpAgentBindings language={language} agents={agents} servers={model.servers} onSaveAgents={onSaveAgents} /> : (
        <>
      {model.error ? (
        <div className="workbench-error" role="alert">
          {model.error}
        </div>
      ) : null}
      <div className="mcp-workbench-body">
        <WorkbenchLayout
          browser={
            <>
              <BrowserHeader
                label={zh ? "服务器" : "Servers"}
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
                {model.servers.map((server) => (
                  <BrowserItem
                    key={server.id}
                    selected={server.id === draft?.id}
                    title={server.name}
                    meta={`${server.transport.toUpperCase()} · ${toolCountLabel(server, zh ? "工具" : "tools")}`}
                    badge={server.managed ? (zh ? "内置" : "Built-in") : undefined}
                    status={
                      server.status === "connected"
                        ? "success"
                        : server.status === "error"
                          ? "danger"
                          : "muted"
                    }
                    onClick={() => select(server.id)}
                  />
                ))}
              </div>
            </>
          }
        >
          {draft ? (
            <>
              <DetailToolbar
                title={draft.name}
                meta={`${draft.transport.toUpperCase()} · ${draft.id}`}
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
                      {zh
                        ? "内置 Server，启动命令由 App 统一管理，此处只读。"
                        : "Built-in server; its launch command is managed by the app and is read-only here."}
                    </p>
                  ) : null}
                  <div className="workbench-form-grid">
                    <label>
                      <span>{zh ? "名称" : "Name"}</span>
                      <input
                        value={draft.name}
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
                        ? `连接测试成功后自动刷新工具清单。已启用 ${draft.tools.length - (draft.disabledTools?.length ?? 0)} / ${draft.tools.length} 个工具。`
                        : `The tool catalog refreshes after a successful connection test. ${draft.tools.length - (draft.disabledTools?.length ?? 0)} of ${draft.tools.length} tools enabled.`
                      : zh
                        ? "连接测试成功后自动刷新工具清单。"
                        : "The tool catalog refreshes after a successful connection test."
                  }
                >
                  {draft.tools.length ? (
                    <div className="workbench-table-wrap">
                      <table className="workbench-table mcp-tool-table">
                        <thead>
                          <tr>
                            <th>{zh ? "启用" : "Enabled"}</th>
                            <th>{zh ? "工具" : "Tool"}</th>
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
                          ? "保存配置并测试连接，以读取 Server 提供的工具。"
                          : "Save the configuration and test the connection to discover tools."
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
                  ? "添加本地命令或远程 HTTP Server，供 Agent 装配使用。"
                  : "Add a local command or remote HTTP server for your Agents."
              }
              actionLabel={zh ? "新建 Server" : "New server"}
              onAction={model.create}
            />
          )}
        </WorkbenchLayout>
      </div>
        </>
      )}
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
    </section>
  );
}
