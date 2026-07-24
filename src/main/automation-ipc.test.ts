import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_CHANNELS } from "../shared/ipc/automation";
import type { NativeAutomationService } from "./services/automation-service";
import { McpAutomationModule } from "./services/mcp-automation-module";
import { registerAutomationIpc } from "./ipc/automation";

function setup(pickDirectory?: (defaultPath?: string) => Promise<string | undefined>) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const ipc = {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler)),
  };
  const hub = {
    saveModelChannels: vi.fn(async (value) => ({ channels: value })),
    updateConfiguredAgents: vi.fn((value) => ({ configuredAgents: value })),
    createWorkflowDraft: vi.fn((value) => ({ workflowDraft: value })),
    sendWorkflowDraftReply: vi.fn(async (value) => ({ workflowDraft: value })),
    setMcpServers: vi.fn(),
    listConfiguredAgents: vi.fn(() => [{
      id: "agent-1", name: "Agent", description: "", runtimeAgentId: "codex", channelId: "codex-openai",
      modelId: "default", tags: [], mcpBindings: [{ serverId: "docs", toolAllowlist: [] }], createdAt: 1, updatedAt: 1,
    }]),
  };
  const registry = {
    upsert: vi.fn(async (value) => value),
    list: vi.fn(async () => []),
    recordTest: vi.fn(),
    delete: vi.fn(async () => true),
  };
  const evaluations = {
    listDatasets: vi.fn(async () => []),
    saveDataset: vi.fn(async (value) => value),
    deleteDataset: vi.fn(async () => true),
    listEvaluators: vi.fn(async () => []),
    saveEvaluator: vi.fn(async (value) => value),
    deleteEvaluator: vi.fn(async () => true),
    listExperiments: vi.fn(async () => []),
    saveExperiment: vi.fn(async (value) => value),
    deleteExperiment: vi.fn(async () => true),
    listRuns: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 50 })),
    getRun: vi.fn(async () => undefined),
    deleteRun: vi.fn(async () => true),
    runExperiment: vi.fn(async (experimentId) => ({ experimentId })),
  };
  const mcpAgents = {
    status: vi.fn(async () => ({})),
    listInstalled: vi.fn(async () => []),
    listForAgent: vi.fn(async () => []),
    install: vi.fn(async () => ({})),
    uninstall: vi.fn(async () => ({})),
  };
  const mcp = new McpAutomationModule({
    registry: registry as never,
    agents: mcpAgents as never,
    runtime: hub as never,
    discoverTools: vi.fn(async () => []),
  });
  const service = {
    requirePrepared: vi.fn(async () => undefined),
    requireReady: vi.fn(async () => undefined),
    health: vi.fn(() => ({ state: "ready" })),
    snapshot: vi.fn(() => ({ workDir: "/repo" })),
    subscribe: vi.fn(() => () => undefined),
    runtime: hub,
    workflows: hub,
    mcp,
    evaluations,
    resolveRuntimeApproval: vi.fn(),
  } as unknown as NativeAutomationService;
  registerAutomationIpc({ ipc: ipc as never, service, send: vi.fn(), pickDirectory });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  return { handlers, invoke, hub, registry, evaluations, service };
}

describe("registerAutomationIpc", () => {
  it("registers only AgentRecall-prefixed automation channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].length).toBeGreaterThan(30);
    expect([...handlers.keys()].every((channel) => channel.startsWith("automation:"))).toBe(true);
  });

  it("loads the overview snapshot without starting the execution engine", async () => {
    const { invoke, service } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.snapshot)).resolves.toEqual({ workDir: "/repo" });

    expect(service.requirePrepared).toHaveBeenCalledOnce();
    expect(service.requireReady).not.toHaveBeenCalled();
  });

  it("opens the directory picker without a default when Chat passes an empty work directory", async () => {
    const pickDirectory = vi.fn(async () => "/repo");
    const { invoke } = setup(pickDirectory);

    await expect(invoke(AUTOMATION_CHANNELS.directoryPick, "")).resolves.toBe("/repo");
    expect(pickDirectory).toHaveBeenCalledWith(undefined);
  });

  it("validates and delegates runtime channel saves", async () => {
    const { invoke, hub } = setup();
    const channels = [{ id: "codex-local", label: "Codex", agentId: "codex", models: [] }];

    await expect(invoke(AUTOMATION_CHANNELS.runtimeSaveChannels, channels)).resolves.toEqual({ channels });
    expect(hub.saveModelChannels).toHaveBeenCalledWith(channels);
    await expect(invoke(AUTOMATION_CHANNELS.runtimeSaveChannels, [{ id: "" }])).rejects.toThrow(/id/i);
  });

  it("validates Agent instructions and MCP bindings before saving", async () => {
    const { invoke, hub } = setup();
    const agent = {
      id: "agent-1",
      agentType: "execution",
      name: "Agent",
      description: "",
      instructions: "Follow project policy.",
      runtimeAgentId: "codex",
      channelId: "codex-openai",
      modelId: "default",
      tags: [],
      mcpBindings: [{ serverId: "docs", toolAllowlist: ["search"] }],
      createdAt: 1,
      updatedAt: 1,
    };

    await expect(invoke(AUTOMATION_CHANNELS.runtimeSaveAgents, [agent]))
      .resolves.toEqual({ configuredAgents: [agent] });
    expect(hub.updateConfiguredAgents).toHaveBeenCalledWith([agent]);

    await expect(invoke(AUTOMATION_CHANNELS.runtimeSaveAgents, [{
      ...agent,
      mcpBindings: "not-an-array",
    }])).rejects.toThrow(/array/i);
  });

  it("rejects unsafe MCP URLs before touching the registry", async () => {
    const { invoke, registry } = setup();
    const server = {
      id: "docs",
      name: "Docs",
      transport: "http",
      url: "file:///tmp/secrets",
      args: [],
      env: {},
      enabled: true,
      tools: [],
      status: "untested",
      createdAt: 1,
      updatedAt: 1,
    };

    await expect(invoke(AUTOMATION_CHANNELS.mcpSave, server)).rejects.toThrow(/http/i);
    expect(registry.upsert).not.toHaveBeenCalled();
  });

  it("refreshes runtime MCP state and removes stale Agent bindings after deletion", async () => {
    const { invoke, hub, registry } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.mcpDelete, "docs")).resolves.toBe(true);

    expect(registry.delete).toHaveBeenCalledWith("docs");
    expect(hub.setMcpServers).toHaveBeenCalledWith([]);
    expect(hub.updateConfiguredAgents).toHaveBeenCalledWith([
      expect.objectContaining({ id: "agent-1", mcpBindings: [] }),
    ]);
  });

  it("bounds workflow planning input at the IPC boundary", async () => {
    const { invoke, hub } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.workflowDraftSend, {
      workflowId: "wf-1",
      reply: "x".repeat(200_001),
    })).rejects.toThrow(/too big|too long|maximum/i);
    expect(hub.sendWorkflowDraftReply).not.toHaveBeenCalled();
  });

  it("validates and delegates Evaluation datasets", async () => {
    const { invoke, evaluations } = setup();
    const dataset = {
      id: "dataset-1",
      name: "Regression",
      description: "Core cases",
      items: [{ id: "case-1", input: "Explain this", metadata: {}, sequence: 0 }],
      createdAt: 1,
      updatedAt: 1,
    };

    await expect(invoke(AUTOMATION_CHANNELS.evaluationDatasetSave, dataset)).resolves.toEqual(dataset);
    expect(evaluations.saveDataset).toHaveBeenCalledWith(dataset);

    await expect(invoke(AUTOMATION_CHANNELS.evaluationDatasetSave, {
      ...dataset,
      items: [{ ...dataset.items[0], input: "x".repeat(200_001) }],
    })).rejects.toThrow(/too big|too long|maximum/i);
    expect(evaluations.saveDataset).toHaveBeenCalledTimes(1);
  });

  it("bounds Evaluation repetitions and runs only saved experiments", async () => {
    const { invoke, evaluations } = setup();
    const experiment = {
      id: "experiment-1",
      name: "Regression",
      datasetId: "dataset-1",
      agentId: "agent-1",
      evaluatorIds: ["evaluator-1"],
      repetitions: 6,
      createdAt: 1,
      updatedAt: 1,
    };

    await expect(invoke(AUTOMATION_CHANNELS.evaluationExperimentSave, experiment)).rejects.toThrow(/less than or equal|maximum|too big/i);
    expect(evaluations.saveExperiment).not.toHaveBeenCalled();

    await expect(invoke(AUTOMATION_CHANNELS.evaluationExperimentRun, { experimentId: "experiment-1" })).resolves.toEqual({ experimentId: "experiment-1" });
    expect(evaluations.runExperiment).toHaveBeenCalledWith("experiment-1");
  });
});
