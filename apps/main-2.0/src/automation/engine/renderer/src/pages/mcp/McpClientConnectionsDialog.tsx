import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Copy, Link2, Radio, X } from "lucide-react";
import type { Language } from "../../app/language";
import type {
  McpClientTransportPreference,
  McpExternalClientConnection,
  McpExternalClientConnections,
  McpExternalClientId,
  McpServerDefinition,
} from "../../../../shared/mcp/types";
import { agentRecallAutomationService } from "../../app/services/agent-recall-service";

export function McpClientConnectionsDialog({
  language,
  servers = [],
  onClose,
}: {
  language: Language;
  servers?: McpServerDefinition[];
  onClose: () => void;
}) {
  const zh = language === "zh";
  const [snapshot, setSnapshot] = useState<McpExternalClientConnections>();
  const [busy, setBusy] = useState<McpExternalClientId>();
  const [expandedClient, setExpandedClient] = useState<McpExternalClientId>();
  const [copiedHub, setCopiedHub] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void agentRecallAutomationService().getMcpClientConnections()
      .then(setSnapshot)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const updateClient = async (
    clientId: McpExternalClientId,
    patch: {
      enabled: boolean;
      transport?: McpClientTransportPreference;
      allowedServerIds?: string[] | null;
    },
  ) => {
    setBusy(clientId);
    setError(undefined);
    try {
      setSnapshot(await agentRecallAutomationService().setMcpClientConnection({ clientId, ...patch }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const toggleAllowedServer = (client: McpExternalClientConnection, serverId: string) => {
    const allIds = servers.filter((item) => item.enabled).map((item) => item.id);
    const current = client.allowedServerIds ? new Set(client.allowedServerIds) : new Set(allIds);
    if (current.has(serverId)) current.delete(serverId);
    else current.add(serverId);
    const next = [...current];
    const coversAll = allIds.length > 0 && allIds.every((id) => current.has(id));
    void updateClient(client.clientId, {
      enabled: client.enabled,
      transport: client.transport,
      allowedServerIds: coversAll ? null : next,
    });
  };

  const copyHubUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedHub(true);
      window.setTimeout(() => setCopiedHub(false), 1_500);
    } catch {
      // Clipboard access can be unavailable in restricted contexts.
    }
  };

  const hub = snapshot?.hub;
  const enabledServers = servers.filter((item) => item.enabled);

  return (
    <div className="mcp-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="mcp-modal mcp-client-modal"
        role="dialog"
        aria-modal="true"
        aria-label={zh ? "连接 MCP 客户端" : "Connect MCP clients"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mcp-modal-header">
          <div className="mcp-modal-title">
            <Link2 size={17} />
            <div>
              <strong>{zh ? "连接客户端" : "Connect clients"}</strong>
              <small>
                {zh
                  ? "支持 Streamable HTTP Hub（/mcp/<agent>）与 STDIO，每个客户端仅写入一个 agent-recall 入口。"
                  : "Supports Streamable HTTP Hub (/mcp/<agent>) and STDIO; each client gets one agent-recall entry."}
              </small>
            </div>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label={zh ? "关闭" : "Close"}>
            <X size={15} />
          </button>
        </header>
        <div className="mcp-modal-body mcp-client-list">
          {hub ? (
            <div className="mcp-client-row" style={{ alignItems: "center" }}>
              <span className={`mcp-client-state ${hub.running ? "is-connected" : ""}`}>
                <Radio size={17} />
              </span>
              <span className="mcp-client-copy">
                <strong>
                  {zh ? "Streamable HTTP MCP Hub" : "Streamable HTTP MCP Hub"}
                  {hub.running
                    ? (zh ? ` · 运行中（${hub.activeSessions} 活跃会话）` : ` · Running (${hub.activeSessions} active)`)
                    : (zh ? " · 未运行" : " · Stopped")}
                </strong>
                <small>
                  {hub.error
                    ? hub.error
                    : (zh
                        ? "支持工具变更实时通知（tools/list_changed）与按客户端路由工具源。"
                        : "Pushes live tools/list_changed notifications and routes per-client tool subsets.")}
                </small>
                <code>{hub.url}</code>
              </span>
              <button
                className="control-btn compact secondary"
                type="button"
                onClick={() => void copyHubUrl(hub.url)}
              >
                <Copy size={12} />
                {copiedHub ? (zh ? "已复制" : "Copied") : (zh ? "复制" : "Copy")}
              </button>
            </div>
          ) : null}

          {snapshot ? snapshot.clients.map((client) => {
            const connected = client.enabled && client.configured;
            const isExpanded = expandedClient === client.clientId;
            const scopedCount = client.allowedServerIds?.length;
            return (
              <div key={client.clientId} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="mcp-client-row">
                  <span className={`mcp-client-state ${connected ? "is-connected" : ""}`}>
                    {connected ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
                  </span>
                  <span className="mcp-client-copy">
                    <strong style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span>{client.label}</span>
                      {client.supportsStdio ? (
                        <span className="workbench-segmented">
                          <button
                            type="button"
                            className={client.transport === "http" ? "is-active" : ""}
                            disabled={Boolean(busy)}
                            onClick={() => void updateClient(client.clientId, {
                              enabled: client.enabled,
                              transport: "http",
                            })}
                          >
                            HTTP
                          </button>
                          <button
                            type="button"
                            className={client.transport === "stdio" ? "is-active" : ""}
                            disabled={Boolean(busy)}
                            onClick={() => void updateClient(client.clientId, {
                              enabled: client.enabled,
                              transport: "stdio",
                            })}
                          >
                            STDIO
                          </button>
                        </span>
                      ) : (
                        <code>HTTP Hub</code>
                      )}
                    </strong>
                    <small>
                      {!client.detected
                        ? (zh ? "未检测到安装，仍可手动连接" : "Installation not detected; manual connection is still available")
                        : connected
                          ? (zh ? "已连接 AgentRecall Gateway" : "AgentRecall Gateway connected")
                          : client.enabled
                            ? (zh ? "配置缺失，可重新连接" : "Configuration missing; reconnect to repair")
                            : (zh ? "已断开" : "Disconnected")}
                      {client.transport === "http" && enabledServers.length > 0 ? (
                        <>
                          {" · "}
                          <button
                            type="button"
                            className="icon-btn"
                            style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: "0 4px" }}
                            onClick={() => setExpandedClient(isExpanded ? undefined : client.clientId)}
                          >
                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            {scopedCount === undefined
                              ? (zh ? "全部已启用工具源" : "All enabled sources")
                              : (zh ? `已选 ${scopedCount} 个工具源` : `${scopedCount} sources selected`)}
                          </button>
                        </>
                      ) : null}
                    </small>
                    <code>{client.configPath}</code>
                  </span>
                  <span className="mcp-binding-switch">
                    <input
                      type="checkbox"
                      aria-label={`${zh ? "连接" : "Connect"} ${client.label}`}
                      checked={connected}
                      disabled={Boolean(busy)}
                      onChange={(event) => void updateClient(client.clientId, {
                        enabled: event.currentTarget.checked,
                        transport: client.transport,
                      })}
                    />
                    <i aria-hidden="true" />
                  </span>
                </div>
                {isExpanded && client.transport === "http" ? (
                  <div
                    style={{
                      marginLeft: 32,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "var(--surface-2, rgba(127,127,127,0.08))",
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "6px 12px",
                    }}
                  >
                    {enabledServers.map((server) => {
                      const checked = !client.allowedServerIds || client.allowedServerIds.includes(server.id);
                      return (
                        <label key={server.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={Boolean(busy)}
                            onChange={() => toggleAllowedServer(client, server.id)}
                          />
                          <span>{server.name}</span>
                        </label>
                      );
                    })}
                    {client.allowedServerIds ? (
                      <button
                        type="button"
                        className="control-btn compact secondary"
                        disabled={Boolean(busy)}
                        onClick={() => void updateClient(client.clientId, {
                          enabled: client.enabled,
                          transport: client.transport,
                          allowedServerIds: null,
                        })}
                      >
                        {zh ? "恢复全部" : "Reset to all"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          }) : (
            <p className="mcp-modal-description">{zh ? "正在检查客户端配置…" : "Checking client configuration…"}</p>
          )}
          {error ? <div className="mcp-inline-error" role="alert">{error}</div> : null}
        </div>
        <footer className="mcp-modal-footer">
          <p>{zh ? "修改后请重启对应客户端以加载新配置；HTTP Hub 变更工具源会自动推送刷新。" : "Restart clients after changing config; HTTP Hub pushes tool updates live."}</p>
          <button className="control-btn compact secondary" type="button" onClick={onClose}>
            {zh ? "完成" : "Done"}
          </button>
        </footer>
      </section>
    </div>
  );
}
