import { useState, type ReactElement } from "react";
import { McpPage } from "../../../../automation/engine/renderer/src/pages/mcp/McpPage";
import type { LanguageMode } from "../../language";
import { Segmented } from "../../ui/primitives";
import { AutomationPageState } from "./automation-page-state";
import { useAutomationDetails } from "./automation-provider";
import { ConfiguredMcpCatalog } from "./configured-mcp-catalog";

type McpView = "gateway" | "configured";

/**
 * AgentRecall's own MCP tool sources, which it serves to agents through its gateway, and a
 * read-only view of the servers agents, projects and teams already configure themselves.
 */
export function McpFeaturePage({ language, onOpenTeamSpace }: { language: LanguageMode; onOpenTeamSpace?(): void }): ReactElement {
  const { loading, error, refresh } = useAutomationDetails();
  const [view, setView] = useState<McpView>("gateway");
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const switcher = <Segmented<McpView>
    label={l("MCP view", "MCP 视图")}
    value={view}
    onChange={setView}
    options={[{ value: "gateway", label: l("Tool sources", "工具源") }, { value: "configured", label: l("In agents & teams", "Agent 与团队") }]}
  />;
  if (view === "configured") {
    return <ConfiguredMcpCatalog language={language} switcher={switcher} onOpenTeamSpace={onOpenTeamSpace} />;
  }
  return (
    <div className="automation-page automation-mcp-page" data-page="mcp">
      <AutomationPageState loading={loading} error={error} language={language} onRetry={() => void refresh()}>
        <McpPage language={language} headerExtra={switcher} />
      </AutomationPageState>
    </div>
  );
}
