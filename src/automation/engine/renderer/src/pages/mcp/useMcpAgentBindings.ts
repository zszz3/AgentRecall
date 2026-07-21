import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConfiguredAgent } from "../../../../shared/types";
import { MCP_CATALOG, type McpAgentDiagnostic } from "../../../../shared/mcp-config";
import { agentRecallAutomationService } from "../../app/services/agent-recall-service";

export function useMcpAgentBindings(agents: ConfiguredAgent[]) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [diagnostics, setDiagnostics] = useState<McpAgentDiagnostic[]>([]);
  const [selectedCatalogId, setSelectedCatalogId] = useState(MCP_CATALOG[0]?.id ?? "");
  const [allowedPath, setAllowedPath] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const agent = agents.find((item) => item.id === agentId) ?? agents[0];

  useEffect(() => { if (agent && agent.id !== agentId) setAgentId(agent.id); }, [agent, agentId]);
  const reload = useCallback(async () => {
    if (!agent?.id) { setDiagnostics([]); return; }
    setBusy(true); setError(undefined);
    try { setDiagnostics(await agentRecallAutomationService().listAgentMcps(agent.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, [agent?.id]);
  useEffect(() => { void reload(); }, [reload]);

  const installedIds = useMemo(() => new Set(diagnostics.map((item) => item.catalogId)), [diagnostics]);
  const available = useMemo(() => MCP_CATALOG.filter((item) => !installedIds.has(item.id)), [installedIds]);
  const install = useCallback(async () => {
    if (!agent || !selectedCatalogId) return;
    setBusy(true); setError(undefined);
    try { await agentRecallAutomationService().installAgentMcp({ agentId: agent.id, catalogId: selectedCatalogId, ...(allowedPath ? { allowedPath } : {}), ...(token ? { token } : {}) }); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, [agent, allowedPath, reload, selectedCatalogId, token]);
  const uninstall = useCallback(async (catalogId: string) => {
    if (!agent) return;
    setBusy(true); setError(undefined);
    try { await agentRecallAutomationService().uninstallAgentMcp({ agentId: agent.id, catalogId }); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, [agent, reload]);
  return { agent, agentId, setAgentId, diagnostics, available, selectedCatalogId, setSelectedCatalogId, allowedPath, setAllowedPath, token, setToken, busy, error, install, uninstall, reload };
}
