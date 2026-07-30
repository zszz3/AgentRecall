import {
  Bot,
  Cable,
  PackagePlus,
  RefreshCw,
  Server,
  Trash2,
  Wrench,
} from "lucide-react";
import type { ConfiguredAgent } from "../../../../shared/types";
import type { McpServerDefinition } from "../../../../shared/mcp/types";
import { MCP_CATALOG } from "../../../../shared/mcp-config";
import type { Language } from "../../app/language";
import {
  InlineStatus,
  WorkbenchEmpty,
} from "../../ui/workbench/Workbench";
import { useMcpAgentBindings } from "./useMcpAgentBindings";
import { toolCountLabel } from "./mcp-tools";

export function McpAgentBindings({
  language = "en",
  agents,
  servers = [],
  onSaveAgents,
}: {
  language?: Language;
  agents: ConfiguredAgent[];
  servers?: McpServerDefinition[];
  onSaveAgents?: (agents: ConfiguredAgent[]) => Promise<void>;
}) {
  const zh = language === "zh";
  const model = useMcpAgentBindings(agents, servers, onSaveAgents);
  const copy = zh
    ? {
        noAgents: "还没有 Agent",
        noAgentsDescription: "先在 Runtime 页面添加 Agent，再为它装配 MCP 服务。",
        targetAgent: "目标 Agent",
        bound: "已绑定",
        boundSummary: (available: number) => `${available} 个可用服务`,
        refresh: "刷新状态",
        registryEyebrow: "MCP ROUTES",
        registryTitle: "已注册服务",
        registryDescription: "打开开关，即可让当前 Agent 在新会话中使用该服务。",
        noServers: "还没有可绑定的 MCP Server。",
        apiNoServers: "API Agent 暂不支持 MCP；切换到其他运行时后即可绑定。",
        tools: (count: number) => `${count} 个工具`,
        connected: "已连接",
        failed: "连接失败",
        untested: "未测试",
        bind: "绑定",
        runtimeEyebrow: "RUNTIME SETUP",
        runtimeTitle: "运行时服务",
        runtimeDescription: "查看当前 Agent 的托管服务与运行时支持。",
        runtimeCodexDescription: "由 AgentRecall 直接写入 Codex 配置的托管服务。",
        installed: "已安装",
        noInstalled: "尚未安装托管服务",
        ready: "可用",
        needsSetup: "待配置",
        error: "异常",
        remove: "卸载",
        catalog: "从目录安装",
        allInstalled: "目录中的服务已全部安装。",
        allowedPath: "允许访问的目录",
        githubToken: "GitHub Token",
        install: "安装",
        catalogCodexOnly: "托管目录仅支持 Codex。当前 Agent 仍可使用左侧的自定义 MCP Server。",
        apiUnavailable: "API Agent 暂不支持 MCP 服务。",
      }
    : {
        noAgents: "No agents",
        noAgentsDescription: "Create an Agent in Runtime before assigning MCP servers.",
        targetAgent: "Target Agent",
        bound: "Bound",
        boundSummary: (available: number) => `${available} services available`,
        refresh: "Refresh status",
        registryEyebrow: "MCP ROUTES",
        registryTitle: "Registered servers",
        registryDescription: "Turn on a server to make it available in this Agent's new sessions.",
        noServers: "No MCP servers are available to bind.",
        apiNoServers: "API Agents do not support MCP. Choose another runtime to add bindings.",
        tools: (count: number) => `${count} tools`,
        connected: "Connected",
        failed: "Connection failed",
        untested: "Not tested",
        bind: "Bind",
        runtimeEyebrow: "RUNTIME SETUP",
        runtimeTitle: "Runtime services",
        runtimeDescription: "Review managed services and runtime support for this Agent.",
        runtimeCodexDescription: "Managed services written directly to the Codex configuration.",
        installed: "Installed",
        noInstalled: "No managed services installed",
        ready: "Ready",
        needsSetup: "Needs setup",
        error: "Error",
        remove: "Uninstall",
        catalog: "Install from catalog",
        allInstalled: "Every catalog service is installed.",
        allowedPath: "Allowed directory",
        githubToken: "GitHub token",
        install: "Install",
        catalogCodexOnly: "The managed catalog is available for Codex. This Agent can still use custom MCP servers on the left.",
        apiUnavailable: "API Agents do not support MCP servers.",
      };
  if (!model.agent) {
    return (
      <WorkbenchEmpty
        icon={<Wrench size={22} />}
        title={copy.noAgents}
        description={copy.noAgentsDescription}
      />
    );
  }
  const selected =
    MCP_CATALOG.find((item) => item.id === model.selectedCatalogId) ??
    model.available[0];
  const supportsCustomServers = model.agent.runtimeAgentId !== "api";
  const customServers = supportsCustomServers
    ? model.customServers
    : servers.filter((server) => model.boundServerIds.has(server.id));
  const orderedServers = [...customServers].sort((left, right) => {
    const bindingDifference =
      Number(model.boundServerIds.has(right.id)) -
      Number(model.boundServerIds.has(left.id));
    return bindingDifference || left.name.localeCompare(right.name);
  });
  const boundCount = customServers.filter((server) =>
    model.boundServerIds.has(server.id)
  ).length;

  return (
    <div className="mcp-agent-bindings">
      <header className="mcp-binding-route">
        <div className="mcp-binding-route-agent">
          <span className="mcp-binding-route-icon">
            <Bot size={17} />
          </span>
          <label>
            <span>{copy.targetAgent}</span>
            <select
              aria-label={copy.targetAgent}
              value={model.agent.id}
              onChange={(event) => model.setAgentId(event.target.value)}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </label>
        </div>
        <span className="mcp-binding-route-line" aria-hidden="true">
          <i />
          <i />
        </span>
        <div className="mcp-binding-route-summary">
          <Cable size={16} />
          <span>
            <strong>{boundCount}</strong>
            <small>{copy.bound} · {copy.boundSummary(customServers.length)}</small>
          </span>
        </div>
        <button
          className="icon-btn mcp-binding-refresh"
          type="button"
          aria-label={copy.refresh}
          title={copy.refresh}
          onClick={() => void model.reload()}
          disabled={model.busy}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      {model.error ? <div className="workbench-error">{model.error}</div> : null}
      <div className="mcp-binding-grid">
        <section className="mcp-binding-panel is-routes">
          <header className="mcp-binding-panel-header">
            <div>
              <span>{copy.registryEyebrow}</span>
              <h3>{copy.registryTitle}</h3>
              <p>{copy.registryDescription}</p>
            </div>
            <strong>{customServers.length}</strong>
          </header>
          <div className="mcp-binding-server-list">
            {orderedServers.length ? orderedServers.map((server) => {
              const bound = model.boundServerIds.has(server.id);
              const statusCopy = server.status === "connected"
                ? copy.connected
                : server.status === "error"
                  ? copy.failed
                  : copy.untested;
              return (
                <label
                  key={server.id}
                  className={`mcp-binding-server ${bound ? "is-bound" : ""}`}
                >
                  <span className={`mcp-binding-server-icon is-${server.status}`}>
                    <Server size={15} />
                  </span>
                  <span className="mcp-binding-server-copy">
                    <strong>{server.name}</strong>
                    <span className="mcp-binding-server-meta">
                      <code>{server.transport.toUpperCase()}</code>
                      <small>{toolCountLabel(server, zh ? "个工具" : "tools")}</small>
                      <small className={`is-${server.status}`}>
                        <i />
                        {statusCopy}
                      </small>
                    </span>
                  </span>
                  <span className="mcp-binding-switch">
                    <input
                      type="checkbox"
                      aria-label={`${copy.bind} ${server.name}`}
                      checked={bound}
                      disabled={model.busy || !onSaveAgents}
                      onChange={() => void model.toggleServer(server.id)}
                    />
                    <i aria-hidden="true" />
                  </span>
                </label>
              );
            }) : (
              <div className="mcp-binding-empty">
                <Cable size={18} />
                <p>{supportsCustomServers ? copy.noServers : copy.apiNoServers}</p>
              </div>
            )}
          </div>
        </section>

        <aside className="mcp-binding-panel is-runtime">
          <header className="mcp-binding-panel-header">
            <div>
              <span>{copy.runtimeEyebrow}</span>
              <h3>{copy.runtimeTitle}</h3>
              <p>
                {model.agent.runtimeAgentId === "codex"
                  ? copy.runtimeCodexDescription
                  : copy.runtimeDescription}
              </p>
            </div>
            <code>{model.agent.runtimeAgentId}</code>
          </header>

          <div className="mcp-binding-runtime-content">
            <section className="mcp-binding-managed">
              <div className="mcp-binding-subheading">
                <span>{copy.installed}</span>
                <small>{model.diagnostics.length}</small>
              </div>
              <div className="mcp-binding-managed-list">
                {model.diagnostics.length ? model.diagnostics.map((item) => (
                  <article key={item.catalogId}>
                    <span className="mcp-binding-managed-icon">
                      <PackagePlus size={14} />
                    </span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.description}</small>
                    </span>
                    <InlineStatus
                      tone={item.status === "healthy"
                        ? "success"
                        : item.status === "error"
                          ? "danger"
                          : "muted"}
                    >
                      {item.status === "healthy"
                        ? copy.ready
                        : item.status === "error"
                          ? copy.error
                          : copy.needsSetup}
                    </InlineStatus>
                    <button
                      className="icon-btn"
                      type="button"
                      onClick={() => void model.uninstall(item.catalogId)}
                      disabled={model.busy}
                      aria-label={`${copy.remove} ${item.name}`}
                      title={`${copy.remove} ${item.name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </article>
                )) : (
                  <p className="mcp-binding-runtime-empty">{copy.noInstalled}</p>
                )}
              </div>
            </section>

            {model.agent.runtimeAgentId === "codex" ? (
              <section className="mcp-binding-catalog">
                <div className="mcp-binding-subheading">
                  <span>{copy.catalog}</span>
                </div>
                {selected ? (
                  <>
                    <select
                      aria-label={copy.catalog}
                      value={selected.id}
                      onChange={(event) => model.setSelectedCatalogId(event.target.value)}
                    >
                      {model.available.map((item) => (
                        <option key={item.id} value={item.id}>{item.name}</option>
                      ))}
                    </select>
                    <p>{selected.description}</p>
                    {selected.requiresPath ? (
                      <input
                        value={model.allowedPath}
                        onChange={(event) => model.setAllowedPath(event.target.value)}
                        placeholder={copy.allowedPath}
                      />
                    ) : null}
                    {selected.requiresToken ? (
                      <input
                        type="password"
                        value={model.token}
                        onChange={(event) => model.setToken(event.target.value)}
                        placeholder={copy.githubToken}
                      />
                    ) : null}
                    <button
                      className="control-btn compact is-active"
                      type="button"
                      disabled={model.busy}
                      onClick={() => void model.install()}
                    >
                      <PackagePlus size={13} />
                      {copy.install}
                    </button>
                  </>
                ) : (
                  <p className="mcp-binding-runtime-empty">{copy.allInstalled}</p>
                )}
              </section>
            ) : (
              <div className="mcp-binding-runtime-note">
                <PackagePlus size={15} />
                <p>{supportsCustomServers ? copy.catalogCodexOnly : copy.apiUnavailable}</p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
