import { useState, type ReactElement } from "react";
import { McpPage } from "../../../../automation/engine/renderer/src/pages/mcp/McpPage";
import type { LanguageMode } from "../../language";
import { PageBody, PageHeader, Segmented } from "../../ui/primitives";
import { TeamResourceSection } from "../team-workspace/team-resource-section";
import { AutomationPageState } from "./automation-page-state";
import { useAutomationDetails } from "./automation-provider";

type McpView = "gateway" | "team";

export function McpFeaturePage({ language, onOpenTeamSpace }: { language: LanguageMode; onOpenTeamSpace?(): void }): ReactElement {
  const { loading, error, refresh } = useAutomationDetails();
  const [view, setView] = useState<McpView>("gateway");
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const switcher = <Segmented<McpView>
    label={l("MCP scope", "MCP 范围")}
    value={view}
    onChange={setView}
    options={[{ value: "gateway", label: l("Tool sources", "工具源") }, { value: "team", label: l("Team", "团队") }]}
  />;
  if (view === "team") {
    return (
      <div className="automation-page automation-mcp-page mcp-team-view" data-page="mcp">
        <PageHeader
          title="MCP"
          description={l("Your team's MCP servers, written into project files of connected working directories when the team pulls them. Credentials stay on each member's machine.", "团队共用的 MCP 服务，Pull 后写进已接入工作目录的项目配置；密钥由每位成员在本机提供。")}
          actions={switcher}
        />
        <PageBody><TeamResourceSection kind="mcp" language={language} onOpenTeamSpace={onOpenTeamSpace} /></PageBody>
      </div>
    );
  }
  return (
    <div className="automation-page automation-mcp-page" data-page="mcp">
      <AutomationPageState loading={loading} error={error} language={language} onRetry={() => void refresh()}>
        <McpPage language={language} headerExtra={switcher} />
      </AutomationPageState>
    </div>
  );
}
