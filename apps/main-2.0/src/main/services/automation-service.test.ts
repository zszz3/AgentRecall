import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { AppSnapshot } from "../../automation/contracts";
import type { AgentHub, AgentHubChange } from "../../automation/engine/main/hub/agent-hub";
import type { McpRegistryStore } from "../../automation/engine/main/mcp-registry-store";
import type { StartMcpBridgeOptions } from "../../automation/engine/main/bridges/mcp-bridge";
import type { EvaluationService } from "./evaluation-service";
import type { PostgresDatabase } from "../../core/postgres/database";
import { BuiltinSkillMcpServer } from "../../automation/engine/main/mcp-builtin-server";
import { NativeAutomationService, type AutomationServiceOptions } from "./automation-service";

function snapshot(workDir = "/repo"): AppSnapshot {
  return {
    detectedAt: 0,
    activeChatId: undefined,
    workDir,
    runtimes: [],
    channels: [],
    configuredAgents: [],
    chats: [],
  };
}

function fixture(optionOverrides: Partial<AutomationServiceOptions> = {}) {
  const calls: string[] = [];
  let current = snapshot();
  let listener: ((value: AgentHubChange) => void) | undefined;
  const hub = {
    loadModelChannels: vi.fn(async () => { calls.push("channels"); }),
    loadPersistedState: vi.fn(async () => { calls.push("database"); }),
    setMcpServers: vi.fn(() => { calls.push("mcp"); }),
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
    close: vi.fn(async () => { calls.push("evaluations-close"); }),
  } as unknown as EvaluationService;
  const database = {
    query: vi.fn(async () => ({ rows: [] })),
  } as unknown as PostgresDatabase;
  const startBridge = vi.fn(async (_options: StartMcpBridgeOptions) => {
    calls.push("bridge");
    return {
      host: "127.0.0.1",
      port: 2,
      token: "test-token",
      discoveryPath: "/user-data/automation-mcp-bridge.json",
      stop: async () => { calls.push("bridge-stop"); },
    };
  });
  const service = new NativeAutomationService(
    {
      database,
      userDataPath: "/user-data",
      homePath: "/home/dev",
      appDataPath: "/app-data",
      ...optionOverrides,
    },
    {
      hub,
      registry,
      evaluations,
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
    startBridge,
    database,
    emit: (value: AppSnapshot) => {
      current = value;
      listener?.({ kind: "snapshot", snapshot: value });
    },
  };
}

describe("NativeAutomationService", () => {
  it("publishes the managed Skill server as a separate project built-in", async () => {
    const skillBuiltin = new BuiltinSkillMcpServer({
      isEnabled: () => true,
      setEnabled: async (next) => next,
      launchConfig: () => ({
        id: "agent-recall-skills",
        name: "AgentRecall Skills",
        command: "node",
        args: ["/bin/agent-recall-skill-mcp.mjs"],
      }),
      readRuntime: () => undefined,
      writeRuntime: () => undefined,
    });
    const { service } = fixture({ builtinSkills: skillBuiltin });

    expect((await service.mcp.list()).map((server) => server.id)).toEqual([
      "agent-recall-skills",
    ]);
  });

  it("prepares the persisted snapshot without starting execution infrastructure", async () => {
    const { service, calls } = fixture();

    await Promise.all([service.requirePrepared(), service.requirePrepared()]);

    expect(calls).toEqual(["channels", "database", "mcp"]);
    expect(service.health()).toEqual({ state: "idle" });
  });

  it("initializes the native engine once in dependency order", async () => {
    const { service, calls, hub, startBridge } = fixture();

    await Promise.all([service.initialize(), service.initialize()]);

    expect(calls).toEqual(["channels", "database", "mcp", "router", "bridge", "runtime"]);
    expect(hub.loadModelChannels).toHaveBeenCalledWith(path.join("/user-data", "runtime-channels.json"));
    expect(hub.loadPersistedState).toHaveBeenCalledWith(expect.any(Object));
    expect(startBridge).toHaveBeenCalledOnce();
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
    const { service, hub, evaluations, emit } = fixture();
    const worker = {
      id: "worker", name: "Worker", description: "", runtimeAgentId: "codex" as const,
      channelId: "codex-openai", modelId: "default", tags: [], createdAt: 1, updatedAt: 1,
    };
    emit({ ...snapshot(), configuredAgents: [worker] });
    vi.mocked(hub.configuredAgentDeletionReferences).mockReturnValue([
      { agentId: "worker", agentName: "Worker", location: "Chat Support" },
    ]);
    vi.mocked(evaluations.configuredAgentReferences).mockResolvedValue([
      { agentId: "worker", location: "Evaluation experiment Regression" },
    ]);

    await expect(service.deleteConfiguredAgent("worker")).rejects.toThrow(/Chat Support.*Evaluation experiment Regression/);
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

  it("flushes runtime state before bridge and registry shutdown", async () => {
    const { service, calls, evaluations } = fixture();
    await service.initialize();

    await service.shutdown();
    await service.shutdown();

    expect(calls.slice(-5)).toEqual([ "evaluations-close", "hub-stop", "bridge-stop", "router-stop", "registry-close"]);
    expect(service.evaluations).toBe(evaluations);
    await expect(service.requireReady()).rejects.toThrow(/stopped/i);
  });
});
