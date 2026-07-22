import { describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../automation/engine/shared/types";
import type { AgentHub } from "../../automation/engine/main/hub/agent-hub";
import type { McpRegistryStore } from "../../automation/engine/main/mcp-registry-store";
import type { McpAgentManagementService } from "../../automation/engine/main/mcp/agent-management-service";
import type { EvaluationService } from "./evaluation-service";
import { NativeAutomationService } from "./automation-service";

function snapshot(workDir = "/repo"): AppSnapshot {
  return { workDir } as AppSnapshot;
}

function fixture() {
  const calls: string[] = [];
  let current = snapshot();
  let listener: ((value: AppSnapshot) => void) | undefined;
  const hub = {
    loadModelChannels: vi.fn(async () => { calls.push("channels"); }),
    loadPersistedState: vi.fn(async () => { calls.push("database"); }),
    ensureBundledWorkflows: vi.fn(() => { calls.push("bundled"); }),
    setWorkflowMcpDiscoveryPath: vi.fn(() => { calls.push("discovery"); }),
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
  const registry = { close: vi.fn(() => { calls.push("registry-close"); }) } as unknown as McpRegistryStore;
  const evaluations = { close: vi.fn(() => { calls.push("evaluations-close"); }) } as unknown as EvaluationService;
  const agents = {} as McpAgentManagementService;
  const service = new NativeAutomationService(
    {
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
      agents,
      loadBundledWorkflows: vi.fn(async () => [{ workflowId: "wf", title: "One", objective: "One", definition: {} as never }]),
      startRouter: vi.fn(async () => ({ host: "127.0.0.1", port: 1, baseUrl: "http://127.0.0.1:1", stop: async () => { calls.push("router-stop"); } })),
      setRouterBaseUrl: vi.fn(),
      startBridge: vi.fn(async () => ({
        host: "127.0.0.1",
        port: 2,
        token: "test-token",
        discoveryPath: "/user-data/automation-mcp-bridge.json",
        stop: async () => { calls.push("bridge-stop"); },
      })),
    },
  );
  return { service, calls, hub, registry, evaluations, emit: (value: AppSnapshot) => { current = value; listener?.(value); } };
}

describe("NativeAutomationService", () => {
  it("initializes the native engine once in dependency order", async () => {
    const { service, calls, hub } = fixture();

    await Promise.all([service.initialize(), service.initialize()]);

    expect(calls).toEqual(["channels", "database", "bundled", "discovery", "runtime"]);
    expect(hub.loadModelChannels).toHaveBeenCalledWith("/user-data/runtime-channels.json");
    expect(hub.loadPersistedState).toHaveBeenCalledWith("/user-data/automation.db");
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
    const { service, calls, evaluations } = fixture();
    await service.initialize();

    await service.shutdown();
    await service.shutdown();

    expect(calls.slice(-5)).toEqual(["hub-stop", "bridge-stop", "router-stop", "evaluations-close", "registry-close"]);
    expect(service.evaluations()).toBe(evaluations);
  });
});
