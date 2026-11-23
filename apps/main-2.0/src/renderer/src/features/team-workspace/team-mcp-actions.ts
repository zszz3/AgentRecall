import { useEffect, useState } from "react";
import type { McpServerDefinition } from "../../../../automation/engine/shared/mcp/types";
import type { AutomationApi } from "../../../../preload/automation";
import type { LanguageMode } from "../../language";
import type { TeamResourceCopy, TeamResourceShare } from "./team-configuration-panel";
import { teamMcpFromToolSource, teamMcpToolSource } from "./team-mcp-tool-source";

export type ToolSourceApi = Pick<AutomationApi, "listMcpServers" | "saveMcpServer">;

/**
 * How team MCP servers and the member's AgentRecall tool sources move between each other:
 * `copy` adds a team server as a tool source, `share` offers the member's own tool sources as
 * drafts for the team. Tool sources are read only while `loadSources` is on.
 */
export function useTeamMcpActions(language: LanguageMode, loadSources: boolean, automation?: ToolSourceApi): { copy: TeamResourceCopy; share: TeamResourceShare } {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  // Resolved on use so pages that never touch MCP render without the automation bridge.
  const tools = (): ToolSourceApi => automation ?? window.sessionSearch.automation;
  const [toolSources, setToolSources] = useState<McpServerDefinition[]>([]);
  useEffect(() => {
    if (!loadSources) return;
    let active = true;
    // Without the list sharing only has nothing to offer; the team's servers still show.
    void tools().listMcpServers().then((servers) => { if (active) setToolSources(servers.filter((server) => !server.managed)); }, () => undefined);
    return () => { active = false; };
  }, [automation, loadSources]);
  const copy: TeamResourceCopy = {
    label: l("Add as tool source", "加为工具源"),
    run: async (change, team) => {
      if (change.kind !== "mcp") throw new Error(l("Only MCP servers can be added here.", "这里只能加入 MCP 服务。"));
      const converted = teamMcpToolSource(change.value, team, Date.now());
      if (!converted.ok) throw new Error(l(
        `${converted.fixed.join(", ")} of "${change.value.name}" are fixed values. Tool sources only name local environment variables, so add it by hand under Tool sources.`,
        `「${change.value.name}」的 ${converted.fixed.join("、")} 是固定值，工具源只能引用本机环境变量，请在 MCP 页的「工具源」里手动添加。`,
      ));
      if ((await tools().listMcpServers()).some((server) => server.id === converted.server.id)) {
        return l(`"${change.value.name}" is already a tool source.`, `「${change.value.name}」已经是工具源。`);
      }
      await tools().saveMcpServer(converted.server);
      return l(
        `Added "${change.value.name}" as a tool source. It starts off; test it on the MCP page, then turn it on.`,
        `已把「${change.value.name}」加为工具源，默认关闭；请在 MCP 页测试连接后再开启。`,
      );
    },
  };
  // Sharing opens the team editor with a draft; secrets stay local variable names and nothing is staged until the member saves.
  const share: TeamResourceShare = {
    label: l("Share a tool source", "从工具源添加"),
    choices: !toolSources.length ? [{ key: "none", label: l("No tool sources of your own yet", "还没有自定义工具源"), problem: l("Add one on the MCP page first.", "先在 MCP 页的「工具源」里添加。") }] : toolSources.map((server) => {
      const converted = teamMcpFromToolSource(server);
      const hint = server.transport === "http" ? server.url : server.command;
      return converted.ok
        ? { key: server.id, label: server.name, hint, change: { kind: "mcp", operation: "create", value: converted.value } }
        : { key: server.id, label: server.name, problem: l(`${converted.variable} reads the local variable ${converted.reads}; team servers can only reference a variable of the same name.`, `${converted.variable} 读取的是本机变量 ${converted.reads}；团队 MCP 只能引用同名变量。`) };
    }),
  };
  return { copy, share };
}
