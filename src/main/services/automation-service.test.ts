import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { AppSnapshot } from "../../automation/contracts";
import type { AgentHub } from "../../automation/engine/main/hub/agent-hub";
import type { McpRegistryStore } from "../../automation/engine/main/mcp-registry-store";
import type { McpAgentManagementService } from "../../automation/engine/main/mcp/agent-management-service";
import type { EvaluationService } from "./evaluation-service";
import type { TeamChatService } from "../team-chat/team-chat-service";
import type { PostgresDatabase } from "../../core/postgres/database";
import { NativeAutomationService } from "./automation-service";

function snapshot(workDir = "/repo"): AppSnapshot {
  return { workDir } as AppSnapshot;
}

function fixture(injectAgents = true) {
  const calls: string[] = [];
  let current = snapshot();
  let listener: ((value: AppSnapshot) => void) | undefined;
  const hub = {
    loadModelChannels: vi.fn(async () => { calls.push("channels"); }),
    loadPersistedState: vi.fn(async () => { calls.push("database"); }),
    ensureBundledWorkflows: vi.fn(() => { calls.push("bundled"); }),
    setMcpServers: vi.fn(() => { calls.push("mcp"); }),
    setWorkflowMcpDiscoveryPath: vi.fn(() => { calls.push("discovery"); }),
    setWorkflowMcpManagedToken: vi.fn(() => { calls.push("managed-token"); }),
    initialize: vi.fn(async () => { calls.push("runtime"); }),
    refreshDiscoverableModelCatalogs: vi.fn(async () => undefined),
    snapshot: vi.fn(() => current),
    onChange: vi.fn((next: (value: AppSnapshot) => void) => {
      listener = next;
      next(current);
      return () => { listener = undefined; };
    }),
    getWorkDir: vi.fn(() => current.workDir),
    shutdown: vi.fn(async () => { calls.push("hub-stop"); }),
  } as unknown as AgentHub;
  const registry = {
    list: vi.fn(async () => []),
    close: vi.fn(() => { calls.push("registry-close"); }),
  } as unknown as McpRegistryStore;
  const evaluations = { close: vi.fn(() => { calls.push("evaluations-close"); }) } as unknown as EvaluationService;
  const teamChats = {
    connect: vi.fn(async () => {
      calls.push("team-chat-start");
      return { state: "ready", mode: "local", databaseLabel: "Local database" } as const;
    }),
    close: vi.fn(async () => { calls.push("team-chat-close"); }),
  } as unknown as TeamChatService;
  const agents = {} as McpAgentManagementService;
  const service = new NativeAutomationService(
    {
      database: {} as PostgresDatabase,
      userDataPath: "/user-data",
      homePath: "/home/dev",
      appDataPath: "/app-data",
      bundledWorkflowsPath: "/assets/workflows",
      workflowMcpServerPath: "/app/out/mcp/workflow-entry.js",
    },
    {
      hub,
      registry,
      evaluations,
      teamChats,
      ...(injectAgents ? { agents } : {}),
      loadBundledWorkflows: vi.fn(async () => [{ workflowId: "wf", title: "One", objective: "One", definition: {} as never }]),
      startRouter: vi.fn(async () => {
        calls.push("router");
        return { host: "127.0.0.1", port: 1, baseUrl: "http://127.0.0.1:1", stop: async () => { calls.push("router-stop"); } };
      }),
      setRouterBaseUrl: vi.fn(),
      startBridge: vi.fn(async () => {
        calls.push("bridge");
        return {
          host: "127.0.0.1",
          port: 2,
          token: "test-token",
          readToken: "read-token",
          discoveryPath: "/user-data/automation-mcp-bridge.json",
          stop: async () => { calls.push("bridge-stop"); },
        };
      }),
    },
  );
  return { service, calls, hub, registry, evaluations, teamChats, emit: (value: AppSnapshot) => { current = value; listener?.(value); } };
}

describe("NativeAutomationService", () => {
  it("prepares the persisted snapshot without starting execution infrastructure", async () => {
    const { service, calls, teamChats } = fixture();

    await Promise.all([service.requirePrepared(), service.requirePrepared()]);

    expect(calls).toEqual(["channels", "database", "mcp", "bundled"]);
    expect(teamChats.connect).not.toHaveBeenCalled();
    expect(service.health()).toEqual({ state: "idle" });
  });

  it("reports planning write tools without reading child-only environment variables", async () => {
    const previous = process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN;
    delete process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN;
    try {
      const { service } = fixture(false);
      await service.initialize();
      expect(service.mcp.setupStatus()).toMatchObject({
        bridgeRunning: true,
        workflowCreateAvailable: true,
      });
    } finally {
      if (previous === undefined) delete process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN;
      else process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN = previous;
    }
  });
  it("keeps the managed MCP write token inside the native runtime", async () => {
    const { service, hub } = fixture();

    await service.initialize();

    expect(hub.setWorkflowMcpManagedToken).toHaveBeenCalledWith("test-token");
  });

  it("initializes the native engine once in dependency order", async () => {
    const { service, calls, hub, teamChats } = fixture();

    await Promise.all([service.initialize(), service.initialize()]);

    expect(calls).toEqual(["channels", "database", "mcp", "bundled", "router", "bridge", "discovery", "managed-token", "runtime", "team-chat-start"]);
    expect(teamChats.connect).toHaveBeenCalledTimes(1);
    expect(hub.loadModelChannels).toHaveBeenCalledWith(path.join("/user-data", "runtime-channels.json"));
    expect(hub.loadPersistedState).toHaveBeenCalledWith(expect.any(Object));
    expect(hub.setWorkflowMcpManagedToken).toHaveBeenCalledWith("test-token");
    expect(service.health()).toEqual({ state: "ready" });
  });

  it("publishes hub snapshots without creating another engine", async () => {
    const { service, emit } = fixture();
    const received: AppSnapshot[] = [];
    const unsubscribe = service.subscribe((value) => received.push(value));

    emit(snapshot("/next"));
    unsubscribe();
    emit(snapshot("/ignored"));

    expect(received.map((value) => value.workDir)).toEqual(["/repo", "/next"]);
  });

  it("flushes runtime state before bridge and registry shutdown", async () => {
    const { service, calls, evaluations, teamChats } = fixture();
    await service.initialize();

    await service.shutdown();
    await service.shutdown();

    expect(calls.slice(-6)).toEqual(["team-chat-close", "hub-stop", "bridge-stop", "router-stop", "evaluations-close", "registry-close"]);
    expect(service.evaluations).toBe(evaluations);
    expect(service.teamChat).toBe(teamChats);
    await expect(service.requireReady()).rejects.toThrow(/stopped/i);
  });
});
