import { describe, expect, it, vi } from "vitest";
import { BuiltinSessionSearchServer, BuiltinWorkflowMcpServer, type BuiltinSessionSearchDeps, type McpBuiltinRuntime } from "./mcp-builtin-server";
import type { McpServerDefinition } from "../shared/mcp/types";

const FIXED_CONFIG = {
  id: "agent-recall-session-search",
  name: "agent-recall-v2",
  command: "node",
  args: ["/bin/agent-recall-mcp.mjs"],
};

function createDeps(overrides: Partial<BuiltinSessionSearchDeps> = {}): BuiltinSessionSearchDeps & {
  setEnabled: ReturnType<typeof vi.fn>;
  writeRuntime: ReturnType<typeof vi.fn>;
} {
  // Seed from an optional readRuntime override, but always read/write through
  // the closure so a recordTest round-trip is observable.
  let runtime = overrides.readRuntime?.();
  let enabled = overrides.isEnabled?.() ?? true;
  const setEnabled = vi.fn(async (next: boolean) => {
    enabled = next;
    return next;
  });
  const writeRuntime = vi.fn((next: McpBuiltinRuntime) => {
    runtime = next;
  });
  return {
    isEnabled: () => enabled,
    setEnabled,
    launchConfig: () => FIXED_CONFIG,
    writeRuntime,
    ...overrides,
    readRuntime: () => runtime,
  } as BuiltinSessionSearchDeps & {
    setEnabled: ReturnType<typeof vi.fn>;
    writeRuntime: ReturnType<typeof vi.fn>;
  };
}

describe("BuiltinSessionSearchServer", () => {
  it("resolves a managed server from the fixed launch config and app settings", async () => {
    const server = new BuiltinSessionSearchServer(createDeps({
      isEnabled: () => false,
      readRuntime: () => ({
        tools: [{ name: "search_sessions", inputSchema: {} }],
        disabledTools: ["set_visibility"],
        status: "connected",
        createdAt: 10,
        updatedAt: 20,
      }),
    }));
    const resolved = await server.resolve();
    expect(resolved).toEqual({
      id: "agent-recall-session-search",
      name: "agent-recall-v2",
      transport: "stdio",
      command: "node",
      args: ["/bin/agent-recall-mcp.mjs"],
      env: {},
      enabled: false,
      tools: [{ name: "search_sessions", inputSchema: {} }],
      disabledTools: ["set_visibility"],
      status: "connected",
      createdAt: 10,
      updatedAt: 20,
      managed: true,
    });
    expect(server.isBuiltinId("agent-recall-session-search")).toBe(true);
    expect(server.isBuiltinId("mcp-123")).toBe(false);
  });

  it("persists editable draft fields and mirrors enable state to settings", async () => {
    const deps = createDeps();
    const server = new BuiltinSessionSearchServer(deps);

    await server.saveDraft({
      ...(await server.resolve()),
      enabled: false,
      name: "Hijacked Name",
      command: "/tmp/evil",
      args: ["--tampered"],
      tools: [{ name: "search_sessions", inputSchema: {} }],
      disabledTools: ["get_session"],
    });

    expect(deps.setEnabled).toHaveBeenCalledWith(false);
    const saved = await server.resolve();
    // Connection fields are re-derived, not taken from the client.
    expect(saved.name).toBe("agent-recall-v2");
    expect(saved.command).toBe("node");
    expect(saved.args).toEqual(["/bin/agent-recall-mcp.mjs"]);
    // Tool catalog and toggles are preserved from the draft.
    expect(saved.tools).toEqual([{ name: "search_sessions", inputSchema: {} }]);
    expect(saved.disabledTools).toEqual(["get_session"]);
    expect(saved.enabled).toBe(false);
  });

  it("does not touch the enable setting when unchanged", async () => {
    const setEnabled = vi.fn(async (next: boolean) => next);
    const deps = createDeps({ setEnabled, isEnabled: () => true });
    const server = new BuiltinSessionSearchServer(deps);
    await server.saveDraft(await server.resolve());
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("records a successful test into the runtime cache and clears last error", async () => {
    const deps = createDeps({
      readRuntime: () => ({
        tools: [],
        disabledTools: [],
        status: "error",
        lastError: "boom",
        createdAt: 10,
        updatedAt: 10,
      }),
    });
    const server = new BuiltinSessionSearchServer(deps);
    const draft = await server.resolve();
    const tested = await server.recordTest(draft, [
      { name: "search_sessions", inputSchema: {} },
      { name: "get_session", inputSchema: {} },
    ]);

    expect(tested.status).toBe("connected");
    expect(tested.tools.map((tool) => tool.name)).toEqual(["search_sessions", "get_session"]);
    expect(tested.lastError).toBeUndefined();
    expect(tested.lastTestedAt).toBeGreaterThan(0);
    const cached = deps.readRuntime() as McpBuiltinRuntime;
    expect(cached.status).toBe("connected");
    expect(cached.lastError).toBeUndefined();
  });

  it("records a failed test with the error and an empty catalog", async () => {
    const deps = createDeps();
    const server = new BuiltinSessionSearchServer(deps);
    const tested = await server.recordTest(await server.resolve(), [], "connection refused");
    expect(tested.status).toBe("error");
    expect(tested.lastError).toBe("connection refused");
    expect((deps.readRuntime() as McpBuiltinRuntime).status).toBe("error");
  });

  it("keeps the draft disabledTools when recording a test", async () => {
    const deps = createDeps();
    const server = new BuiltinSessionSearchServer(deps);
    const draft: McpServerDefinition = { ...(await server.resolve()), disabledTools: ["tag_session"] };
    const tested = await server.recordTest(draft, [{ name: "tag_session", inputSchema: {} }]);
    expect(tested.disabledTools).toEqual(["tag_session"]);
  });
});

const WORKFLOW_LAUNCH = {
  id: "agent-recall-workflow",
  name: "AgentRecall Workflow",
  command: "node",
  args: ["/out/mcp/workflow-entry.js"],
};

describe("BuiltinWorkflowMcpServer", () => {
  it("resolves a managed, non-hub-bindable server with empty env and default-off state", async () => {
    const deps = createDeps({ isEnabled: () => false, launchConfig: () => WORKFLOW_LAUNCH });
    const server = new BuiltinWorkflowMcpServer({ ...deps, hubBindable: false });
    const resolved = await server.resolve();
    expect(resolved.id).toBe("agent-recall-workflow");
    expect(resolved.name).toBe("AgentRecall Workflow");
    expect(resolved.enabled).toBe(false);
    expect(resolved.env).toEqual({});
    expect(resolved.managed).toBe(true);
    expect(resolved.hubBindable).toBe(false);
    expect(server.isBuiltinId("agent-recall-workflow")).toBe(true);
    expect(server.isBuiltinId("mcp-123")).toBe(false);
  });

  it("exposes literal bridge env only for testing", async () => {
    const deps = createDeps({ launchConfig: () => WORKFLOW_LAUNCH });
    const server = new BuiltinWorkflowMcpServer({
      ...deps,
      hubBindable: false,
      testEnv: () => ({
        AGENT_RECALL_WORKFLOW_MCP_BRIDGE: "/data/automation-mcp-bridge.json",
        AGENT_RECALL_WORKFLOW_MCP_TOKEN: "secret-token",
      }),
    });
    expect(server.testEnv()).toEqual({
      AGENT_RECALL_WORKFLOW_MCP_BRIDGE: "/data/automation-mcp-bridge.json",
      AGENT_RECALL_WORKFLOW_MCP_TOKEN: "secret-token",
    });
  });

  it("routes enable changes through the settings toggle", async () => {
    const deps = createDeps({ launchConfig: () => WORKFLOW_LAUNCH });
    const server = new BuiltinWorkflowMcpServer({ ...deps, hubBindable: false });
    await server.saveDraft({ ...(await server.resolve()), enabled: false });
    expect(deps.setEnabled).toHaveBeenCalledWith(false);
    expect((await server.resolve()).enabled).toBe(false);
  });

  it("records a successful test into its runtime cache", async () => {
    const deps = createDeps({ launchConfig: () => WORKFLOW_LAUNCH });
    const server = new BuiltinWorkflowMcpServer({ ...deps, hubBindable: false });
    const tested = await server.recordTest(await server.resolve(), [
      { name: "workflow_create", inputSchema: {} },
      { name: "workflow_run", inputSchema: {} },
    ]);
    expect(tested.status).toBe("connected");
    expect(tested.tools.map((tool) => tool.name)).toEqual(["workflow_create", "workflow_run"]);
    expect((deps.readRuntime() as McpBuiltinRuntime).status).toBe("connected");
  });
});
