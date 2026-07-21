import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runtimeDefinition } from "../../shared/runtime-catalog";
import { AgentHub } from "../hub/agent-hub";
import { startMcpBridge, type McpBridgeServer } from "./mcp-bridge";

let bridge: McpBridgeServer | undefined;

async function stopBridge(): Promise<void> {
  if (!bridge) return;
  await bridge.stop();
  bridge = undefined;
}

async function bridgeRequest(route: string, token: string, body: unknown): Promise<Response> {
  if (!bridge) throw new Error("bridge not started");
  return fetch(`http://${bridge.host}:${bridge.port}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("MCP bridge", () => {
  afterEach(async () => {
    await stopBridge();
  });

  test("starts on a dynamic localhost port and writes discovery metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-mcp-"));
    const discoveryPath = path.join(dir, "bridge.json");

    bridge = await startMcpBridge(new AgentHub(), { discoveryPath });

    expect(bridge.host).toBe("127.0.0.1");
    expect(bridge.port).toBeGreaterThan(0);
    expect(bridge.token).toHaveLength(64);
    const discovery = JSON.parse(await readFile(discoveryPath, "utf8")) as any;
    expect(discovery).toMatchObject({
      host: "127.0.0.1",
      port: bridge.port,
      token: bridge.token,
    });
  });

  test("registers an artifact for a validated file via the bridge", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-mcp-artifacts-"));
    const discoveryPath = path.join(dir, "bridge.json");
    await writeFile(path.join(dir, "report.md"), "# Report", "utf8");
    const hub = new AgentHub();
    hub.setWorkDir(dir);
    bridge = await startMcpBridge(hub, { discoveryPath });

    const okResponse = await bridgeRequest("/mcp/artifacts/register", bridge.token, {
      target: "chat-1",
      path: "report.md",
      description: "final report",
    });
    expect(okResponse.status).toBe(200);
    const okPayload = (await okResponse.json()) as any;
    expect(okPayload).toMatchObject({ ok: true, artifact: { target: "chat-1", kind: "file", title: "report.md" } });

    const listResponse = await bridgeRequest("/mcp/artifacts/list", bridge.token, { target: "chat-1" });
    const listPayload = (await listResponse.json()) as any;
    expect(listPayload.artifacts).toHaveLength(1);

    const missingResponse = await bridgeRequest("/mcp/artifacts/register", bridge.token, { target: "chat-1", path: "nope.md" });
    const missingPayload = (await missingResponse.json()) as any;
    expect(missingPayload.ok).toBe(false);
  });

  test("requires bearer token and exposes workflow tools", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-mcp-"));
    const bundledSkillsRoot = path.join(dir, "bundled-skills");
    const hub = new AgentHub();
    hub.updateConfiguredAgents([
      {
        id: "repo-reviewer",
        name: "Repo Reviewer",
        description: "Reviews repos and writes docs.",
        runtimeAgentId: "codex",
        channelId: "codex-openai",
        modelId: "default",
        tags: ["review"],
        createdAt: 1710000000000,
        updatedAt: 1710000000000,
      },
    ]);
    const fetcher = async (url: string | URL | Request) => {
      const href = String(url);
      if (href.startsWith("https://skills.sh/api/search")) return new Response(JSON.stringify({ skills: [] }));
      if (href === "https://api.github.com/repos/anthropics/skills") return new Response(JSON.stringify({ stargazers_count: 13200 }));
      if (href === "https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1") {
        return new Response(
          JSON.stringify({
            tree: [
              {
                path: "skills/frontend-design/SKILL.md",
                type: "blob",
              },
            ],
          }),
        );
      }
      if (href === "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md") {
        return new Response(
          [
            "---",
            "name: frontend-design",
            "description: Guidance for distinctive, intentional visual design.",
            "---",
            "# Frontend Design",
          ].join("\n"),
        );
      }
      return new Response("not found", { status: 404 });
    };
    bridge = await startMcpBridge(hub, { discoveryPath: path.join(dir, "bridge.json"), bundledSkillsRoot, fetcher });
    const hermesChannelId = runtimeDefinition("hermes").defaultChannel.id;

    const unauthorized = await fetch(`http://${bridge.host}:${bridge.port}/mcp/workflow/list`, { method: "POST" });
    expect(unauthorized.status).toBe(401);

    const agents = (await (await bridgeRequest("/mcp/agents/list", bridge.token, {})).json()) as any;
    expect(agents).toMatchObject({ ok: true });
    expect(agents.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "default-agent", name: "Codex OpenAI", runtimeAgentId: "codex" }),
        expect.objectContaining({ id: "repo-reviewer", name: "Repo Reviewer", runtimeAgentId: "codex" }),
      ]),
    );
    expect(JSON.stringify(agents)).not.toContain("prompt");

    const templates = (await (await bridgeRequest("/mcp/agent-templates/list", bridge.token, {})).json()) as any;
    expect(templates).toMatchObject({
      ok: true,
      templates: expect.arrayContaining([expect.objectContaining({ id: "refactor-review-knowledge", name: "refactor-review-knowledge" })]),
    });
    const skillTemplates = (await (await bridgeRequest("/mcp/skill-templates/list", bridge.token, {})).json()) as any;
    expect(skillTemplates).toMatchObject({
      ok: true,
      templates: expect.arrayContaining([expect.objectContaining({ id: "brainstorming", sourcePath: "src/shared/bundled-skills/brainstorming/SKILL.md" })]),
    });

    const skillSearch = (await (await bridgeRequest("/mcp/skills/search-online", bridge.token, { query: "frontend design anthropic" })).json()) as any;
    expect(skillSearch).toMatchObject({
      ok: true,
      results: expect.arrayContaining([expect.objectContaining({ name: "frontend-design", sourceLabel: "Anthropic Skills" })]),
    });
    const onlineSkill = skillSearch.results.find((skill: any) => skill.name === "frontend-design");
    const importedSkill = (await (await bridgeRequest("/mcp/skills/import-online", bridge.token, onlineSkill)).json()) as any;
    expect(importedSkill).toMatchObject({
      ok: true,
      template: expect.objectContaining({ id: "frontend-design", name: "frontend-design" }),
    });
    expect(importedSkill.path).toContain(path.join("bundled-skills", "frontend-design", "SKILL.md"));
    const importedSkillList = (await (await bridgeRequest("/mcp/skills/imported/list", bridge.token, {})).json()) as any;
    expect(importedSkillList).toMatchObject({
      ok: true,
      templates: expect.arrayContaining([expect.objectContaining({ id: "frontend-design", name: "frontend-design" })]),
    });

    const channels = (await (await bridgeRequest("/mcp/channels/list", bridge.token, { agentId: "codex" })).json()) as any;
    expect(channels).toMatchObject({
      ok: true,
      channels: [expect.objectContaining({ id: "codex-openai", agentId: "codex", models: expect.any(Array) })],
    });
    expect(JSON.stringify(channels)).not.toContain("httpHeaders");
    expect(JSON.stringify(channels)).not.toContain("Bearer");

    const hermesChannels = (await (await bridgeRequest("/mcp/channels/list", bridge.token, { agentId: "hermes" })).json()) as any;
    expect(hermesChannels).toMatchObject({
      ok: true,
      channels: [expect.objectContaining({ id: hermesChannelId, agentId: "hermes" })],
    });

    const models = (await (await bridgeRequest("/mcp/models/list", bridge.token, { channelId: "codex-openai" })).json()) as any;
    expect(models).toMatchObject({
      ok: true,
      channels: [expect.objectContaining({ channelId: "codex-openai", models: expect.any(Array) })],
    });

    const createdAgent = (await (await bridgeRequest("/mcp/agents/create", bridge.token, {
      id: "doc-writer",
      name: "Doc Writer",
      runtimeAgentId: "codex",
      channelId: "codex-openai",
      modelId: "default",
      tags: ["docs"],
    })).json()) as any;
    expect(createdAgent).toMatchObject({
      ok: true,
      agent: {
        id: "doc-writer",
        name: "Doc Writer",
        runtimeAgentId: "codex",
        channelId: "codex-openai",
        modelId: "default",
        tags: ["docs"],
      },
    });
    expect(createdAgent.agent).not.toHaveProperty("prompt");

    const hermesAgent = (await (await bridgeRequest("/mcp/agents/create", bridge.token, {
      id: "hermes-reviewer",
      name: "Hermes Reviewer",
      runtimeAgentId: "hermes",
      channelId: hermesChannelId,
      modelId: "default",
    })).json()) as any;
    expect(hermesAgent).toMatchObject({
      ok: true,
      agent: {
        id: "hermes-reviewer",
        runtimeAgentId: "hermes",
        channelId: hermesChannelId,
      },
    });

    const updatedAgent = (await (await bridgeRequest("/mcp/agents/update", bridge.token, {
      agentId: "doc-writer",
      description: "Writes polished docs.",
      tags: ["docs", "writer"],
    })).json()) as any;
    expect(updatedAgent).toMatchObject({
      ok: true,
      agent: {
        id: "doc-writer",
        description: "Writes polished docs.",
        tags: ["docs", "writer"],
      },
    });

    const deletedAgent = (await (await bridgeRequest("/mcp/agents/delete", bridge.token, { agentId: "doc-writer" })).json()) as any;
    expect(deletedAgent).toMatchObject({ ok: true, agentId: "doc-writer" });
    expect(deletedAgent.agents.some((agent: any) => agent.id === "doc-writer")).toBe(false);

    const planningWorkflow = hub.createWorkflowDraft().workflowDraft!;
    const create = await bridgeRequest("/mcp/workflow/create", bridge.token, {
      workflowId: planningWorkflow.workflowId,
      title: "Review workflow",
      objective: "Review example service",
      definition: {
        workflowId: planningWorkflow.workflowId,
        graphVersion: 1,
        objective: "Review example service",
        nodes: [{ id: "review", kind: "agent", title: "Review", execModel: "llm",
        executionMode: "one-shot", prompt: "Review code.", outputFields: [{ key: "result", required: true }] }],
        edges: [],
      },
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as any;
    expect(created).toMatchObject({ ok: true, workflowId: planningWorkflow.workflowId });

    const secondPlanningWorkflow = hub.createWorkflowDraft().workflowDraft!;
    const secondCreate = await bridgeRequest("/mcp/workflow/create", bridge.token, {
      workflowId: secondPlanningWorkflow.workflowId,
      title: "Second workflow",
      objective: "Route a second planning session",
      definition: {
        workflowId: secondPlanningWorkflow.workflowId,
        graphVersion: 1,
        objective: "Route a second planning session",
        nodes: [{ id: "route", kind: "agent", title: "Route", execModel: "llm", executionMode: "one-shot", prompt: "Route it.", outputFields: [{ key: "result", required: true }] }],
        edges: [],
      },
    });
    expect(await secondCreate.json()).toMatchObject({ ok: true, workflowId: secondPlanningWorkflow.workflowId });

    const mismatchedCreate = await bridgeRequest("/mcp/workflow/create", bridge.token, {
      workflowId: planningWorkflow.workflowId,
      title: "Wrong route",
      objective: "Must fail",
      definition: { workflowId: secondPlanningWorkflow.workflowId, graphVersion: 1, objective: "Must fail", nodes: [], edges: [] },
    });
    expect(await mismatchedCreate.json()).toMatchObject({ ok: false, error: "workflow_create workflowId must match definition.workflowId." });

    const list = (await (await bridgeRequest("/mcp/workflow/list", bridge.token, {})).json()) as any;
    expect(list.workflows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workflowId: created.workflowId,
        title: "Review workflow",
        status: "draft",
        revision: created.revision,
        nodeCount: 1,
      }),
      expect.objectContaining({ workflowId: secondPlanningWorkflow.workflowId, title: "Second workflow" }),
    ]));

    const context = await bridgeRequest("/mcp/workflow/context/append", bridge.token, {
      workflowId: created.workflowId,
      report: "Reviewed the service.",
      handoff: "Writer can produce the summary.",
      artifacts: [{ kind: "text", title: "Finding", content: "No blockers." }],
    });
    expect(await context.json()).toMatchObject({ ok: true, workflowId: created.workflowId, revision: created.revision + 1 });

    const get = (await (await bridgeRequest("/mcp/workflow/get", bridge.token, { workflowId: created.workflowId })).json()) as any;
    expect(get.workflow.contextDocument).toContain("Reviewed the service.");
  });
});
