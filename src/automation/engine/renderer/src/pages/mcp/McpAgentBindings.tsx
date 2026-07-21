import { RefreshCw, Trash2, Wrench } from "lucide-react";
import type { ConfiguredAgent } from "../../../../shared/types";
import { MCP_CATALOG } from "../../../../shared/mcp-config";
import { DetailToolbar, InlineStatus, WorkbenchEmpty, WorkbenchSection } from "../../ui/workbench/Workbench";
import { useMcpAgentBindings } from "./useMcpAgentBindings";

export function McpAgentBindings({ agents }: { agents: ConfiguredAgent[] }) {
  const model = useMcpAgentBindings(agents);
  if (!model.agent) return <WorkbenchEmpty icon={<Wrench size={22} />} title="No agents" description="Create an Agent before assigning MCP servers." />;
  const selected = MCP_CATALOG.find((item) => item.id === model.selectedCatalogId) ?? model.available[0];
  return <div className="mcp-agent-bindings">
    <DetailToolbar title="Agent bindings" meta="Install managed MCP servers into a specific Agent runtime config." actions={<button className="control-btn compact secondary" onClick={() => void model.reload()} disabled={model.busy}><RefreshCw size={13} />Refresh</button>} />
    {model.error ? <div className="workbench-error">{model.error}</div> : null}
    <WorkbenchSection title="Target Agent">
      <select value={model.agent.id} onChange={(event) => model.setAgentId(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
    </WorkbenchSection>
    <WorkbenchSection title="Installed services" description="Managed entries are written atomically to the Agent runtime configuration.">
      <div className="mcp-binding-list">{model.diagnostics.length ? model.diagnostics.map((item) => <article key={item.catalogId} className="mcp-binding-item"><div><strong>{item.name}</strong><span>{item.description}</span><InlineStatus tone={item.status === "healthy" ? "success" : item.status === "error" ? "danger" : "muted"}>{item.status}</InlineStatus></div><button className="icon-btn" onClick={() => void model.uninstall(item.catalogId)} disabled={model.busy} aria-label={`Uninstall ${item.name}`}><Trash2 size={14} /></button></article>) : <p className="workbench-muted">No managed MCP servers installed for this Agent.</p>}</div>
    </WorkbenchSection>
    <WorkbenchSection title="Install from catalog" {...(selected?.description ? { description: selected.description } : {})}>
      <div className="mcp-binding-install"><select value={selected?.id ?? ""} onChange={(event) => model.setSelectedCatalogId(event.target.value)}>{model.available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{selected?.requiresPath ? <input value={model.allowedPath} onChange={(event) => model.setAllowedPath(event.target.value)} placeholder="Allowed directory" /> : null}{selected?.requiresToken ? <input type="password" value={model.token} onChange={(event) => model.setToken(event.target.value)} placeholder="GitHub token" /> : null}<button className="control-btn compact" disabled={!selected || model.busy} onClick={() => void model.install()}>Install</button></div>
    </WorkbenchSection>
  </div>;
}
