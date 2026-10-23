// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRole, WorkflowTemplate, WorkflowTemplateChange } from "@agentrecall/workspace-core";
import type { AppSnapshot, ConfiguredAgent } from "../../../../automation/contracts";
import type { WorkflowCoreSnapshot, WorkflowDefinition } from "../../../../automation/engine/shared/workflow/model";
import type { TeamCatalog, TeamReply, TeamRequest } from "../../../../shared/ipc/team-workspace";
import { TeamWorkflowTemplatesPanel, type TemplateAutomationApi } from "./team-workflow-templates-panel";

const repository = "https://github.com/example/assets";
const team = { id: "example", name: "Example", repository };
const selection = { team, enabled: true, busy: false };
const role: AgentRole = { id: "reviewer", name: "Reviewer", description: "", path: "agents/reviewer.md", content: "Review.", digest: "c".repeat(64), model: { runtime: "codex" }, skills: [], mcpServers: [], tags: [] };
const output = [{ key: "result", label: "Result", type: "string", required: true }];
const content = JSON.stringify({ schemaVersion: 1, inputs: [], nodes: [
  { id: "review", kind: "agent", title: "Review the change", role: "reviewer", goal: "Review", inputs: [], outputs: output, acceptanceCriteria: [], instructions: [], constraints: [] },
  { id: "lint", kind: "script", title: "Run lint", runtime: "bash", source: "npm run lint", timeoutSeconds: 60, permissions: ["workspace_read", "process"], goal: "Lint", inputs: [], outputs: output, acceptanceCriteria: [] },
] });
const template: WorkflowTemplate = { id: "pr-review", name: "PR review", description: "Review and lint", path: "workflows/pr-review.json", content, digest: "d".repeat(64) };
const catalog: TeamCatalog = { projectId: "", root: null, installed: [], notice: null, assets: { teamId: team.id, repository, commit: "1".repeat(40), skills: [], documents: [], workConfigs: [], organization: [], agentRoles: [role], workflowTemplates: [template], configuration: { instructions: [], environment: [], mcpServers: [] } } };
const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "catalog" ? { ok: true, data: { kind: "catalog", value: catalog } } : { ok: true, data: { kind: "cancelled" } });
const enabled: ConfiguredAgent = { id: "team-role-example-reviewer", name: "Reviewer", description: "", instructions: "Review.", runtimeAgentId: "codex", channelId: "personal", modelId: "gpt-5", tags: ["team-role:example/reviewer"], createdAt: 1, updatedAt: 1 };
const personal: ConfiguredAgent = { ...enabled, id: "mine", name: "My helper", tags: [] };
let container: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); });
const button = (label: string) => { const value = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(label)); if (!value) throw new Error("Missing button " + label); return value; };
function automation(agents: ConfiguredAgent[], workflows: WorkflowDefinition[] = []) {
  let current = workflows;
  return {
    getSnapshot: vi.fn(async () => ({ configuredAgents: agents }) as unknown as AppSnapshot),
    getWorkflowCore: vi.fn(async () => ({ definitions: current, runs: [] }) as unknown as WorkflowCoreSnapshot),
    saveWorkflowDefinition: vi.fn(async (definition: WorkflowDefinition) => { current = [...current, definition]; return definition; }),
  } satisfies TemplateAutomationApi;
}

it("creates a personal Workflow from a team template only after its roles are enabled locally", async () => {
  const missing = automation([personal]);
  await act(async () => root.render(<TeamWorkflowTemplatesPanel language="zh" selection={selection} refreshKey={0} api={{ request }} automation={missing} onStage={vi.fn()} />));
  expect(container.textContent).toContain("2 个节点 · Reviewer · 1 个脚本");
  await act(async () => button("PR review").click());
  expect(container.querySelector("pre")?.textContent).toBe("npm run lint");
  await act(async () => button("使用模板").click());
  expect(container.textContent).toContain("请先在「Agent 角色」中启用这些角色：Reviewer。");
  expect(missing.saveWorkflowDefinition).not.toHaveBeenCalled();

  const local = automation([enabled]);
  await act(async () => root.render(<TeamWorkflowTemplatesPanel language="zh" selection={selection} refreshKey={1} api={{ request }} automation={local} onStage={vi.fn()} />));
  await act(async () => button("使用模板").click());
  const saved = local.saveWorkflowDefinition.mock.calls[0]![0];
  expect(saved.nodes[0]).toMatchObject({ id: "review", agentId: "team-role-example-reviewer" });
  expect(saved.nodes[0]).not.toHaveProperty("role");
  expect(saved.origin).toMatchObject({ kind: "team-template", teamId: "example", repository, templateId: "pr-review", digest: template.digest });
  expect(saved.origin?.scriptsConfirmedAt).toBeUndefined();
  expect(container.textContent).toContain("首次运行前需要在 Workflow 页确认其中的脚本。");
  expect(container.textContent).toContain("已使用");
});

it("publishes a personal Workflow as role references and refuses Agents that were not enabled from a role", async () => {
  const node = (id: string, agentId: string) => ({ id, kind: "agent", title: id, agentId, goal: id, inputs: [], outputs: output, acceptanceCriteria: [], instructions: [], constraints: [] });
  const shareable = { id: "workflow_1", name: "Ship", description: "Ship it", inputs: [], nodes: [node("review", enabled.id)], createdAt: 1, updatedAt: 1, workDir: "/Users/me/project" } as unknown as WorkflowDefinition;
  const local = { ...shareable, id: "workflow_2", name: "Local", nodes: [node("help", personal.id)] } as unknown as WorkflowDefinition;
  const onStage = vi.fn(async (_change: WorkflowTemplateChange) => undefined);
  await act(async () => root.render(<TeamWorkflowTemplatesPanel language="zh" selection={selection} refreshKey={0} api={{ request }} automation={automation([enabled, personal], [local, shareable])} onStage={onStage} />));
  await act(async () => button("发布个人 Workflow").click());
  expect(container.textContent).toContain("这些 Agent 不是从团队角色启用的，其他成员无法运行：My helper（help）");
  expect(button("保存到共享空间").disabled).toBe(true);
  const select = container.querySelector<HTMLSelectElement>("dialog select")!;
  await act(async () => { select.value = "workflow_1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).toContain("使用的角色：Reviewer");
  await act(async () => button("保存到共享空间").closest("form")!.requestSubmit());
  const change = onStage.mock.calls[0]![0];
  expect(change).toMatchObject({ kind: "workflowTemplates", operation: "create", value: { name: "Ship", description: "Ship it" } });
  const published = JSON.parse(change.value.content);
  expect(published.nodes[0]).toMatchObject({ id: "review", role: "reviewer" });
  expect(change.value.content).not.toContain(enabled.id);
  expect(change.value.content).not.toContain("/Users/me/project");
});
