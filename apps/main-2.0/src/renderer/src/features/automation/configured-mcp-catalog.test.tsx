// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceConfig } from "@agentrecall/workspace-core";
import type { AgentMcpCatalog } from "../../../../shared/ipc/agent-mcp";
import type { TeamCatalog, TeamPayload, TeamReply, TeamRequest } from "../../../../shared/ipc/team-workspace";
import type { McpServerDefinition } from "../../../../automation/engine/shared/mcp/types";
import { ConfiguredMcpCatalog } from "./configured-mcp-catalog";

const repository = "https://github.com/example/assets";
const team = { id: "example", name: "Example", repository };
const config: WorkspaceConfig = { schemaVersion: 3, teamEnabled: true, defaultTeamId: null, teams: [team], projects: [], directories: [] };
const ok = (data: TeamPayload): TeamReply => ({ ok: true, data });
const teamCatalog = { projectId: "", root: null, installed: [], notice: null, assets: { teamId: team.id, repository, commit: "1".repeat(40), skills: [], configuration: { instructions: [], mcpServers: [{ id: "docs", name: "知识工具", transport: "http", url: "https://docs.example/mcp", headers: { Authorization: { fromEnv: "DOCS_AUTH" } }, targets: ["codex"] }], environment: [] }, documents: [], agentRoles: [], outcomes: [], organization: [] } } as unknown as TeamCatalog;
const teamApi = { request: vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "snapshot" ? ok({ kind: "snapshot", value: { config, directories: [], busy: false } }) : input.action === "catalog" ? ok({ kind: "catalog", value: teamCatalog }) : ok({ kind: "cancelled" })) };
const found: AgentMcpCatalog = {
  servers: [
    { name: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github", "--token", "[redacted]"], url: null, envNames: ["GITHUB_TOKEN"], headerNames: [], disabled: false, locations: [{ agent: "Codex", scope: "user", project: null, file: "/home/.codex/config.toml" }, { agent: "Claude Code", scope: "user", project: null, file: "/home/.claude.json" }] },
    { name: "browser", transport: "http", command: null, args: [], url: "https://browser.example/mcp", envNames: [], headerNames: ["Authorization"], disabled: true, locations: [{ agent: "Cursor", scope: "project", project: "/work/shop", file: "/work/shop/.cursor/mcp.json" }] },
  ],
  problems: [{ file: "/home/.gemini/settings.json", message: "settings.json is not valid JSON." }],
};

let container: HTMLDivElement, root: Root;
let openAgentMcpFile: ReturnType<typeof vi.fn>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Node 26 exposes an undefined `localStorage` global that shadows happy-dom's storage.
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, String(value)), removeItem: (key: string) => values.delete(key) });
  openAgentMcpFile = vi.fn(async () => undefined);
  Object.assign(window, { sessionSearch: { listAgentMcpServers: vi.fn(async () => found), openAgentMcpFile, revealAgentMcpFile: vi.fn(async () => undefined) } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

function button(label: string, scope: ParentNode = container) {
  const value = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label || item.querySelector(".catalog-item-title")?.textContent === label);
  if (!value) throw new Error(`Missing button ${label}`);
  return value;
}

it("lists servers agents configure per agent and project with team servers, hiding credential values", async () => {
  await act(async () => root.render(<ConfiguredMcpCatalog language="zh" switcher={null} teamApi={teamApi} />));
  expect([...container.querySelectorAll(".catalog-group h3 > span")].map((item) => item.textContent)).toEqual(["Agent 用户级", "shop", "团队 · Example"]);
  expect(container.querySelector(".catalog-head-meta")?.textContent).toBe("Agent 中 2 个 · 团队 1 个");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("settings.json is not valid JSON.");
  const detail = container.querySelector(".catalog-detail")!;
  expect(detail.querySelector("h3")?.textContent).toBe("github");
  expect(detail.querySelector(".catalog-code")?.textContent).toBe("npx -y @modelcontextprotocol/server-github --token [redacted]");
  expect(detail.textContent).toContain("GITHUB_TOKEN");
  expect([...detail.querySelectorAll(".catalog-locations code")].map((item) => item.textContent)).toEqual(["/home/.codex/config.toml", "/home/.claude.json"]);
  expect(container.querySelector("textarea, input:not([type=search])")).toBeNull();

  await act(async () => button("browser").click());
  expect(container.querySelector(".catalog-item[aria-current] .catalog-item-trailing")?.textContent).toBe("已关闭");
  await act(async () => button("用编辑器打开", container.querySelector(".catalog-detail-actions")!).click());
  expect(openAgentMcpFile).toHaveBeenCalledWith("/work/shop/.cursor/mcp.json");
  openAgentMcpFile.mockRejectedValueOnce(new Error("Error invoking remote method 'agent-mcp:open': Error: Could not open mcp.json: no app"));
  await act(async () => button("用编辑器打开", container.querySelector(".catalog-detail-actions")!).click());
  expect(container.querySelector(".catalog-detail [role=alert]")?.textContent).toBe("Could not open mcp.json: no app");
});

it("adds a team server as a tool source and filters by search", async () => {
  const toolSources = { listMcpServers: vi.fn(async () => [] as McpServerDefinition[]), saveMcpServer: vi.fn(async (server: McpServerDefinition) => server) };
  const onOpenTeamSpace = vi.fn();
  await act(async () => root.render(<ConfiguredMcpCatalog language="zh" switcher={null} teamApi={teamApi} toolSources={toolSources} onOpenTeamSpace={onOpenTeamSpace} />));
  await act(async () => button("知识工具").click());
  await act(async () => button("加为工具源").click());
  expect(toolSources.saveMcpServer).toHaveBeenCalledWith(expect.objectContaining({ id: "team-example-docs", headers: { Authorization: "DOCS_AUTH" }, enabled: false }));
  expect(container.querySelector(".catalog-detail [role=status]")?.textContent).toContain("已把「知识工具」加为工具源");
  await act(async () => button("去团队空间编辑").click());
  expect(onOpenTeamSpace).toHaveBeenCalledOnce();

  const search = container.querySelector<HTMLInputElement>("input[type=search]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "cursor");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect([...container.querySelectorAll(".catalog-item-title")].map((item) => item.textContent)).toEqual(["browser"]);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "nothing-like-this");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector(".catalog-list-empty")?.textContent).toBe("没有匹配的 MCP 服务。");
});
