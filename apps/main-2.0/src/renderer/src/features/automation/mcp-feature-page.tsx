import { useState, type ReactElement } from "react";
import { McpPage } from "../../../../automation/engine/renderer/src/pages/mcp/McpPage";
import type { LanguageMode } from "../../language";
import { PageBody, PageHeader, Segmented } from "../../ui/primitives";
import { TeamResourceSection } from "../team-workspace/team-resource-section";
import type { TeamResourceCopy } from "../team-workspace/team-configuration-panel";
import { teamMcpToolSource } from "../team-workspace/team-mcp-tool-source";
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
  const addAsToolSource: TeamResourceCopy = {
    label: l("Add as tool source", "加为工具源"),
    run: async (change, team) => {
      if (change.kind !== "mcp") throw new Error(l("Only MCP servers can be added here.", "这里只能加入 MCP 服务。"));
      const converted = teamMcpToolSource(change.value, team, Date.now());
      if (!converted.ok) throw new Error(l(
        `${converted.fixed.join(", ")} of "${change.value.name}" are fixed values. Tool sources only name local environment variables, so add it by hand under Tool sources.`,
        `「${change.value.name}」的 ${converted.fixed.join("、")} 是固定值，工具源只能引用本机环境变量，请在「工具源」里手动添加。`,
      ));
      const automation = window.sessionSearch.automation;
      if ((await automation.listMcpServers()).some((server) => server.id === converted.server.id)) {
        return l(`"${change.value.name}" is already a tool source.`, `「${change.value.name}」已经是工具源。`);
      }
      await automation.saveMcpServer(converted.server);
      return l(
        `Added "${change.value.name}" as a tool source. It starts off; test it under Tool sources, then turn it on.`,
        `已把「${change.value.name}」加为工具源，默认关闭；请在「工具源」里测试连接后再开启。`,
      );
    },
  };
  if (view === "team") {
    return (
      <div className="automation-page automation-mcp-page mcp-team-view" data-page="mcp">
        <PageHeader
          title="MCP"
          description={l("Your team's MCP servers, written into project files of connected working directories when the team pulls them. Credentials stay on each member's machine.", "团队共用的 MCP 服务，Pull 后写进已接入工作目录的项目配置；密钥由每位成员在本机提供。")}
          actions={switcher}
        />
        <PageBody><TeamResourceSection kind="mcp" language={language} onOpenTeamSpace={onOpenTeamSpace} copy={addAsToolSource} /></PageBody>
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
