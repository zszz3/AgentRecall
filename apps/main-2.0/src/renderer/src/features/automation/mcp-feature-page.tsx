import { useState, type ReactElement } from "react";
import { McpPage } from "../../../../automation/engine/renderer/src/pages/mcp/McpPage";
import type { LanguageMode } from "../../language";
import { Segmented } from "../../ui/primitives";
import { AutomationPageState } from "./automation-page-state";
import { useAutomationDetails } from "./automation-provider";
import { ConfiguredMcpCatalog } from "./configured-mcp-catalog";
import { McpCallLogsPanel } from "./mcp-call-logs-panel";

type McpView = "gateway" | "logs" | "configured";

/**
 * AgentRecall's own MCP tool sources, live invocation logs, and a read-only view of the
 * servers agents, projects and teams already configure themselves.
 */
export function McpFeaturePage({ language, onOpenTeamSpace }: { language: LanguageMode; onOpenTeamSpace?(): void }): ReactElement {
  const { api, loading, error, refresh } = useAutomationDetails();
  const [view, setView] = useState<McpView>("gateway");
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const switcher = <Segmented<McpView>
    label={l("MCP view", "MCP 视图")}
    value={view}
    onChange={setView}
    options={[
      { value: "gateway", label: l("Gateway sources", "网关工具源") },
      { value: "logs", label: l("Call logs", "调用日志") },
      { value: "configured", label: l("In agents & teams", "本机与团队") },
    ]}
  />;
  if (view === "logs") {
    return (
      <div className="automation-page automation-mcp-page" data-page="mcp-logs">
        <McpCallLogsPanel language={language} switcher={switcher} api={api} />
      </div>
    );
  }
  if (view === "configured") {
    return <ConfiguredMcpCatalog language={language} switcher={switcher} onOpenTeamSpace={onOpenTeamSpace} toolSources={api} />;
  }
  return (
    <div className="automation-page automation-mcp-page" data-page="mcp">
      <AutomationPageState loading={loading} error={error} language={language} onRetry={() => void refresh()}>
        <McpPage language={language} headerExtra={switcher} />
      </AutomationPageState>
    </div>
  );
}
