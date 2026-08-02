import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { AppSnapshot } from "../../automation/contracts";
import type { AgentHub, AgentHubChange } from "../../automation/engine/main/hub/agent-hub";
import type { AutomationChange, WorkflowAutomationProjection } from "../../shared/ipc/automation";
import type { McpRegistryStore } from "../../automation/engine/main/mcp-registry-store";
import type { McpAgentManagementService } from "../../automation/engine/main/mcp/agent-management-service";
import type { StartMcpBridgeOptions } from "../../automation/engine/main/bridges/mcp-bridge";
import type { EvaluationService } from "./evaluation-service";
import type { TeamChatService } from "../team-chat/team-chat-service";
import type { PostgresDatabase } from "../../core/postgres/database";
import { NativeAutomationService } from "./automation-service";

function snapshot(workDir = "/repo"): AppSnapshot {
  return {
    detectedAt: 0,
    activeChatId: undefined,
    activeTaskId: undefined,
    activeTeamId: undefined,
    activeTeamRunId: undefined,
    workDir,
    runtimes: [],
    channels: [],
    configuredAgents: [],
    chats: [],
    tasks: [],
    teams: [],
    teamRuns: [],
    workflowStore: { activeWorkflowId: undefined, workflows: [], runs: [] },
    scheduledWorkflowStore: { activeScheduleId: undefined, runnerConfig: { baseUrl: "" }, runnerStatus: { connected: false, connecting: false }, schedules: [], runs: [] },
    workflowNodeConversations: [],
    workflowDraft: undefined,
    artifacts: [],
  };
}

function fixture(injectAgents = true) {
  const calls: string[] = [];
  let current = snapshot();
  let listener: ((value: AgentHubChange) => void) | undefined;
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
    onChange: vi.fn((next: (value: AgentHubChange) => void) => {
      listener = next;
      next({ kind: "snapshot", snapshot: current });
      return () => { listener = undefined; };
    }),
    getWorkDir: vi.fn(() => current.workDir),
    askConfiguredAgent: vi.fn(async () => ({
      content: "runtime output",
      runtimeConversation: undefined,
    })),
    configuredAgentDeletionReferences: vi.fn(() => []),
    updateConfiguredAgents: vi.fn((agents) => {
      current = { ...current, configuredAgents: agents };
      return current;
    }),
    shutdown: vi.fn(async () => { calls.push("hub-stop"); }),
  } as unknown as AgentHub;
  const registry = {
    list: vi.fn(async () => []),
    close: vi.fn(() => { calls.push("registry-close"); }),
  } as unknown as McpRegistryStore;
  const evaluations = {
    configuredAgentReferences: vi.fn(async () => []),
    close: vi.fn(() => { calls.push("evaluations-close"); }),
  } as unknown as EvaluationService;
  const teamChats = {
    connect: vi.fn(async () => {
      calls.push("team-chat-start");
      return { state: "ready", mode: "local", databaseLabel: "Local database" } as const;
    }),
    close: vi.fn(async () => { calls.push("team-chat-close"); }),
    configuredAgentReferences: vi.fn(async () => []),
    handleMcpRequest: vi.fn(async () => ({ ok: true })),
  } as unknown as TeamChatService;
  const agents = {} as McpAgentManagementService;
  const startBridge = vi.fn(async (_hub: AgentHub, _options: StartMcpBridgeOptions) => {
    calls.push("bridge");
    return {
      host: "127.0.0.1",
      port: 2,
      token: "test-token",
      readToken: "read-token",
      discoveryPath: "/user-data/automation-mcp-bridge.json",
      stop: async () => { calls.push("bridge-stop"); },
    };
  });
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
      startBridge,
    },
  );
  return {
    service,
    calls,
    hub,
    registry,
    evaluations,
    teamChats,
    startBridge,
    emit: (value: AppSnapshot) => {
      current = value;
      listener?.({ kind: "snapshot", snapshot: value });
    },
    emitWorkflow: (payload: Partial<WorkflowAutomationProjection>, patch?: import("../../shared/ipc/automation").WorkflowAutomationPatch) => {
      listener?.({ kind: "workflow", detectedAt: 42, payload, ...(patch ? { patch } : {}) });
    },
  };
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
    const { service, calls, hub, teamChats, startBridge } = fixture();

    await Promise.all([service.initialize(), service.initialize()]);

    expect(calls).toEqual(["channels", "database", "mcp", "bundled", "router", "bridge", "discovery", "managed-token", "runtime", "team-chat-start"]);
    expect(teamChats.connect).toHaveBeenCalledTimes(1);
    expect(hub.loadModelChannels).toHaveBeenCalledWith(path.join("/user-data", "runtime-channels.json"));
    expect(hub.loadPersistedState).toHaveBeenCalledWith(expect.any(Object));
    const bridgeOptions = startBridge.mock.calls[0]?.[1];
    await expect(bridgeOptions?.studio?.handleMcpRequest(
      "studio-token",
      "/mcp/studio/list-members",
      {},
    )).resolves.toEqual({ ok: true });
    expect(teamChats.handleMcpRequest).toHaveBeenCalledWith(
      "studio-token",
      "/mcp/studio/list-members",
      {},
    );
    expect(hub.setWorkflowMcpManagedToken).toHaveBeenCalledWith("test-token");
    expect(hub.refreshDiscoverableModelCatalogs).not.toHaveBeenCalled();
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

  it("blocks Agent deletion and reports references from every owning module", async () => {
    const { service, hub, teamChats, evaluations, emit } = fixture();
    const worker = {
      id: "worker", name: "Worker", description: "", runtimeAgentId: "codex" as const,
      channelId: "codex-openai", modelId: "default", tags: [], createdAt: 1, updatedAt: 1,
    };
    emit({ ...snapshot(), configuredAgents: [worker] });
    vi.mocked(hub.configuredAgentDeletionReferences).mockReturnValue([
      { agentId: "worker", agentName: "Worker", location: "Chat Support" },
    ]);
    vi.mocked(teamChats.configuredAgentReferences).mockResolvedValue([
      { agentId: "worker", location: "Team Chat room Release member Reviewer" },
    ]);
    vi.mocked(evaluations.configuredAgentReferences).mockResolvedValue([
      { agentId: "worker", location: "Evaluation experiment Regression" },
    ]);

    await expect(service.deleteConfiguredAgent("worker")).rejects.toThrow(/Chat Support.*Team Chat room Release member Reviewer.*Evaluation experiment Regression/);
    expect(hub.updateConfiguredAgents).not.toHaveBeenCalled();
  });

  it("deletes an unreferenced Agent by id without replacing unrelated Agents", async () => {
    const { service, hub, emit } = fixture();
    const worker = {
      id: "worker", name: "Worker", description: "", runtimeAgentId: "codex" as const,
      channelId: "codex-openai", modelId: "default", tags: [], createdAt: 1, updatedAt: 1,
    };
    const reviewer = { ...worker, id: "reviewer", name: "Reviewer" };
    emit({ ...snapshot(), configuredAgents: [worker, reviewer] });

    await expect(service.deleteConfiguredAgent("worker"))
      .resolves.toMatchObject({ configuredAgents: [reviewer] });
    expect(hub.updateConfiguredAgents).toHaveBeenCalledWith([reviewer], { detectDeletedManagedAgents: true });
  });

  it("publishes ordered workflow changes without rebroadcasting a full snapshot", () => {
    const { service, emitWorkflow } = fixture();
    const snapshots: AppSnapshot[] = [];
    const changes: AutomationChange[] = [];
    service.subscribe((value) => snapshots.push(value));
    service.subscribeChanges((value) => changes.push(value));
    const payload: WorkflowAutomationProjection = {
      workflowStore: { activeWorkflowId: "wf", workflows: [], runs: [] },
      workflowNodeConversations: [],
      workflowDraft: undefined,
      tasks: [],
      artifacts: [],
    };

    emitWorkflow(payload);
    expect(service.snapshot().workflowStore.activeWorkflowId).toBe("wf");
    emitWorkflow({ ...payload, workflowStore: { ...payload.workflowStore, activeWorkflowId: undefined } });

    expect(changes.map((value) => value.sequence)).toEqual([1, 2]);
    expect(changes[0]?.payload).toEqual({ activeWorkflowId: "wf" });
    expect(changes[0]).not.toHaveProperty("payload.workflowStore");
    expect(snapshots).toHaveLength(1);
    expect(service.snapshot().workflowStore.activeWorkflowId).toBeUndefined();
  });

  it("accepts scoped workflow projections without replacing omitted collections", () => {
    const { service, emitWorkflow } = fixture();
    const originalStore = service.snapshot().workflowStore;

    emitWorkflow({ tasks: [] });

    expect(service.snapshot().workflowStore).toBe(originalStore);
  });

  it("runs a one-shot prompt through the managed Agent for the selected Runtime channel", async () => {
    const { service, hub, emit } = fixture();
    emit({
      ...snapshot("/workspace"),
      runtimes: [{
        id: "claude",
        label: "Claude",
        command: "claude",
        version: "1.0.0",
        available: true,
      }],
      channels: [{
        id: "runtime-claude-team",
        agentId: "claude",
        label: "Claude Team",
        models: [{ id: "sonnet", label: "Sonnet" }],
      }],
      configuredAgents: [{
        id: "runtime-agent:runtime-claude-team",
        name: "Claude Team",
        description: "",
        runtimeAgentId: "claude",
        channelId: "runtime-claude-team",
        modelId: "sonnet",
        tags: [],
        managed: true,
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    await expect(service.runOneShotOnRuntime("runtime-claude-team", "Return JSON."))
      .resolves.toBe("runtime output");
    expect(hub.askConfiguredAgent).toHaveBeenCalledWith(expect.objectContaining({
      configuredAgentId: "runtime-agent:runtime-claude-team",
      runtimeId: "claude",
      prompt: "Return JSON.",
      workDir: "/workspace",
    }), undefined, undefined);
  });

  it("applies a direct entity patch without rebuilding a workflow projection", () => {
    const { service, emitWorkflow } = fixture();
    emitWorkflow({}, { activeWorkflowId: "wf-direct", workflows: { upsert: [], remove: [] } });
    expect(service.snapshot().workflowStore.activeWorkflowId).toBe("wf-direct");
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
