import type { AutomationApi } from "../../../../../../preload/automation";

export function agentRecallAutomationService(): AutomationApi {
  return window.sessionSearch.automation;
}
