import { RefreshCw, Trash2, Wrench } from "lucide-react";
import type { ConfiguredAgent } from "../../../../shared/types";
import type { McpServerDefinition } from "../../../../shared/mcp/types";
import { MCP_CATALOG } from "../../../../shared/mcp-config";
import {
  DetailToolbar,
  InlineStatus,
  WorkbenchEmpty,
  WorkbenchSection,
} from "../../ui/workbench/Workbench";
import { useMcpAgentBindings } from "./useMcpAgentBindings";

export function McpAgentBindings({
  agents,
  servers = [],
  onSaveAgents,
}: {
  agents: ConfiguredAgent[];
  servers?: McpServerDefinition[];
  onSaveAgents?: (agents: ConfiguredAgent[]) => Promise<void>;
}) {
  const model = useMcpAgentBindings(agents, servers, onSaveAgents);
  if (!model.agent) {
    return (
      <WorkbenchEmpty
        icon={<Wrench size={22} />}
        title="No agents"
        description="Create an Agent before assigning MCP servers."
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

  return (
    <div className="mcp-agent-bindings">
      <DetailToolbar
        title="Agent bindings"
        meta="Assign MCP servers to a specific Agent runtime."
        actions={(
          <button
            className="control-btn compact secondary"
            onClick={() => void model.reload()}
            disabled={model.busy}
          >
            <RefreshCw size={13} />
            Refresh
          </button>
        )}
      />
      {model.error ? <div className="workbench-error">{model.error}</div> : null}
      <WorkbenchSection title="Target Agent">
        <select
          value={model.agent.id}
          onChange={(event) => model.setAgentId(event.target.value)}
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </select>
      </WorkbenchSection>
      <WorkbenchSection
        title="Custom servers"
        description={supportsCustomServers
          ? "Attach enabled registry servers to this Agent. Changes apply to new runtime sessions."
          : "The API runtime does not support MCP servers. Existing inactive bindings can still be removed."}
      >
        <div className="mcp-binding-list">
          {customServers.length ? customServers.map((server) => (
            <label key={server.id} className="mcp-binding-item">
              <span>
                <strong>{server.name}</strong>
                <small>{server.transport.toUpperCase()} · {server.tools.length} tools</small>
              </span>
              <input
                type="checkbox"
                checked={model.boundServerIds.has(server.id)}
                disabled={model.busy || !onSaveAgents}
                onChange={() => void model.toggleServer(server.id)}
              />
            </label>
          )) : (
            <p className="workbench-muted">
              {supportsCustomServers
                ? "No enabled custom MCP servers."
                : "Choose Codex, Claude Code, Hermes, OpenCode, or OpenClaw to use custom MCP servers."}
            </p>
          )}
        </div>
      </WorkbenchSection>
      <WorkbenchSection
        title="Installed services"
        description="Managed Codex entries are written atomically to the runtime configuration."
      >
        <div className="mcp-binding-list">
          {model.diagnostics.length ? model.diagnostics.map((item) => (
            <article key={item.catalogId} className="mcp-binding-item">
              <div>
                <strong>{item.name}</strong>
                <span>{item.description}</span>
                <InlineStatus
                  tone={item.status === "healthy"
                    ? "success"
                    : item.status === "error"
                      ? "danger"
                      : "muted"}
                >
                  {item.status}
                </InlineStatus>
              </div>
              <button
                className="icon-btn"
                onClick={() => void model.uninstall(item.catalogId)}
                disabled={model.busy}
                aria-label={`Uninstall ${item.name}`}
              >
                <Trash2 size={14} />
              </button>
            </article>
          )) : (
            <p className="workbench-muted">No managed MCP servers installed for this Agent.</p>
          )}
        </div>
      </WorkbenchSection>
      {model.agent.runtimeAgentId === "codex" ? (
        <WorkbenchSection
          title="Install from catalog"
          {...(selected?.description ? { description: selected.description } : {})}
        >
          <div className="mcp-binding-install">
            <select
              value={selected?.id ?? ""}
              onChange={(event) => model.setSelectedCatalogId(event.target.value)}
            >
              {model.available.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
            {selected?.requiresPath ? (
              <input
                value={model.allowedPath}
                onChange={(event) => model.setAllowedPath(event.target.value)}
                placeholder="Allowed directory"
              />
            ) : null}
            {selected?.requiresToken ? (
              <input
                type="password"
                value={model.token}
                onChange={(event) => model.setToken(event.target.value)}
                placeholder="GitHub token"
              />
            ) : null}
            <button
              className="control-btn compact"
              disabled={!selected || model.busy}
              onClick={() => void model.install()}
            >
              Install
            </button>
          </div>
        </WorkbenchSection>
      ) : (
        <p className="workbench-muted">
          {supportsCustomServers
            ? "Catalog installation is available for Codex Agents. Use custom server bindings for this runtime."
            : "MCP is unavailable for API-only Agents."}
        </p>
      )}
    </div>
  );
}
