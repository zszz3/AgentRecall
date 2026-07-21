import type { ReactElement } from "react";
import { McpPage } from "../../../../automation/engine/renderer/src/pages/mcp/McpPage";
import type { LanguageMode } from "../../language";
import { AutomationPageState } from "./automation-page-state";
import { useAutomation } from "./automation-provider";

export function McpFeaturePage({ language }: { language: LanguageMode }): ReactElement {
  const { snapshot, loading, error, refresh } = useAutomation();
  return (
    <div className="automation-page automation-mcp-page" data-page="mcp">
      <AutomationPageState loading={loading} error={error} language={language} onRetry={() => void refresh()}>
        <McpPage language={language} agents={snapshot.configuredAgents} />
      </AutomationPageState>
    </div>
  );
}
