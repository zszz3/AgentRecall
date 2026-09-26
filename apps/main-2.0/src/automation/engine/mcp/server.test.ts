import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RUNTIME_IDS } from "../shared/runtime-catalog";
import { callMcpTool, mcpToolDefinitions, resolveBridgeDiscoveryPath, startStdioMcpServer } from "./server";

const originalEnv = process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE;
const originalBridgeEnv = process.env.AGENT_RECALL_MCP_BRIDGE;
const originalStudioToken = process.env.AGENT_RECALL_STUDIO_TOKEN;
const originalManagedToken = process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN;
const originalWorkflowId = process.env.AGENT_RECALL_WORKFLOW_ID;
const originalRunId = process.env.AGENT_RECALL_WORKFLOW_RUN_ID;
const originalNodeId = process.env.AGENT_RECALL_WORKFLOW_NODE_ID;
const originalExecutionId = process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID;
const originalReviewRevision = process.env.AGENT_RECALL_WORKFLOW_REVIEW_REVISION;
const originalScope = process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE;
const originalMode = process.env.AGENT_RECALL_MCP_MODE;

async function killAndWaitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(escalate);
      clearTimeout(backstop);
      resolve();
    };
    // SIGTERM may be ignored or stuck; escalate to SIGKILL and drop our ends
    // of the pipes so nothing can hold the suite open on top of a failure.
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    }, 2_000);
    // Absolute backstop: even a child that refuses to die cannot hang here.
    const backstop = setTimeout(settle, 5_000);
    child.once("close", settle);
    child.once("error", settle);
  });
}
describe("MCP server tools", () => {
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE;
    else process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = originalEnv;
    if (originalBridgeEnv === undefined) delete process.env.AGENT_RECALL_MCP_BRIDGE;
    else process.env.AGENT_RECALL_MCP_BRIDGE = originalBridgeEnv;
    if (originalStudioToken === undefined) delete process.env.AGENT_RECALL_STUDIO_TOKEN;
    else process.env.AGENT_RECALL_STUDIO_TOKEN = originalStudioToken;
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
    if (originalReviewRevision === undefined) delete process.env.AGENT_RECALL_WORKFLOW_REVIEW_REVISION;
    else process.env.AGENT_RECALL_WORKFLOW_REVIEW_REVISION = originalReviewRevision;
    if (originalScope === undefined) delete process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE;
    else process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = originalScope;
    if (originalMode === undefined) delete process.env.AGENT_RECALL_MCP_MODE;
    else process.env.AGENT_RECALL_MCP_MODE = originalMode;
    vi.restoreAllMocks();
  });

  test("exposes only read tools to standalone discovery clients", () => {
    delete process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN;
    const tools = mcpToolDefinitions();
    expect(tools.map((tool) => tool.name)).toEqual([
      "workflow_list",
      "workflow_get",
      "workflow_validate",
      "workflow_run_list",
      "workflow_run_get",
      "workflow_outputs_list",
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  test("exposes only the seven progressive Gateway entry tools to external clients", () => {
    process.env.AGENT_RECALL_MCP_MODE = "gateway";
    expect(mcpToolDefinitions().map((tool) => tool.name)).toEqual([
      "search_tools",
      "get_tool",
      "call_tool",
      "list_skills",
      "get_skill",
      "search_sessions",
      "get_session",
    ]);
  });

  test("publishes Chinese descriptions for every Workflow MCP tool", () => {
    const tools = new Map<string, ReturnType<typeof mcpToolDefinitions>[number]>();
    const capture = () => {
      for (const tool of mcpToolDefinitions()) tools.set(tool.name, tool);
    };

    delete process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN;
    capture();
    process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN = "managed-token";
    process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = "planning";
    capture();
    process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = "review";
    capture();
    process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = "runtime_review";
    capture();
    process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = "node_execution";
    process.env.AGENT_RECALL_WORKFLOW_RUN_ID = "run-1";
    process.env.AGENT_RECALL_WORKFLOW_NODE_ID = "node-1";
    process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID = "execution-1";
    capture();

    expect(tools.size).toBeGreaterThan(20);
    for (const tool of tools.values()) {
      expect(tool.description, tool.name).toMatch(/[\u3400-\u9fff]/u);
    }
  });

  test("exposes lifecycle writes only to managed MCP sessions", () => {
    process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN = "managed-token";
    process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = "planning";

    const names = mcpToolDefinitions().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "workflow_create",
      "workflow_confirm",
      "workflow_run",
      "workflow_stop",
      "workflow_intervention_resolve",
      "workflow_script_input_submit",
    ]));
    for (const contextualTool of [
      "workflow_node_complete",
      "workflow_review_submit",
      "workflow_review_gate_submit",
      "studio_post",
    ]) {
      expect(names).not.toContain(contextualTool);
    }
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
    const script = definition.properties.nodes.items.properties.script;
    expect(script.required).toEqual(expect.arrayContaining(["effectMode", "idempotency", "stderrPolicy"]));
    expect(script.properties.effectMode.enum).toEqual(["pure", "workspace_only", "brokered_external"]);
    expect(script.properties.idempotency.enum).toEqual(["safe_retry", "keyed", "non_idempotent"]);
    expect(script.properties.stderrPolicy.enum).toEqual(["ignore", "warn", "fail"]);
    expect(definition.properties.transactionPolicy.properties.defaultMode.enum).toEqual(["strict_atomic", "controlled", "direct"]);
    expect(tool.description).toContain("script.effectMode");
    expect(tool.description).toContain("不提供响应正文作为脚本输出");
  });

  test("exposes only the bound submission tool to managed Review sessions", () => {
    process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN = "managed-token";
    process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = "review";
    process.env.AGENT_RECALL_WORKFLOW_ID = "wf-review";
    process.env.AGENT_RECALL_WORKFLOW_REVIEW_REVISION = "2";

    const tools = mcpToolDefinitions();
    expect(tools.map((tool) => tool.name)).toEqual(["workflow_review_submit"]);
    const properties = tools[0]!.inputSchema.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty("workflowId");
    expect(properties).not.toHaveProperty("reviewedRevision");
    expect((properties.verdict as { enum: string[] }).enum).toEqual(["approve", "revise"]);
  });

  test("exposes only the bound Runtime Review Gate submission tool", () => {
    process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN = "managed-token";
    process.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE = "runtime_review";
    process.env.AGENT_RECALL_WORKFLOW_ID = "wf-review";
    process.env.AGENT_RECALL_WORKFLOW_RUN_ID = "run-1";
    process.env.AGENT_RECALL_WORKFLOW_NODE_ID = "node-1";
    process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID = "review-1";
    process.env.AGENT_RECALL_WORKFLOW_REVIEW_REVISION = "2";

    const tools = mcpToolDefinitions();
    expect(tools.map((tool) => tool.name)).toEqual(["workflow_review_gate_submit"]);
    const properties = tools[0]!.inputSchema.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty("workflowId");
    expect(properties).not.toHaveProperty("runId");
    expect(properties).not.toHaveProperty("executionId");
  });

  test("uses env override for bridge discovery", () => {
    process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = "/tmp/custom-bridge.json";

    expect(resolveBridgeDiscoveryPath()).toBe("/tmp/custom-bridge.json");
  });

  test("does not expose retired Chat tools with a legacy Studio token", async () => {
    process.env.AGENT_RECALL_STUDIO_TOKEN = "studio-scope";
    const names = mcpToolDefinitions().map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith("studio_") || name.startsWith("workspace_"))).toEqual([]);
    await expect(callMcpTool("studio_turn_get", { turnId: "turn-1" }))
      .rejects.toThrow("Unknown MCP tool: studio_turn_get");
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

  test("propagates an indexed MCP tool error through the Gateway result", async () => {
    const bridge = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify({
        content: [{ type: "text", text: "upstream failed" }],
        isError: true,
      })}\n`);
    });
    await new Promise<void>((resolve, reject) => {
      bridge.once("error", reject);
      bridge.listen(0, "127.0.0.1", () => resolve());
    });
    const address = bridge.address();
    if (!address || typeof address === "string") throw new Error("Test bridge did not bind to TCP.");
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-gateway-tool-error-"));
    const discoveryPath = path.join(dir, "bridge.json");
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: address.port, token: "secret" }), "utf8");
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const serverPath = path.resolve("src", "mcp", "gateway-entry.ts");
    const child = spawn(process.execPath, [tsxCli, serverPath], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_RECALL_MCP_BRIDGE: discoveryPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const response = await new Promise<Record<string, any>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Gateway stdio response timed out")), 5_000);
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
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "call_tool", arguments: { toolRef: "docs/write" } },
        })}\n`);
      });

      expect(response.result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining('"isError": true') }],
      });
    } finally {
      child.kill();
      await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("workflow stdio server exits after the host closes stdin", async () => {
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const serverPath = path.resolve("src", "mcp", "workflow-entry.ts");
    const child = spawn(process.execPath, [tsxCli, serverPath], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_RECALL_WORKFLOW_MCP_BRIDGE: path.join(os.tmpdir(), "missing-mcp-bridge.json"), AGENT_RECALL_WORKFLOW_MCP_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
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
      });
      expect(response.result.tools.length).toBeGreaterThan(0);

      child.stdin.end();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("MCP stdio server outlived closed stdin")), 5_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.once("error", reject);
      });
      expect(exitCode).toBe(0);
    } finally {
      await killAndWaitForExit(child);
    }
  });

  test("gateway stdio server exits after the host closes stdin", async () => {
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const serverPath = path.resolve("src", "mcp", "gateway-entry.ts");
    const child = spawn(process.execPath, [tsxCli, serverPath], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_RECALL_MCP_BRIDGE: path.join(os.tmpdir(), "missing-mcp-bridge.json") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const response = await new Promise<Record<string, any>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Gateway stdio response timed out")), 5_000);
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
      });
      expect(response.result.tools.length).toBeGreaterThan(0);

      child.stdin.end();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Gateway stdio server outlived closed stdin")), 5_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.once("error", reject);
      });
      expect(exitCode).toBe(0);
    } finally {
      await killAndWaitForExit(child);
    }
  });

  test("drains in-flight requests before exiting on stdin close", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-stdio-drain-"));
    const discoveryPath = path.join(dir, "bridge.json");
    process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = discoveryPath;
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: 48123, token: "secret" }), "utf8");
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await fetchGate;
      return { ok: true, status: 200, json: async () => ({ ok: true, workflowId: "wf_1" }) } as Response;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(((
      _chunk: unknown,
      encodingOrCallback?: BufferEncoding | (() => void),
      maybeCallback?: () => void,
    ) => {
      const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
      if (callback) setImmediate(callback);
      return true;
    }) as typeof process.stdout.write);
    const exitCodes: number[] = [];
    const stdin = new PassThrough();

    startStdioMcpServer({ stdin, signalTarget: { on: () => undefined }, exit: (code) => exitCodes.push(code) });

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "workflow_run_list", arguments: {} } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    stdin.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitCodes).toEqual([]);

    releaseFetch();
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
  });

  test("waits for the last response to flush before exiting on stdin close", async () => {
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(((
      _chunk: unknown,
      encodingOrCallback?: BufferEncoding | (() => void),
      maybeCallback?: () => void,
    ) => {
      const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
      if (callback) void flushGate.then(callback);
      return true;
    }) as typeof process.stdout.write);
    const exitCodes: number[] = [];
    const stdin = new PassThrough();

    startStdioMcpServer({ stdin, signalTarget: { on: () => undefined }, exit: (code) => exitCodes.push(code) });

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    stdin.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitCodes).toEqual([]);

    releaseFlush();
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
  });

  test("stops waiting for in-flight requests after the drain window", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-stdio-drain-cap-"));
    const discoveryPath = path.join(dir, "bridge.json");
    process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = discoveryPath;
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: 48123, token: "secret" }), "utf8");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => undefined));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitCodes: number[] = [];
    const stdin = new PassThrough();

    startStdioMcpServer({ stdin, signalTarget: { on: () => undefined }, exit: (code) => exitCodes.push(code), drainMs: 20 });

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "workflow_run_list", arguments: {} } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    stdin.end();
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
  });

  test("exits on termination signals and broken stream pipes", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const signalListeners = new Map<string, (() => void)[]>();
    const signalTarget = {
      on(signal: string, listener: () => void) {
        signalListeners.set(signal, [...(signalListeners.get(signal) ?? []), listener]);
        return this;
      },
    };
    const exitCodes: number[] = [];

    startStdioMcpServer({
      stdin,
      stdout,
      signalTarget,
      exit: (code) => exitCodes.push(code),
    });

    for (const listener of signalListeners.get("SIGTERM") ?? []) listener();
    expect(exitCodes).toEqual([0]);

    const stdinAlreadyClosed = new PassThrough();
    stdinAlreadyClosed.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    startStdioMcpServer({
      stdin: stdinAlreadyClosed,
      stdout,
      signalTarget,
      exit: (code) => exitCodes.push(code),
    });
    expect(exitCodes).toEqual([0, 0]);

    const stdoutForPipeError = new PassThrough();
    startStdioMcpServer({
      stdin: new PassThrough(),
      stdout: stdoutForPipeError,
      signalTarget,
      exit: (code) => exitCodes.push(code),
    });
    stdoutForPipeError.emit("error", new Error("EPIPE"));
    expect(exitCodes).toEqual([0, 0, 0]);
  });

  test("stdio server stops instead of leaking when stdin closes mid-request", async () => {
    const blackholeSockets = new Set<net.Socket>();
    const blackhole = net.createServer((socket) => {
      // Accept the TCP connection but never respond, so the tool call hangs
      // the same way a gateway request in flight while its host dies does.
      blackholeSockets.add(socket);
      socket.once("close", () => blackholeSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      blackhole.once("error", reject);
      blackhole.listen(0, "127.0.0.1", () => resolve());
    });
    const address = blackhole.address();
    if (!address || typeof address === "string") throw new Error("Test bridge did not bind to TCP.");
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-stdio-leak-"));
    const discoveryPath = path.join(dir, "bridge.json");
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: address.port, token: "secret" }), "utf8");
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const serverPath = path.resolve("src", "mcp", "workflow-entry.ts");
    const child = spawn(process.execPath, [tsxCli, serverPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_RECALL_WORKFLOW_MCP_BRIDGE: discoveryPath,
        AGENT_RECALL_WORKFLOW_MCP_TOKEN: "",
        AGENT_RECALL_MCP_SHUTDOWN_DRAIN_MS: "300",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "workflow_run_list", arguments: {} },
      })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      child.stdin.end();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("MCP stdio server leaked after stdin closed mid-request")), 5_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.once("error", reject);
      });
      expect(exitCode).toBe(0);
    } finally {
      await killAndWaitForExit(child);
      // The blackhole never ends its accepted sockets, so plain close() would
      // wait forever for the half-open connection; drop them explicitly.
      for (const socket of blackholeSockets) socket.destroy();
      await new Promise<void>((resolve, reject) => blackhole.close((error) => error ? reject(error) : resolve()));
    }
  }, 15_000);

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

  test("injects the bound Workflow and Revision into Review submissions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-mcp-review-submit-"));
    const discoveryPath = path.join(dir, "bridge.json");
    process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = discoveryPath;
    process.env.AGENT_RECALL_WORKFLOW_ID = "wf-review";
    process.env.AGENT_RECALL_WORKFLOW_REVIEW_REVISION = "2";
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: 48126, token: "secret" }), "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, accepted: true }),
    } as Response);

    await callMcpTool("workflow_review_submit", {
      verdict: "approve",
      summary: "Ready",
      findings: [],
      scriptRisks: {},
      suggestions: [],
      workflowId: "model-selected-workflow",
      reviewedRevision: 99,
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      workflowId: "wf-review",
      reviewedRevision: 2,
      verdict: "approve",
    });
  });

  test("injects the bound Runtime Review Gate execution identity", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-mcp-review-gate-submit-"));
    const discoveryPath = path.join(dir, "bridge.json");
    process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE = discoveryPath;
    process.env.AGENT_RECALL_WORKFLOW_ID = "wf-review";
    process.env.AGENT_RECALL_WORKFLOW_RUN_ID = "run-1";
    process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID = "review-1";
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: 48126, token: "secret" }), "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, accepted: true }) } as Response);

    await callMcpTool("workflow_review_gate_submit", { reasons: ["ok"], riskLevel: "low", confidence: "high", dimensionResults: [] });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ workflowId: "wf-review", runId: "run-1", executionId: "review-1" });
  });

});
