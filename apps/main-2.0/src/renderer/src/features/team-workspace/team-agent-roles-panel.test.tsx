// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRole, AgentRoleChange } from "@agentrecall/workspace-core";
import type { AgentChannel, AppSnapshot, ConfiguredAgent } from "../../../../automation/contracts";
import type { TeamCatalog, TeamReply, TeamRequest } from "../../../../shared/ipc/team-workspace";
import { TeamAgentRolesPanel, type RoleAutomationApi } from "./team-agent-roles-panel";

const repository = "https://github.com/example/assets";
const team = { id: "example", name: "Example", repository };
const selection = { team, enabled: true, busy: false };
const role: AgentRole = { id: "reviewer", name: "Reviewer", description: "Reviews pull requests", path: "agents/reviewer.md", content: "# Reviewer\nCheck risks.", digest: "c".repeat(64), model: { runtime: "codex", family: "gpt-5", reasoningEffort: "high" }, skills: ["review"], mcpServers: [{ id: "github", tools: ["get_pr"] }], tags: ["review"] };
const catalog: TeamCatalog = { projectId: "", root: null, installed: [], notice: null, assets: { teamId: team.id, repository, commit: "1".repeat(40), skills: [{ id: "review", description: "Review code", files: 1, digest: "b".repeat(64) }], documents: [], workConfigs: [{ id: "frontend", name: "前端套装", description: "Legacy", skills: ["review"] }], organization: [], agentRoles: [role], workflowTemplates: [], outcomes: [], configuration: { instructions: [], environment: [], mcpServers: [{ id: "github", name: "GitHub", targets: ["codex"], transport: "http", url: "https://example.com/mcp", headers: { Authorization: { fromEnv: "GITHUB_TOKEN" } } }] } } };
const channels = [{ id: "personal", agentId: "codex", label: "Personal", models: [{ id: "o4-mini", label: "o4 mini" }, { id: "gpt-5-codex", label: "GPT-5 Codex", reasoningEfforts: ["low", "high"] }] }] as AgentChannel[];
const mine: ConfiguredAgent = { id: "mine", name: "My helper", description: "", instructions: "Be helpful.", runtimeAgentId: "claude", channelId: "secret-channel", modelId: "sonnet-4", mcpBindings: [{ serverId: "github", toolAllowlist: ["get_pr"] }, { serverId: "local-db", toolAllowlist: [] }], tags: [], createdAt: 1, updatedAt: 1 };
const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "catalog" ? { ok: true, data: { kind: "catalog", value: catalog } } : { ok: true, data: { kind: "cancelled" } });
let container: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); });
const button = (label: string) => { const value = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(label)); if (!value) throw new Error("Missing button " + label); return value; };
function automation(agents: ConfiguredAgent[]) {
  let current = agents;
  const snapshot = () => ({ configuredAgents: current, channels }) as unknown as AppSnapshot;
  return { getSnapshot: vi.fn(async () => snapshot()), saveConfiguredAgents: vi.fn(async (next: ConfiguredAgent[]) => { current = next; return snapshot(); }), testRuntimeChannel: vi.fn(async (channelId: string) => ({ agentId: "", ok: true, status: "passed" as const, message: "pong", elapsedMs: 5, testedAt: 1, runtimeAgentId: "codex" as const, channelId, modelId: "gpt-5-codex" })) } satisfies RoleAutomationApi;
}

it("enables a team role as a local Agent using a local channel that matches the model family", async () => {
  const local = automation([mine]);
  await act(async () => root.render(<TeamAgentRolesPanel language="zh" selection={selection} refreshKey={0} api={{ request }} automation={local} onStage={vi.fn()} />));
  expect(container.textContent).toContain("Reviewer");
  expect(container.textContent).toContain("未启用");
  expect(container.textContent).toContain("前端套装");
  expect(container.textContent).toContain("只读");
  await act(async () => button("Reviewer").click());
  expect(container.textContent).toContain("GitHub (get_pr)");
  await act(async () => button("启用到本机").click());
  expect(container.querySelector<HTMLSelectElement>('dialog select')?.value).toBe("personal");
  await act(async () => button("预检渠道").click());
  expect(local.testRuntimeChannel).toHaveBeenCalledWith("personal");
  expect(container.textContent).toContain("渠道预检通过：pong");
  await act(async () => container.querySelector<HTMLFormElement>("dialog form")!.requestSubmit());
  const saved = local.saveConfiguredAgents.mock.calls[0]![0];
  expect(saved[0]).toBe(mine);
  expect(saved[1]).toMatchObject({ name: "Reviewer", instructions: role.content, runtimeAgentId: "codex", channelId: "personal", modelId: "gpt-5-codex", reasoningEffort: "high", tags: ["review", "team-role:example/reviewer"] });
  expect(container.textContent).toContain("已启用");
});

it("publishes a local Agent as a role without its channel, keeping only MCP bindings the team provides", async () => {
  const onStage = vi.fn(async (_change: AgentRoleChange) => undefined);
  await act(async () => root.render(<TeamAgentRolesPanel language="zh" selection={selection} refreshKey={0} api={{ request }} automation={automation([mine])} onStage={onStage} />));
  await act(async () => button("新增角色").click());
  const select = container.querySelector<HTMLSelectElement>("dialog select")!;
  await act(async () => { select.value = "mine"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).toContain("以下 MCP 不在团队中，未加入角色：local-db");
  await act(async () => button("保存到共享空间").closest("form")!.requestSubmit());
  expect(onStage).toHaveBeenCalledWith({ kind: "agentRoles", operation: "create", value: { id: "my-helper", name: "My helper", description: "My helper", content: "Be helpful.", model: { runtime: "claude", family: "sonnet-4" }, skills: [], mcpServers: [{ id: "github", tools: ["get_pr"] }], tags: [] } });
  expect(JSON.stringify(onStage.mock.calls)).not.toContain("secret-channel");
});
