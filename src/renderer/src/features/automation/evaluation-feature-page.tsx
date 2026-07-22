import type { ReactElement } from "react";
import { EvaluationPage } from "../../../../automation/engine/renderer/src/pages/evaluation/EvaluationPage";
import type { LanguageMode } from "../../language";
import { AutomationPageState } from "./automation-page-state";
import { useAutomation } from "./automation-provider";

export function EvaluationFeaturePage({
  language,
  onNavigationGuardChange,
}: {
  language: LanguageMode;
  onNavigationGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
}): ReactElement {
  const { api, snapshot, loading, error, refresh } = useAutomation();
  return (
    <div className="automation-page automation-evaluation-page" data-page="evaluation">
      <AutomationPageState loading={loading} error={error} language={language} onRetry={() => void refresh()}>
        <EvaluationPage
          language={language}
          agents={snapshot.configuredAgents}
          channels={snapshot.channels}
          api={api}
          onNavigationGuardChange={onNavigationGuardChange}
        />
      </AutomationPageState>
    </div>
  );
}
