import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RUNTIME_IDS } from "../shared/runtime-catalog";
import { callMcpTool, mcpToolDefinitions, resolveBridgeDiscoveryPath } from "./server";

const originalEnv = process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE;
const originalManagedToken = process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN;
const originalWorkflowId = process.env.AGENT_RECALL_WORKFLOW_ID;
const originalRunId = process.env.AGENT_RECALL_WORKFLOW_RUN_ID;
const originalNodeId = process.env.AGENT_RECALL_WORKFLOW_NODE_ID;
const originalExecutionId = process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID;
const originalScope = process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE;
describe("MCP server tools", () => {
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE;
    else process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = originalEnv;
    if (originalManagedToken === undefined) delete process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN;
    else process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN = originalManagedToken;
    if (originalWorkflowId === undefined) delete process.env.AGENT_RECALL_WORKFLOW_ID;
    else process.env.AGENT_RECALL_WORKFLOW_ID = originalWorkflowId;
    if (originalRunId === undefined) delete process.env.AGENT_RECALL_WORKFLOW_RUN_ID;
    else process.env.AGENT_RECALL_WORKFLOW_RUN_ID = originalRunId;
    if (originalNodeId === undefined) delete process.env.AGENT_RECALL_WORKFLOW_NODE_ID;
    else process.env.AGENT_RECALL_WORKFLOW_NODE_ID = originalNodeId;
    if (originalExecutionId === undefined) delete process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID;
    else process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID = originalExecutionId;
    if (originalScope === undefined) delete process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE;
    else process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = originalScope;
    vi.restoreAllMocks();
  });

  test("exposes only read tools to standalone discovery clients", () => {
    delete process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN;
    expect(mcpToolDefinitions().map((tool) => tool.name)).toEqual([
      "agent_templates_list",
      "skill_templates_list",
      "agents_list",
      "channels_list",
      "models_list",
      "workflow_list",
      "workflow_get",
      "workflow_validate",
      "workflow_run_list",
      "workflow_run_get",
      "workflow_outputs_list",
    ]);
  });

  test("exposes lifecycle writes only to managed MCP sessions", () => {
    process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN = "managed-token";
    process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = "planning";

    expect(mcpToolDefinitions().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "workflow_create",
      "workflow_confirm",
      "workflow_run",
      "workflow_stop",
      "workflow_intervention_resolve",
      "workflow_script_input_submit",
    ]));
  });

  test("limits managed node sessions to node execution tools", () => {
    process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN = "managed-token";
    process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = "node_execution";
    process.env.AGENT_RECALL_WORKFLOW_RUN_ID = "run-1";
    process.env.AGENT_RECALL_WORKFLOW_NODE_ID = "node-1";
    process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID = "execution-1";

    const names = mcpToolDefinitions().map((tool) => tool.name);
    expect(names).toContain("workflow_node_complete");
    expect(names).toContain("workflow_run_get");
    expect(names).not.toContain("workflow_update");
    expect(names).not.toContain("workflow_stop");
  });

  test("publishes strict lifecycle filter and completion schemas", () => {
    process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN = "managed-token";
    process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = "node_execution";
    process.env.AGENT_RECALL_WORKFLOW_RUN_ID = "run-1";
    process.env.AGENT_RECALL_WORKFLOW_NODE_ID = "node-1";
    process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID = "execution-1";
    const tools = mcpToolDefinitions();
    const runList = tools.find((tool) => tool.name === "workflow_run_list")!;
    const runProperties = runList.inputSchema.properties as Record<string, any>;
    expect(runProperties.status.enum).toEqual(["draft", "running", "waiting_for_user", "completed", "failed", "stopped"]);
    expect(runProperties.startedAfter.minimum).toBe(0);
    expect(runProperties.startedBefore.minimum).toBe(0);

    const completion = tools.find((tool) => tool.name === "workflow_node_complete")!;
    const proposals = (completion.inputSchema.properties as Record<string, any>).proposals;
    expect(proposals.items.oneOf).toHaveLength(4);
  });

  test("derives runtime enums from the canonical runtime catalog", () => {
    process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN = "managed-token";
    const tools = mcpToolDefinitions();
    for (const toolName of ["agents_create", "agents_update", "channels_list", "models_list", "workflow_create"]) {
      const tool = tools.find((item) => item.name === toolName);
      const properties = (tool?.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
      const field = toolName === "agents_create" || toolName === "agents_update" ? "runtimeAgentId" : "agentId";
      expect(properties[field]?.enum).toEqual(RUNTIME_IDS);
    }
  });

  test("requires workflow_create to submit an explicit Workflow V2 definition with execution modes", () => {
    process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN = "managed-token";
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
    const serverPath = path.resolve("src", "mcp", "workflow-entry.ts");
    const child = spawn(process.execPath, [tsxCli, serverPath], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_RECALL_WORKFLOW_MCP_BRIDGE: path.join(os.tmpdir(), "missing-mcp-bridge.json"), AGENT_RECALL_WORKFLOW_MCP_TOKEN: "" },
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

    expect(response.result.tools.map((tool: { name: string }) => tool.name)).toContain("workflow_run_list");
    expect(response.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("workflow_create");
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

    const result = await callMcpTool("workflow_run_list", {});

    expect(result).toEqual({ ok: true, workflowId: "wf_1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48123/mcp/workflow/run/list",
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

  test("injects the bound execution identity into node completion requests", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-mcp-completion-id-"));
    const discoveryPath = path.join(dir, "bridge.json");
    process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = discoveryPath;
    process.env.AGENT_RECALL_WORKFLOW_ID = "wf-1";
    process.env.AGENT_RECALL_WORKFLOW_RUN_ID = "run-1";
    process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID = "execution-1";
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: 48125, token: "secret" }), "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    await callMcpTool("workflow_node_complete", { nodeId: "node-1", summary: "Done", outputs: {}, proposals: [] });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      workflowId: "wf-1",
      runId: "run-1",
      nodeId: "node-1",
      executionId: "execution-1",
    });
  });

});
