import type { IpcMain } from "electron";
import { z } from "zod";
import type {
  AgentChannel,
  ConfiguredAgent,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  McpExternalClientUpdate,
  McpServerDefinition,
} from "../../automation/contracts";
import { loadClaudeDefaultConfig, loadCodexDefaultConfig } from "../../automation/engine/main/channels/model-config";
import { AUTOMATION_CHANNELS } from "../../shared/ipc/automation";
import type { NativeAutomationService } from "../services/automation-service";

const idSchema = z.string().trim().min(1).max(256);
const pathSchema = z.string().trim().min(1).max(8_192);
const runtimeIdSchema = z.enum(["codex", "claude", "dsh", "api", "hermes", "opencode", "openclaw"]);
const channelSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(200),
  agentId: runtimeIdSchema,
  models: z.array(z.object({
    id: idSchema,
    label: z.string().trim().min(1).max(200),
  }).passthrough()).max(500),
}).passthrough();
const agentSchema = z.object({
  id: idSchema,
  agentType: z.enum(["execution", "composed"]).optional(),
  name: z.string().trim().min(1).max(200),
  instructions: z.string().max(500_000).optional(),
  baseAgentId: idSchema.optional(),
  runtimeAgentId: runtimeIdSchema,
  channelId: idSchema,
  modelId: idSchema,
  reasoningEffort: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(20_000),
  tags: z.array(z.string().max(200)).max(200),
  mcpBindings: z.array(z.object({
    serverId: idSchema,
    toolAllowlist: z.array(z.string().trim().min(1).max(512)).max(1_000),
  }).strict()).max(200).optional(),
  currentRevisionId: idSchema.optional(),
  revision: z.number().int().positive().max(1_000_000_000).optional(),
  managed: z.boolean().optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).strict();
const timestampSchema = z.number().finite().nonnegative();

function isBoundedJsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 200_000;
  if (depth >= 8) return false;
  if (Array.isArray(value)) {
    return value.length <= 1_000 && value.every((item) => isBoundedJsonValue(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.length <= 500 && entries.every(
    ([key, item]) => key.length <= 200 && isBoundedJsonValue(item, depth + 1),
  );
}

const evaluationMetadataSchema = z.record(z.string().max(200), z.unknown()).refine(
  (value) => isBoundedJsonValue(value),
  "Evaluation metadata must be bounded JSON data.",
);
const evaluationDatasetSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(20_000),
  items: z.array(z.object({
    id: idSchema,
    input: z.string().min(1).max(200_000),
    expectedOutput: z.string().max(200_000).optional(),
    metadata: evaluationMetadataSchema,
    sequence: z.number().int().nonnegative(),
  }).strict()).max(5_000),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
const evaluationEvaluatorSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["contains", "exact_match", "json_valid", "llm_judge", "tool_failures", "trajectory_budget", "script"]),
  prompt: z.string().max(500_000).optional(),
  runtimeId: idSchema.optional(),
  threshold: z.number().finite().min(0).max(1),
  enabled: z.boolean(),
  // A dimension is free text because it is a label the user chooses; the scoring
  // config weights whatever names come back.
  dimension: z.string().trim().max(120).optional(),
  priority: z.enum(["must", "should"]).optional(),
  maxToolFailures: z.number().int().nonnegative().max(10_000).optional(),
  // Positive or absent, unlike the tolerance above: a budget of zero would forbid
  // any work at all, so an unbudgeted metric is omitted rather than set to 0.
  maxTurns: z.number().int().positive().max(10_000).optional(),
  maxToolCalls: z.number().int().positive().max(100_000).optional(),
  maxTotalTokens: z.number().int().positive().max(1_000_000_000).optional(),
  maxDurationMs: z.number().int().positive().max(86_400_000).optional(),
  scriptMode: z.enum(["inline_js", "command"]).optional(),
  script: z.string().max(200_000).optional(),
  command: z.string().trim().max(4_000).optional(),
  commandArgs: z.array(z.string().max(4_000)).max(100).optional(),
  subject: z.enum(["artifact", "trajectory"]).optional(),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
const evaluationScoringSchema = z.object({
  weightByLabels: z.record(
    z.string().max(120),
    z.record(z.string().max(120), z.number().finite().min(0).max(1_000)),
  ).optional(),
  resolvedThreshold: z.number().finite().min(0).max(1).optional(),
  minCoverage: z.number().finite().min(0).max(1).optional(),
  uncertain: z.enum(["exclude", "zero"]).optional(),
}).strict();
const evaluationGraphBindingSchema = z.union([
  z.string().min(3).max(200),
  z.object({ from: z.string().min(3).max(200), onFailure: z.boolean().optional() }).strict(),
]);
const evaluationGraphNodeSchema = z.object({
  id: z.string().trim().min(1).max(80),
  type: z.string().trim().min(1).max(80),
  enabled: z.boolean().optional(),
  // Node config is per node type and validated by the graph builder before a run;
  // the bound here only keeps an unreasonable payload out of the database.
  config: z.record(z.string().max(80), z.unknown()).optional(),
  in: z.record(z.string().max(80), evaluationGraphBindingSchema).optional(),
  after: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
}).strict();
const evaluationExperimentGraphSchema = z.object({
  version: z.number().int().min(1).max(1_000_000),
  spec: z.object({
    name: z.string().trim().min(1).max(200),
    version: z.number().int().min(1).max(1_000_000),
    nodes: z.array(evaluationGraphNodeSchema).min(1).max(200),
  }).strict(),
  layout: z.record(
    z.string().max(80),
    z.object({ x: z.number(), y: z.number() }).strict(),
  ),
}).strict();
const evaluationStageSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  boundaryKind: z.enum(["file_written", "tool_called", "message_contains"]),
  // Only `file_written` is compiled to a regular expression, which runs with no
  // timeout and cannot be interrupted mid-match, so only that kind needs its
  // wildcards capped: a boundary there is a filename shape, not a regex a user is
  // invited to make pathological. The other two compare a literal.
  pattern: z.string().trim().min(1).max(200),
}).strict().superRefine((stage, context) => {
  if (stage.boundaryKind !== "file_written") return;
  if ((stage.pattern.match(/\*/g)?.length ?? 0) > 16) {
    context.addIssue({
      code: "custom",
      path: ["pattern"],
      message: "a stage pattern may use at most 16 wildcards",
    });
  }
});
const evaluationExperimentSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  datasetId: idSchema,
  agentId: idSchema,
  evaluatorIds: z.array(idSchema).max(500),
  repetitions: z.number().int().min(1).max(5),
  // Where each case's artifact comes from, and how its verdicts are combined.
  source: z.enum(["run_agent", "session", "folder"]).optional(),
  scoring: evaluationScoringSchema.nullish(),
  // Low cap: every stage becomes a step in every case's graph, and every check
  // bound to one becomes a judge call of its own.
  stages: z.array(evaluationStageSchema).max(10).nullish(),
  // Which stage each check is bound to. On the plan rather than on the check:
  // one check library is shared, and the same check can sit at a different stage
  // of a different skill.
  stageByEvaluatorId: z.record(z.string().max(80), z.string().max(80)).nullish(),
  // Skill binding and the authored graph travel with the experiment, so an
  // experiment loaded from the store can be saved back without losing either.
  skillName: z.string().trim().max(200).nullish(),
  skillHash: z.string().trim().max(200).nullish(),
  graph: evaluationExperimentGraphSchema.nullish(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  const assignments = value.stageByEvaluatorId;
  if (!assignments) return;
  const declared = new Set((value.stages ?? []).map((stage) => stage.id));
  for (const [evaluatorId, stageId] of Object.entries(assignments)) {
    if (declared.has(stageId)) continue;
    context.addIssue({
      code: "custom",
      path: ["stageByEvaluatorId", evaluatorId],
      message: "A check can only be bound to a stage this plan declares.",
    });
  }
});
const evaluationRunListSchema = z.object({
  experimentId: idSchema.optional(),
  offset: z.number().int().nonnegative().max(1_000_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
const evaluationArtifactOpenSchema = z.object({
  runId: idSchema,
  resultId: idSchema,
}).strict();
const mcpExternalClientUpdateSchema = z.object({
  clientId: z.enum(["codex", "claude"]),
  enabled: z.boolean(),
}).strict();
const mcpToolSchema = z.object({
  name: idSchema,
  description: z.string().max(20_000).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});
const mcpServerSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  transport: z.enum(["stdio", "http"]),
  command: z.string().trim().max(8_192).optional(),
  args: z.array(z.string().max(8_192)).max(200),
  url: z.string().trim().max(8_192).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(512)),
  headers: z.record(z.string().max(512), z.string().max(512)).optional(),
  enabled: z.boolean(),
  tools: z.array(mcpToolSchema).max(5_000),
  disabledTools: z.array(z.string().max(8_192)).max(5_000).optional(),
  status: z.enum(["untested", "connected", "error"]),
  lastError: z.string().max(20_000).optional(),
  lastTestedAt: z.number().finite().optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).superRefine((server, context) => {
  if (server.transport === "stdio" && !server.command) {
    context.addIssue({ code: "custom", path: ["command"], message: "MCP stdio command is required." });
  }
  if (server.transport === "http") {
    try {
      const protocol = new URL(server.url ?? "").protocol;
      if (protocol !== "http:" && protocol !== "https:") throw new Error("unsupported");
    } catch {
      context.addIssue({ code: "custom", path: ["url"], message: "MCP URL must use http or https." });
    }
  }
});

interface RegisterAutomationIpcOptions {
  ipc: Pick<IpcMain, "handle">;
  service: NativeAutomationService;
  send: (channel: string, payload: unknown) => void;
  pickDirectory?: (defaultPath?: string) => Promise<string | undefined>;
  openEvaluationArtifact?: (request: { runId: string; resultId: string }) => Promise<string>;
}

export function registerAutomationIpc({
  ipc,
  service,
  send,
  pickDirectory,
  openEvaluationArtifact,
}: RegisterAutomationIpcOptions): () => void {
  const ready = <Args extends unknown[], Result>(
    channel: string,
    handler: (...args: Args) => Result | Promise<Result>,
  ): void => {
    ipc.handle(channel, async (_event, ...args: Args) => {
      await service.requireReady();
      return handler(...args);
    });
  };
  const prepared = <Args extends unknown[], Result>(
    channel: string,
    handler: (...args: Args) => Result | Promise<Result>,
  ): void => {
    ipc.handle(channel, async (_event, ...args: Args) => {
      await service.requirePrepared();
      return handler(...args);
    });
  };

  ipc.handle(AUTOMATION_CHANNELS.health, () => service.health());
  prepared(AUTOMATION_CHANNELS.snapshot, () => service.snapshot());
  ready(AUTOMATION_CHANNELS.runtimeSaveChannels, (value: unknown) =>
    service.runtime.saveModelChannels(
      z.array(channelSchema).max(500).parse(value) as AgentChannel[],
      { validateDeletedChannelReferences: true },
    ));
  ready(AUTOMATION_CHANNELS.runtimeSaveAgents, (value: unknown) =>
    service.updateConfiguredAgents(
      z.array(agentSchema).max(500).parse(value) as ConfiguredAgent[],
      { detectDeletedManagedAgents: true },
    ));
  ready(AUTOMATION_CHANNELS.runtimeDeleteAgent, (value: unknown) =>
    service.deleteConfiguredAgent(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.runtimeTestChannel, (value: unknown) =>
    service.runtime.testRuntimeChannel(idSchema.parse(value), (event) => send(AUTOMATION_CHANNELS.runtimeTestEvent, event)));
  ready(AUTOMATION_CHANNELS.runtimeTestAgent, (value: unknown) =>
    service.runtime.testConfiguredAgent(idSchema.parse(value), (event) => send(AUTOMATION_CHANNELS.runtimeTestEvent, event)));
  ready(AUTOMATION_CHANNELS.runtimeBalance, (value: unknown) => service.runtime.queryRuntimeChannelBalance(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.runtimeLoadCodexDefault, () => loadCodexDefaultConfig());
  ready(AUTOMATION_CHANNELS.runtimeLoadClaudeDefault, () => loadClaudeDefaultConfig());
  ready(AUTOMATION_CHANNELS.runtimeImportLocal, (value: unknown) => {
    const request = z.object({ runtimeId: runtimeIdSchema, channelId: idSchema.optional() }).parse(value);
    return service.runtime.importRuntimeLocalConfig(request.runtimeId, request.channelId);
  });
  ready(AUTOMATION_CHANNELS.runtimeRefreshModels, (value: unknown) => service.runtime.refreshModelCatalog(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.runtimeListCodexPlugins, () => service.runtime.listCodexPluginCatalog());
  ready(AUTOMATION_CHANNELS.workDirSet, (value: unknown) => {
    service.runtime.setWorkDir(pathSchema.parse(value));
    return service.runtime.snapshot();
  });
  ready(AUTOMATION_CHANNELS.workDirChoose, async () => {
    if (!pickDirectory) throw new Error("Directory picker is unavailable.");
    const selected = await pickDirectory(service.runtime.getWorkDir());
    if (selected) service.runtime.setWorkDir(pathSchema.parse(selected));
    return service.runtime.snapshot();
  });
  ready(AUTOMATION_CHANNELS.directoryPick, async (value: unknown) => {
    if (!pickDirectory) throw new Error("Directory picker is unavailable.");
    const defaultPath = value === undefined || value === "" ? undefined : pathSchema.parse(value);
    return pickDirectory(defaultPath);
  });

  ready(AUTOMATION_CHANNELS.mcpList, () => service.mcp.list());
  ready(AUTOMATION_CHANNELS.mcpSave, (value: unknown) =>
    service.mcp.save(mcpServerSchema.parse(value) as McpServerDefinition));
  ready(AUTOMATION_CHANNELS.mcpTest, (value: unknown) =>
    service.mcp.test(mcpServerSchema.parse(value) as McpServerDefinition));
  ready(AUTOMATION_CHANNELS.mcpDelete, (value: unknown) =>
    service.mcp.delete(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.mcpClientConnections, () => service.mcp.clientConnections());
  ready(AUTOMATION_CHANNELS.mcpClientSet, (value: unknown) =>
    service.mcp.setClientConnection(mcpExternalClientUpdateSchema.parse(value) as McpExternalClientUpdate));

  ready(AUTOMATION_CHANNELS.evaluationDatasetList, () => service.evaluations.listDatasets());
  ready(AUTOMATION_CHANNELS.evaluationDatasetSave, (value: unknown) =>
    service.evaluations.saveDataset(evaluationDatasetSchema.parse(value) as EvaluationDataset));
  ready(AUTOMATION_CHANNELS.evaluationDatasetDelete, (value: unknown) =>
    service.evaluations.deleteDataset(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationDatasetFolderImport, () =>
    service.evaluations.importDatasetFolder());
  ready(AUTOMATION_CHANNELS.evaluationDatasetFolderExport, (value: unknown) =>
    service.evaluations.exportDatasetFolder(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationEvaluatorList, () => service.evaluations.listEvaluators());
  ready(AUTOMATION_CHANNELS.evaluationEvaluatorSave, (value: unknown) =>
    service.evaluations.saveEvaluator(evaluationEvaluatorSchema.parse(value) as EvaluationEvaluator));
  ready(AUTOMATION_CHANNELS.evaluationEvaluatorDelete, (value: unknown) =>
    service.evaluations.deleteEvaluator(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationExperimentList, () => service.evaluations.listExperiments());
  ready(AUTOMATION_CHANNELS.evaluationExperimentSave, (value: unknown) =>
    service.evaluations.saveExperiment(evaluationExperimentSchema.parse(value) as EvaluationExperiment));
  ready(AUTOMATION_CHANNELS.evaluationExperimentDelete, (value: unknown) =>
    service.evaluations.deleteExperiment(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationExperimentRun, (value: unknown) => {
    const request = z.object({ experimentId: idSchema }).strict().parse(value);
    return service.evaluations.runExperiment(request.experimentId);
  });
  ready(AUTOMATION_CHANNELS.evaluationRunList, (value: unknown) =>
    service.evaluations.listRuns(value === undefined ? undefined : evaluationRunListSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationRunGet, (value: unknown) =>
    service.evaluations.getRun(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationRunDelete, (value: unknown) =>
    service.evaluations.deleteRun(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationArtifactOpen, async (value: unknown) => {
    if (!openEvaluationArtifact) throw new Error("Opening evaluation artifacts is unavailable.");
    return openEvaluationArtifact(evaluationArtifactOpenSchema.parse(value));
  });

  const unsubscribeSnapshot = service.subscribe((snapshot) => send(AUTOMATION_CHANNELS.snapshotChanged, snapshot));
  return unsubscribeSnapshot;
}
