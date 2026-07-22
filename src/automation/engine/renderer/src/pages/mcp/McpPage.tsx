import { useCallback, useEffect, useState } from "react";
import { PlugZap, Save, Server, Trash2, Wifi } from "lucide-react";
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
import type { ConfiguredAgent } from "../../../../shared/types";

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
      {view === "agents" ? <McpAgentBindings agents={agents} servers={model.servers} onSaveAgents={onSaveAgents} /> : (
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
              />
              <div className="workbench-browser-list">
                {model.servers.map((server) => (
                  <BrowserItem
                    key={server.id}
                    selected={server.id === draft?.id}
                    title={server.name}
                    meta={`${server.transport.toUpperCase()} · ${server.tools.length} tools`}
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
                  <div className="workbench-form-grid">
                    <label>
                      <span>{zh ? "名称" : "Name"}</span>
                      <input
                        value={draft.name}
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
                <WorkbenchSection
                  title={zh ? "环境变量引用" : "Environment references"}
                  description={
                    zh
                      ? "右侧填写宿主机环境变量名，不在数据库中保存密钥值。"
                      : "Reference host environment variable names; secret values are not stored."
                  }
                  action={
                    <button
                      type="button"
                      className="control-btn compact secondary"
                      onClick={() =>
                        model.update({
                          ...draft,
                          env: { ...draft.env, NEW_VARIABLE: "" },
                        })
                      }
                    >
                      + Variable
                    </button>
                  }
                >
                  <div className="mcp-env-list">
                    {Object.entries(draft.env).map(([key, value]) => (
                      <div key={key}>
                        <input
                          aria-label="Environment key"
                          value={key}
                          onChange={(event) => {
                            const env = { ...draft.env };
                            delete env[key];
                            env[event.target.value] = value;
                            model.update({ ...draft, env });
                          }}
                        />
                        <span>←</span>
                        <input
                          aria-label="Host environment variable"
                          value={value}
                          placeholder="HOST_ENV_NAME"
                          onChange={(event) =>
                            model.update({
                              ...draft,
                              env: { ...draft.env, [key]: event.target.value },
                            })
                          }
                        />
                        <button
                          className="icon-btn"
                          type="button"
                          aria-label={
                            zh ? "删除环境变量" : "Delete environment variable"
                          }
                          title={
                            zh ? "删除环境变量" : "Delete environment variable"
                          }
                          onClick={() => {
                            const env = { ...draft.env };
                            delete env[key];
                            model.update({ ...draft, env });
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </WorkbenchSection>
                <WorkbenchSection
                  title={zh ? "已发现工具" : "Discovered tools"}
                  description={
                    zh
                      ? "连接测试成功后自动刷新工具清单。"
                      : "The tool catalog refreshes after a successful connection test."
                  }
                >
                  {draft.tools.length ? (
                    <div className="workbench-table-wrap">
                      <table className="workbench-table">
                        <thead>
                          <tr>
                            <th>{zh ? "工具" : "Tool"}</th>
                            <th>{zh ? "描述" : "Description"}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {draft.tools.map((tool) => (
                            <tr key={tool.name}>
                              <td className="mono">
                                <strong>{tool.name}</strong>
                              </td>
                              <td>
                                {tool.description ||
                                  (zh ? "无描述" : "No description")}
                              </td>
                            </tr>
                          ))}
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
    </section>
  );
}
