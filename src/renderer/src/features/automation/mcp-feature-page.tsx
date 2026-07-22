import type { ReactElement } from "react";
import { McpPage } from "../../../../automation/engine/renderer/src/pages/mcp/McpPage";
import type { LanguageMode } from "../../language";
import { AutomationPageState } from "./automation-page-state";
import { useAutomation } from "./automation-provider";

export function McpFeaturePage({ language }: { language: LanguageMode }): ReactElement {
  const { api, snapshot, setSnapshot, loading, error, refresh } = useAutomation();
  return (
    <div className="automation-page automation-mcp-page" data-page="mcp">
      <AutomationPageState loading={loading} error={error} language={language} onRetry={() => void refresh()}>
        <McpPage
          language={language}
          agents={snapshot.configuredAgents}
          onSaveAgents={async (agents) => { setSnapshot(await api.saveConfiguredAgents(agents)); }}
        />
      </AutomationPageState>
    </div>
  );
}
