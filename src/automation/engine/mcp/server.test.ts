import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RUNTIME_IDS } from "../shared/runtime-catalog";
import { callMcpTool, mcpToolDefinitions, resolveBridgeDiscoveryPath } from "./server";

const originalEnv = process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE;
describe("MCP server tools", () => {
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE;
    else process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = originalEnv;
    vi.restoreAllMocks();
  });

  test("exposes workflow tools from the agent-level MCP service", () => {
    expect(mcpToolDefinitions().map((tool) => tool.name)).toEqual([
      "agent_templates_list",
      "skill_templates_list",
      "agents_list",
      "agents_create",
      "agents_update",
      "agents_delete",
      "agents_test",
      "channels_list",
      "models_list",
      "workflow_create",
      "workflow_list",
      "workflow_get",
      "workflow_update",
      "workflow_validate",
      "workflow_context_append",
      "workflow_run_context_append",
    ]);
  });

  test("derives runtime enums from the canonical runtime catalog", () => {
    const tools = mcpToolDefinitions();
    for (const toolName of ["agents_create", "agents_update", "channels_list", "models_list", "workflow_create"]) {
      const tool = tools.find((item) => item.name === toolName);
      const properties = (tool?.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
      const field = toolName === "agents_create" || toolName === "agents_update" ? "runtimeAgentId" : "agentId";
      expect(properties[field]?.enum).toEqual(RUNTIME_IDS);
    }
  });

  test("requires workflow_create to submit an explicit Workflow V2 definition with execution modes", () => {
    const tool = mcpToolDefinitions().find((item) => item.name === "workflow_create")!;
    expect(tool.inputSchema.required).toContain("workflowId");
    expect(tool.inputSchema.required).toContain("definition");
    const definition = (tool.inputSchema.properties as any).definition;
    expect(definition.required).toEqual(["workflowId", "graphVersion", "objective", "nodes", "edges"]);
    expect(definition.properties.nodes.items.required).toContain("executionMode");
    expect(definition.properties.nodes.items.properties.executionMode.enum).toEqual(["one-shot", "interactive", "script"]);
  });

  test("uses env override for bridge discovery", () => {
    process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = "/tmp/custom-bridge.json";

    expect(resolveBridgeDiscoveryPath()).toBe("/tmp/custom-bridge.json");
  });


  test("serves workflow tools from the long-lived agent stdio server", async () => {
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const serverPath = path.resolve("src", "automation", "engine", "mcp", "server.ts");
    const child = spawn(process.execPath, [tsxCli, serverPath], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_RECALL_WORKFLOW_MCP_BRIDGE: path.join(os.tmpdir(), "missing-mcp-bridge.json") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const response = await new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP stdio response timed out")), 5_000);
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        const newlineIndex = output.indexOf("\n");
        if (newlineIndex < 0) return;
        clearTimeout(timer);
        resolve(JSON.parse(output.slice(0, newlineIndex)));
      });
      child.once("error", reject);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
    }).finally(() => child.kill());

    expect(response.result.tools.map((tool: { name: string }) => tool.name)).toContain("workflow_create");
  });

  test("calls bridge endpoints with discovery token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-mcp-server-"));
    const discoveryPath = path.join(dir, "bridge.json");
    process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = discoveryPath;
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: 48123, token: "secret" }), "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, workflowId: "wf_1" }),
    } as Response);

    const result = await callMcpTool("agents_create", { id: "reviewer", name: "Reviewer" });

    expect(result).toEqual({ ok: true, workflowId: "wf_1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48123/mcp/agents/create",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
      }),
    );
  });

  test("forwards workflowId as an explicit workflow tool argument", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-mcp-workflow-id-"));
    const discoveryPath = path.join(dir, "bridge.json");
    process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = discoveryPath;
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: 48124, token: "secret" }), "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, workflowId: "wf-explicit" }),
    } as Response);

    await callMcpTool("workflow_create", {
      workflowId: "wf-explicit",
      title: "Explicit route",
      objective: "Route by id",
      definition: { workflowId: "wf-explicit", graphVersion: 1, objective: "Route by id", nodes: [], edges: [] },
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ workflowId: "wf-explicit" });
    expect(String(request.body)).not.toContain("__workflowContextId");
  });

});
