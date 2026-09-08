import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_CHANNELS } from "../shared/ipc/automation";
import type { McpServerDefinition, McpToolDefinition } from "../automation/engine/shared/mcp/types";
import type { NativeAutomationService } from "./services/automation-service";
import { McpAutomationModule } from "./services/mcp-automation-module";
import { registerAutomationIpc } from "./ipc/automation";

type FakeBuiltin = {
  isBuiltinId: (id: string) => boolean;
  resolve: () => Promise<McpServerDefinition>;
  saveDraft: (server: McpServerDefinition) => Promise<McpServerDefinition>;
  recordTest: (server: McpServerDefinition, tools: McpToolDefinition[], error?: string) => Promise<McpServerDefinition>;
  testEnv: () => Record<string, string>;
};

function setup(
  pickDirectory?: (defaultPath?: string) => Promise<string | undefined>,
  builtins?: FakeBuiltin[],
  openEvaluationArtifact?: (request: { runId: string; resultId: string }) => Promise<string>,
) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let workflowRunStreamListener: ((event: unknown) => void) | undefined;
  const unsubscribeWorkflowRunStream = vi.fn();
  const send = vi.fn();
  const ipc = {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler)),
  };
  const hub = {
    saveModelChannels: vi.fn(async (value) => ({ channels: value })),
    updateConfiguredAgents: vi.fn((value, _options?: { detectDeletedManagedAgents?: boolean }) => ({ configuredAgents: value })),
    importRuntimeLocalConfig: vi.fn(async (runtimeId: string, channelId?: string) => ({
      runtimeId,
      channelId: channelId ?? `${runtimeId}-default`,
      source: `${runtimeId} settings`,
      snapshot: { channels: [] },
    })),
    createWorkflowDraft: vi.fn((value) => ({ workflowDraft: value })),
    sendWorkflowDraftReply: vi.fn(async (value) => ({ workflowDraft: value })),
    applyWorkflowReviewToManager: vi.fn(async (value) => ({ workflowDraft: value })),
    setMcpServers: vi.fn(),
    flushPersistence: vi.fn(async () => undefined),
    listConfiguredAgents: vi.fn(() => [{
      id: "agent-1", name: "Agent", description: "", runtimeAgentId: "codex", channelId: "codex-openai",
      modelId: "default", tags: [], mcpBindings: [{ serverId: "docs", toolAllowlist: [] }], createdAt: 1, updatedAt: 1,
    }]),
  };
  const registry = {
    upsert: vi.fn(async (value) => value),
    list: vi.fn(async (): Promise<McpServerDefinition[]> => []),
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
  const mcpClients = {
    snapshot: vi.fn(() => ({ clients: [] })),
    setEnabled: vi.fn(() => ({ clients: [] })),
  };
  const discoverTools = vi.fn(async () => []);
  const mcp = new McpAutomationModule({
    registry: registry as never,
    runtime: hub as never,
    builtins: (builtins ?? []) as never,
    discoverTools,
    clients: mcpClients,
  });
  const service = {
    requirePrepared: vi.fn(async () => undefined),
    requireReady: vi.fn(async () => undefined),
    health: vi.fn(() => ({ state: "ready" })),
    workflowSidebar: vi.fn(async () => ({ workflows: [{ workflowId: "workflow-1" }] })),
    workflowWorkbench: vi.fn(async () => ({
      workflows: [{
        workflow: { workflowId: "workflow-1", title: "Workflow" },
        nodeCount: 1,
        status: "running",
        updatedAt: 2,
      }],
      totalCount: 1,
      activeCount: 1,
    })),
    snapshot: vi.fn(() => ({ workDir: "/repo" })),
    subscribe: vi.fn(() => () => undefined),
    subscribeChanges: vi.fn(() => () => undefined),
    subscribeWorkflowRunStream: vi.fn((listener) => {
      workflowRunStreamListener = listener;
      return unsubscribeWorkflowRunStream;
    }),
    runtime: hub,
    updateConfiguredAgents: vi.fn((value, options) => hub.updateConfiguredAgents(value, options)),
    deleteConfiguredAgent: vi.fn(async (agentId: string) => ({ configuredAgents: hub.listConfiguredAgents().filter((agent) => agent.id !== agentId) })),
    workflows: hub,
    workflowPlanning: { reply: vi.fn(async (_request: unknown, _signal: AbortSignal) => ({ agentId: "agent", messages: [] })) },
    workflowCore: {
      snapshot: vi.fn(async () => ({ definitions: [], runs: [] })),
      saveDefinition: vi.fn(async (value) => value),
      deleteDefinition: vi.fn(async () => undefined),
      startRun: vi.fn(async (workflowId, inputs) => ({ id: "run-1", workflowId, inputs })),
      pauseRun: vi.fn(async (runId) => ({ id: runId, status: "paused" })),
      resumeRun: vi.fn(async (runId) => ({ id: runId, status: "running" })),
      cancelRun: vi.fn(async (runId) => ({ id: runId, status: "cancelled" })),
      retryNode: vi.fn(async (runId, nodeId) => ({ id: runId, nodeId })),
      resolveApproval: vi.fn(async (runId, nodeId, outputs) => ({ id: runId, nodeId, outputs })),
    },
    mcp,
    evaluations,
    portableWorkflows: {
      cloneOfficialWorkflow: vi.fn(async (workflowId) => ({ workflowId })),
      beginImport: vi.fn(async () => ({ previewToken: "workflow_import_1" })),
      confirmImport: vi.fn(async (previewToken, mapping) => ({ previewToken, mapping })),
      cancelImport: vi.fn(),
      exportWorkflow: vi.fn(async () => ({ status: "exported" })),
    },
    resolveRuntimeApproval: vi.fn(),
  } as unknown as NativeAutomationService;
  const dispose = registerAutomationIpc({
    ipc: ipc as never,
    service,
    send,
    pickDirectory,
    openEvaluationArtifact,
  });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  return {
    handlers,
    invoke,
    hub,
    registry,
    evaluations,
    service,
    discoverTools,
    mcpClients,
    send,
    dispose,
    unsubscribeWorkflowRunStream,
    emitWorkflowRunStream: (event: unknown) => workflowRunStreamListener?.(event),
  };
}

describe("registerAutomationIpc", () => {
  it("validates and opens one concrete evaluation artifact", async () => {
    const openEvaluationArtifact = vi.fn(async () => "/data/evaluation-artifacts/result.md");
    const { invoke } = setup(undefined, undefined, openEvaluationArtifact);

    await expect(invoke(AUTOMATION_CHANNELS.evaluationArtifactOpen, {
      runId: "run-1",
      resultId: "result-1",
    })).resolves.toBe("/data/evaluation-artifacts/result.md");
    expect(openEvaluationArtifact).toHaveBeenCalledWith({ runId: "run-1", resultId: "result-1" });
    await expect(invoke(AUTOMATION_CHANNELS.evaluationArtifactOpen, {
      runId: "../run",
      resultId: "",
    })).rejects.toThrow();
  });

  it("forwards ephemeral Workflow Runtime output and unsubscribes on cleanup", () => {
    const { send, dispose, emitWorkflowRunStream, unsubscribeWorkflowRunStream } = setup();
    const event = {
      runId: "run-1",
      nodeId: "agent-1",
      type: "delta",
      content: "hello",
      timestamp: 10,
    };

    emitWorkflowRunStream(event);
    expect(send).toHaveBeenCalledWith(AUTOMATION_CHANNELS.workflowRunStream, event);

    dispose();
    expect(unsubscribeWorkflowRunStream).toHaveBeenCalledOnce();
  });

  it("owns planning cancellation by window and cleans up listeners after completion or reload", async () => {
    const { handlers, service } = setup();
    const owner = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
    const request = { requestId: "planning-1", agentId: "agent", message: "Plan this task", intent: "interview",
      definition: { id: "workflow", name: "Plan", description: "Goal", inputs: [], nodes: [], createdAt: 1, updatedAt: 1 } };
    let finish!: () => void;
    let signal!: AbortSignal;
    vi.mocked(service.workflowPlanning.reply).mockImplementationOnce(async (_request, abortSignal) => {
      signal = abortSignal;
      await new Promise<void>((resolve) => { finish = resolve; });
      return { agentId: "agent", messages: [] };
    });
    const turn = handlers.get(AUTOMATION_CHANNELS.workflowPlanningReply)!({ sender: owner }, request);
    await Promise.resolve();
    handlers.get(AUTOMATION_CHANNELS.workflowPlanningCancel)!({ sender: { id: 2 } }, request.requestId);
    expect(signal.aborted).toBe(false);
    handlers.get(AUTOMATION_CHANNELS.workflowPlanningCancel)!({ sender: owner }, request.requestId);
    expect(signal.aborted).toBe(true);
    finish();
    await turn;
    expect(owner.eventNames()).toEqual([]);

    vi.mocked(service.workflowPlanning.reply).mockImplementationOnce(async (_request, abortSignal) => {
      signal = abortSignal;
      await new Promise<void>((resolve) => { finish = resolve; });
      return { agentId: "agent", messages: [] };
    });
    const nextTurn = handlers.get(AUTOMATION_CHANNELS.workflowPlanningReply)!({ sender: owner }, request);
    await Promise.resolve();
    owner.emit("did-start-navigation");
    expect(signal.aborted).toBe(true);
    finish();
    await nextTurn;
    expect(owner.eventNames()).toEqual([]);
    await expect(handlers.get(AUTOMATION_CHANNELS.workflowPlanningReply)!({ sender: owner }, { ...request, definition: { id: "broken" } })).rejects.toThrow();
  });

  it("routes the structured Workflow API through Workflow Core", async () => {
    const { invoke, service } = setup();
    const definition = {
      id: "workflow-1", name: "Workflow", description: "Description", inputs: [], nodes: [], createdAt: 1, updatedAt: 1,
    };

    await expect(invoke(AUTOMATION_CHANNELS.workflowCoreGet, "workflow-1")).resolves.toEqual({ definitions: [], runs: [] });
    await expect(invoke(AUTOMATION_CHANNELS.workflowDefinitionSave, definition)).resolves.toEqual(definition);
    await expect(invoke(AUTOMATION_CHANNELS.workflowDefinitionDelete, { workflowId: "workflow-1" })).resolves.toBeUndefined();
    await expect(invoke(AUTOMATION_CHANNELS.workflowRunStart, { workflowId: "workflow-1", inputs: { source: "resume" } })).resolves.toMatchObject({ id: "run-1" });
    await expect(invoke(AUTOMATION_CHANNELS.workflowRunPause, { runId: "run-1" })).resolves.toMatchObject({ status: "paused" });
    await expect(invoke(AUTOMATION_CHANNELS.workflowRunResume, { runId: "run-1" })).resolves.toMatchObject({ status: "running" });
    await expect(invoke(AUTOMATION_CHANNELS.workflowRunCancel, { runId: "run-1" })).resolves.toMatchObject({ status: "cancelled" });
    await expect(invoke(AUTOMATION_CHANNELS.workflowNodeRetry, { runId: "run-1", nodeId: "answer" })).resolves.toMatchObject({ nodeId: "answer" });
    await expect(invoke(AUTOMATION_CHANNELS.workflowApprovalResolve, { runId: "run-1", nodeId: "approve", outputs: { decision: "yes" } })).resolves.toMatchObject({ outputs: { decision: "yes" } });

    expect(service.workflowCore.snapshot).toHaveBeenCalledWith("workflow-1");
    await expect(invoke(AUTOMATION_CHANNELS.workflowRunStart, { workflowId: "workflow-1", inputs: { huge: () => undefined } })).rejects.toThrow();
  });

  it("registers only AgentRecall-prefixed automation channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].length).toBeGreaterThan(30);
    expect([...handlers.keys()].every((channel) => channel.startsWith("automation:"))).toBe(true);
  });

  it("keeps HTTP header references through the IPC schema for save and test", async () => {
    const { invoke, registry } = setup();
    const server: McpServerDefinition = {
      id: "remote-http",
      name: "Remote HTTP",
      transport: "http",
      args: [],
      url: "https://example.test/mcp",
      env: {},
      headers: { Authorization: "HOST_HTTP_TOKEN" },
      enabled: true,
      tools: [],
      disabledTools: [],
      status: "untested",
      createdAt: 1,
      updatedAt: 1,
    };

    await invoke(AUTOMATION_CHANNELS.mcpSave, server);
    expect(registry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { Authorization: "HOST_HTTP_TOKEN" } }),
    );

    await invoke(AUTOMATION_CHANNELS.mcpTest, server);
    expect(registry.recordTest).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { Authorization: "HOST_HTTP_TOKEN" } }),
      [],
      undefined,
    );
  });

  it("validates portable Workflow identifiers and mapping payloads", async () => {
    const { invoke, service } = setup();
    const portable = service.portableWorkflows;

    await expect(invoke(AUTOMATION_CHANNELS.workflowCloneOfficial, "official-1")).resolves.toEqual({ workflowId: "official-1" });
    await expect(invoke(AUTOMATION_CHANNELS.workflowImportConfirm, { previewToken: "workflow_import_1", agentMappings: { missing: "agent-1" } })).resolves.toMatchObject({ previewToken: "workflow_import_1" });
    expect(portable.confirmImport).toHaveBeenCalledWith("workflow_import_1", { previewToken: "workflow_import_1", agentMappings: { missing: "agent-1" } });
    await expect(invoke(AUTOMATION_CHANNELS.workflowImportConfirm, { previewToken: "", definition: {} })).rejects.toThrow();
  });

  it("loads the overview snapshot without starting the execution engine", async () => {
    const { invoke, service } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.snapshot)).resolves.toEqual({ workDir: "/repo" });

    expect(service.requirePrepared).toHaveBeenCalledOnce();
    expect(service.requireReady).not.toHaveBeenCalled();
  });

  it("loads Workflow sidebar records without waiting for full state preparation", async () => {
    const { invoke, service } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.workflowSidebar)).resolves.toEqual({
      workflows: [{ workflowId: "workflow-1" }],
    });

    expect(service.workflowSidebar).toHaveBeenCalledOnce();
    expect(service.requirePrepared).not.toHaveBeenCalled();
    expect(service.requireReady).not.toHaveBeenCalled();
  });

  it("routes the lightweight Workflow workbench summary without a ready wrapper", async () => {
    const { invoke, service } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.workflowWorkbench)).resolves.toMatchObject({
      workflows: [{
        workflow: { workflowId: "workflow-1", title: "Workflow" },
        status: "running",
      }],
      totalCount: 1,
      activeCount: 1,
    });

    expect(service.workflowWorkbench).toHaveBeenCalledOnce();
    expect(service.requirePrepared).not.toHaveBeenCalled();
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
    const channels = [{ id: "dsh-default", label: "DeepSeek Harness", agentId: "dsh", models: [] }];

    await expect(invoke(AUTOMATION_CHANNELS.runtimeSaveChannels, channels)).resolves.toEqual({ channels });
    expect(hub.saveModelChannels).toHaveBeenCalledWith(channels, { validateDeletedChannelReferences: true });
    await expect(invoke(AUTOMATION_CHANNELS.runtimeSaveChannels, [{ id: "" }])).rejects.toThrow(/id/i);
    await expect(invoke(AUTOMATION_CHANNELS.runtimeSaveChannels, [{
      ...channels[0],
      agentId: "unsupported-runtime",
    }])).rejects.toThrow();
  });

  it("validates Agent instructions and MCP bindings before saving", async () => {
    const { invoke, service } = setup();
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
    expect(service.updateConfiguredAgents).toHaveBeenCalledWith([agent], { detectDeletedManagedAgents: true });

    await expect(invoke(AUTOMATION_CHANNELS.runtimeSaveAgents, [{
      ...agent,
      mcpBindings: "not-an-array",
    }])).rejects.toThrow(/array/i);
    await expect(invoke(AUTOMATION_CHANNELS.runtimeSaveAgents, [{
      ...agent,
      runtimeAgentId: "unsupported-runtime",
    }])).rejects.toThrow();
  });

  it("accepts DeepSeek Harness local imports and rejects unknown runtime ids", async () => {
    const { invoke, hub } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.runtimeImportLocal, {
      runtimeId: "dsh",
      channelId: "dsh-default",
    })).resolves.toMatchObject({
      runtimeId: "dsh",
      channelId: "dsh-default",
    });
    expect(hub.importRuntimeLocalConfig).toHaveBeenCalledWith("dsh", "dsh-default");

    await expect(invoke(AUTOMATION_CHANNELS.runtimeImportLocal, {
      runtimeId: "unsupported-runtime",
    })).rejects.toThrow();
    expect(hub.importRuntimeLocalConfig).toHaveBeenCalledOnce();
  });

  it("validates and delegates deletion using the concrete Agent id", async () => {
    const { invoke, service } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.runtimeDeleteAgent, "agent-1"))
      .resolves.toEqual({ configuredAgents: [] });
    expect(service.deleteConfiguredAgent).toHaveBeenCalledWith("agent-1");
    await expect(invoke(AUTOMATION_CHANNELS.runtimeDeleteAgent, ""))
      .rejects.toThrow(/too small/i);
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

  it("persists disabled tools through the mcpSave schema boundary", async () => {
    const { invoke, registry } = setup();
    const server = {
      id: "docs",
      name: "Docs",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: {},
      enabled: true,
      tools: [{ name: "search", inputSchema: {} }],
      disabledTools: ["search"],
      status: "untested",
      createdAt: 1,
      updatedAt: 1,
    };

    await invoke(AUTOMATION_CHANNELS.mcpSave, server);

    expect(registry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ disabledTools: ["search"] }),
    );
  });

  it("refreshes runtime MCP state and removes stale Agent bindings after deletion", async () => {
    const { invoke, hub, registry } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.mcpDelete, "docs")).resolves.toBe(true);

    expect(registry.delete).toHaveBeenCalledWith("docs");
    expect(hub.setMcpServers).toHaveBeenCalledWith([]);
    expect(hub.updateConfiguredAgents).toHaveBeenCalledWith([
      expect.objectContaining({ id: "agent-1", mcpBindings: [] }),
    ]);
    expect(hub.flushPersistence).toHaveBeenCalledOnce();
  });

  it("updates an external MCP client connection through the main-process boundary", async () => {
    const { invoke, mcpClients } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.mcpClientSet, {
      clientId: "codex",
      enabled: true,
    })).resolves.toEqual({ clients: [] });

    expect(mcpClients.setEnabled).toHaveBeenCalledWith({ clientId: "codex", enabled: true });
  });

  it("rejects malformed external MCP client requests", async () => {
    const { invoke, mcpClients } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.mcpClientSet, {
      clientId: "codebuddy",
      enabled: "yes",
    })).rejects.toThrow();
    expect(mcpClients.setEnabled).not.toHaveBeenCalled();
  });

  it("bounds workflow planning input at the IPC boundary", async () => {
    const { invoke, hub } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.workflowDraftSend, {
      workflowId: "wf-1",
      reply: "x".repeat(200_001),
    })).rejects.toThrow(/too big|too long|maximum/i);
    expect(hub.sendWorkflowDraftReply).not.toHaveBeenCalled();
  });

  it("validates and delegates Review-to-Manager requests", async () => {
    const { invoke, hub } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.workflowReviewApplyToManager, {
      workflowId: "wf-1",
      reviewedRevision: 3,
    })).resolves.toEqual({ workflowDraft: { workflowId: "wf-1", reviewedRevision: 3 } });
    expect(hub.applyWorkflowReviewToManager).toHaveBeenCalledWith({ workflowId: "wf-1", reviewedRevision: 3 });

    await expect(invoke(AUTOMATION_CHANNELS.workflowReviewApplyToManager, {
      workflowId: "wf-1",
      reviewedRevision: 0,
    })).rejects.toThrow();
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

const BUILTIN_ID = "agent-recall-session-search";

function builtinServer(): McpServerDefinition {
  return {
    id: BUILTIN_ID,
    name: "agent-recall-v2",
    transport: "stdio",
    command: "node",
    args: ["/bin/agent-recall-mcp.mjs"],
    env: {},
    enabled: true,
    tools: [],
    disabledTools: [],
    status: "untested",
    createdAt: 1,
    updatedAt: 1,
    managed: true,
  };
}

function createBuiltin() {
  return {
    isBuiltinId: vi.fn((id: string) => id === BUILTIN_ID),
    resolve: vi.fn(async () => builtinServer()),
    saveDraft: vi.fn(async (server: McpServerDefinition) => ({
      ...builtinServer(),
      enabled: server.enabled,
      tools: server.tools,
      disabledTools: server.disabledTools,
    })),
    recordTest: vi.fn(async (server: McpServerDefinition, tools: McpToolDefinition[]) => ({
      ...builtinServer(),
      tools,
      disabledTools: server.disabledTools,
      status: "connected" as const,
    })),
    testEnv: () => ({}),
  };
}

const WORKFLOW_BUILTIN_ID = "agent-recall-workflow";

function workflowBuiltinServer(): McpServerDefinition {
  return {
    id: WORKFLOW_BUILTIN_ID,
    name: "AgentRecall Workflow",
    transport: "stdio",
    command: "node",
    args: ["/out/mcp/workflow-entry.js"],
    env: {},
    enabled: true,
    tools: [],
    disabledTools: [],
    status: "untested",
    createdAt: 1,
    updatedAt: 1,
    managed: true,
    hubBindable: false,
  };
}

function createWorkflowBuiltin() {
  return {
    isBuiltinId: vi.fn((id: string) => id === WORKFLOW_BUILTIN_ID),
    resolve: vi.fn(async () => workflowBuiltinServer()),
    saveDraft: vi.fn(async (server: McpServerDefinition) => ({
      ...workflowBuiltinServer(),
      enabled: server.enabled,
      tools: server.tools,
      disabledTools: server.disabledTools,
    })),
    recordTest: vi.fn(async (server: McpServerDefinition, tools: McpToolDefinition[]) => ({
      ...workflowBuiltinServer(),
      tools,
      disabledTools: server.disabledTools,
      status: "connected" as const,
    })),
    testEnv: () => ({
      AGENT_RECALL_WORKFLOW_MCP_BRIDGE: "/data/automation-mcp-bridge.json",
      AGENT_RECALL_WORKFLOW_MCP_TOKEN: "secret-token",
    }),
  };
}

describe("registerAutomationIpc with built-in session-search server", () => {
  it("merges the built-in server into the server list", async () => {
    const builtin = createBuiltin();
    const { invoke } = setup(undefined, [builtin]);
    const servers = await invoke(AUTOMATION_CHANNELS.mcpList) as McpServerDefinition[];
    expect(builtin.resolve).toHaveBeenCalled();
    expect(servers).toEqual([expect.objectContaining({ id: BUILTIN_ID, managed: true })]);
  });

  it("routes saves for the built-in server to settings, never the user registry", async () => {
    const builtin = createBuiltin();
    const { invoke, registry } = setup(undefined, [builtin]);
    const saved = await invoke(AUTOMATION_CHANNELS.mcpSave, {
      ...builtinServer(),
      enabled: false,
      tools: [{ name: "search_sessions", inputSchema: {} }],
    }) as McpServerDefinition;

    expect(registry.upsert).not.toHaveBeenCalled();
    expect(builtin.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ id: BUILTIN_ID }));
    expect(saved).toMatchObject({ id: BUILTIN_ID, managed: true, enabled: false });
  });

  it("tests the built-in server against its fixed launch config", async () => {
    const builtin = createBuiltin();
    const { invoke } = setup(undefined, [builtin]);
    await invoke(AUTOMATION_CHANNELS.mcpTest, builtinServer());
    expect(builtin.recordTest).toHaveBeenCalled();
  });

  it("rejects deleting the built-in server", async () => {
    const builtin = createBuiltin();
    const { invoke, registry } = setup(undefined, [builtin]);
    await expect(invoke(AUTOMATION_CHANNELS.mcpDelete, BUILTIN_ID)).rejects.toThrow(/cannot be deleted/i);
    expect(registry.delete).not.toHaveBeenCalled();
  });
});

describe("registerAutomationIpc with built-in workflow server", () => {
  it("merges the workflow built-in server into the server list", async () => {
    const workflow = createWorkflowBuiltin();
    const { invoke } = setup(undefined, [workflow]);
    const servers = await invoke(AUTOMATION_CHANNELS.mcpList) as McpServerDefinition[];
    expect(servers).toEqual([
      expect.objectContaining({ id: WORKFLOW_BUILTIN_ID, managed: true, hubBindable: false }),
    ]);
  });

  it("routes saves for the workflow built-in server to its settings toggle", async () => {
    const workflow = createWorkflowBuiltin();
    const { invoke, registry } = setup(undefined, [workflow]);
    const saved = await invoke(AUTOMATION_CHANNELS.mcpSave, {
      ...workflowBuiltinServer(),
      enabled: false,
    }) as McpServerDefinition;

    expect(registry.upsert).not.toHaveBeenCalled();
    expect(workflow.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ id: WORKFLOW_BUILTIN_ID }));
    expect(saved).toMatchObject({ id: WORKFLOW_BUILTIN_ID, enabled: false });
  });

  it("tests the workflow server with literal bridge env instead of host env names", async () => {
    const workflow = createWorkflowBuiltin();
    const { invoke, discoverTools } = setup(undefined, [workflow]);
    await invoke(AUTOMATION_CHANNELS.mcpTest, workflowBuiltinServer());
    expect(discoverTools).toHaveBeenCalledWith(
      expect.objectContaining({ id: WORKFLOW_BUILTIN_ID, env: {} }),
      { AGENT_RECALL_WORKFLOW_MCP_BRIDGE: "/data/automation-mcp-bridge.json", AGENT_RECALL_WORKFLOW_MCP_TOKEN: "secret-token" },
    );
    expect(workflow.recordTest).toHaveBeenCalled();
  });

  it("rejects deleting the workflow built-in server", async () => {
    const workflow = createWorkflowBuiltin();
    const { invoke, registry } = setup(undefined, [workflow]);
    await expect(invoke(AUTOMATION_CHANNELS.mcpDelete, WORKFLOW_BUILTIN_ID)).rejects.toThrow(/cannot be deleted/i);
    expect(registry.delete).not.toHaveBeenCalled();
  });
});
