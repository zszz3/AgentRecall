import type { IpcMain } from "electron";
import { z } from "zod";
import type {
  AgentChannel,
  ConfiguredAgent,
  ConfirmWorkflowRequest,
  CreateWorkflowDraftRequest,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  InterruptWorkflowNodeConversationRequest,
  InterruptWorkflowReviewRequest,
  ListWorkflowOutputsRequest,
  LocalFilePreview,
  PatchWorkflowDraftRequest,
  PauseWorkflowNodeRequest,
  RejectWorkflowNodeCompletionRequest,
  ResolveWorkflowV2InterventionRequest,
  ResolveRuntimeApprovalRequest,
  ReviewWorkflowRequest,
  ReviseWorkflowV2RunRequest,
  RunWorkflowRequest,
  SendWorkflowDraftReplyRequest,
  SendWorkflowNodeMessageRequest,
  StartWorkflowNodeRequest,
  StopWorkflowRunRequest,
  SubmitWorkflowScriptInputRequest,
  UpdateWorkflowRequest,
  McpServerDefinition,
} from "../../automation/contracts";
import type { McpInstallRequest } from "../../automation/engine/shared/mcp-config";
import { loadClaudeDefaultConfig, loadCodexDefaultConfig } from "../../automation/engine/main/channels/model-config";
import { AUTOMATION_CHANNELS } from "../../shared/ipc/automation";
import type { NativeAutomationService } from "../services/automation-service";

const idSchema = z.string().trim().min(1).max(256);
const pathSchema = z.string().trim().min(1).max(8_192);
const runtimeIdSchema = z.enum(["codex", "claude", "api", "hermes", "opencode", "openclaw"]);
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
  kind: z.enum(["contains", "exact_match", "json_valid", "llm_judge"]),
  prompt: z.string().max(500_000).optional(),
  runtimeId: idSchema.optional(),
  threshold: z.number().finite().min(0).max(1),
  enabled: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
const evaluationExperimentSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  datasetId: idSchema,
  agentId: idSchema,
  evaluatorIds: z.array(idSchema).max(500),
  repetitions: z.number().int().min(1).max(5),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
const evaluationRunListSchema = z.object({
  experimentId: idSchema.optional(),
  offset: z.number().int().nonnegative().max(1_000_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
const workflowIdSchema = z.object({ workflowId: idSchema });
const workflowRequestSchema = workflowIdSchema.passthrough();
const workflowReviewSchema = workflowIdSchema.extend({ expectedRevision: z.number().int().nonnegative() }).passthrough();
const workflowNodeSchema = workflowIdSchema.extend({ runId: idSchema, nodeId: idSchema }).passthrough();
const workflowStopSchema = workflowIdSchema.extend({ runId: idSchema }).passthrough();
const workflowReviseSchema = workflowNodeSchema.extend({
  definition: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(1).max(200_000),
  approvedBy: z.string().trim().min(1).max(200),
}).passthrough();
const workflowInterventionSchema = workflowNodeSchema.extend({
  action: z.enum(["continue", "skip", "escalate", "replan", "increase_review_strength", "approve_once", "reject"]),
  reason: z.string().max(200_000).optional(),
}).passthrough();
const workflowScriptInputSchema = workflowNodeSchema.extend({ values: z.record(z.string(), z.unknown()) }).passthrough();
const workflowDraftReplySchema = workflowIdSchema.extend({ reply: z.string().trim().min(1).max(200_000) }).passthrough();
const mcpInstallSchema = z.object({
  agentId: idSchema,
  catalogId: idSchema,
  allowedPath: pathSchema.optional(),
  token: z.string().max(20_000).optional(),
});
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
  enabled: z.boolean(),
  tools: z.array(mcpToolSchema).max(5_000),
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
  readLocalFile?: (filePath: string, allowedRoots: string[]) => Promise<LocalFilePreview>;
  revealPath?: (filePath: string) => Promise<string>;
}

export function registerAutomationIpc({
  ipc,
  service,
  send,
  pickDirectory,
  readLocalFile,
  revealPath,
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
    service.runtime.saveModelChannels(z.array(channelSchema).max(500).parse(value) as AgentChannel[]));
  ready(AUTOMATION_CHANNELS.runtimeSaveAgents, (value: unknown) =>
    service.runtime.updateConfiguredAgents(z.array(agentSchema).max(500).parse(value) as ConfiguredAgent[]));
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
  ready(AUTOMATION_CHANNELS.mcpSetupStatus, () => service.mcp.setupStatus());
  ready(AUTOMATION_CHANNELS.mcpInstalledList, () => service.mcp.listInstalled());
  ready(AUTOMATION_CHANNELS.mcpAgentList, (value: unknown) => service.mcp.listForAgent(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.mcpAgentInstall, (value: unknown) => service.mcp.install(mcpInstallSchema.parse(value) as McpInstallRequest));
  ready(AUTOMATION_CHANNELS.mcpAgentUninstall, (value: unknown) => service.mcp.uninstall(mcpInstallSchema.parse(value) as McpInstallRequest));

  ready(AUTOMATION_CHANNELS.evaluationDatasetList, () => service.evaluations.listDatasets());
  ready(AUTOMATION_CHANNELS.evaluationDatasetSave, (value: unknown) =>
    service.evaluations.saveDataset(evaluationDatasetSchema.parse(value) as EvaluationDataset));
  ready(AUTOMATION_CHANNELS.evaluationDatasetDelete, (value: unknown) =>
    service.evaluations.deleteDataset(idSchema.parse(value)));
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

  ready(AUTOMATION_CHANNELS.workflowDraftCreate, (value: unknown) =>
    service.workflows.createWorkflowDraft((value === undefined ? {} : z.object({
      title: z.string().trim().min(1).max(200).optional(),
      configuredAgentId: idSchema.optional(),
      modelId: idSchema.optional(),
      reviewerConfiguredAgentId: idSchema.optional(),
      reviewerModelId: idSchema.optional(),
    }).passthrough().parse(value)) as CreateWorkflowDraftRequest));
  ready(AUTOMATION_CHANNELS.workflowDraftPatch, (value: unknown) => service.workflows.patchWorkflowDraft(workflowRequestSchema.parse(value) as PatchWorkflowDraftRequest));
  ready(AUTOMATION_CHANNELS.workflowUpdate, (value: unknown) => service.workflows.updateWorkflow(workflowRequestSchema.parse(value) as UpdateWorkflowRequest));
  ready(AUTOMATION_CHANNELS.workflowDraftReset, (value: unknown) => service.workflows.resetWorkflowDraftSession(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.workflowDraftSend, (value: unknown) => service.workflows.sendWorkflowDraftReply(workflowDraftReplySchema.parse(value) as SendWorkflowDraftReplyRequest));
  ready(AUTOMATION_CHANNELS.workflowDraftAbandon, (value: unknown) => service.workflows.abandonWorkflowDraftReply(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.workflowSelect, (value: unknown) => service.workflows.selectWorkflow(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.workflowRename, (value: unknown) => {
    const request = z.object({ workflowId: idSchema, title: z.string().trim().min(1).max(200) }).parse(value);
    return service.workflows.renameWorkflow(request.workflowId, request.title);
  });
  ready(AUTOMATION_CHANNELS.workflowDelete, (value: unknown) => service.workflows.deleteWorkflow(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.workflowConfirm, (value: unknown) => service.workflows.confirmWorkflow(workflowRequestSchema.parse(value) as ConfirmWorkflowRequest));
  ready(AUTOMATION_CHANNELS.workflowReview, (value: unknown) => service.workflows.reviewWorkflow(workflowReviewSchema.parse(value) as ReviewWorkflowRequest));
  ready(AUTOMATION_CHANNELS.workflowReviewInterrupt, (value: unknown) => service.workflows.interruptWorkflowReview(workflowRequestSchema.parse(value) as InterruptWorkflowReviewRequest));
  ready(AUTOMATION_CHANNELS.workflowRun, (value: unknown) => service.workflows.runWorkflow(workflowRequestSchema.parse(value) as RunWorkflowRequest));
  ready(AUTOMATION_CHANNELS.workflowPauseNode, (value: unknown) => service.workflows.pauseWorkflowNode(workflowNodeSchema.parse(value) as PauseWorkflowNodeRequest));
  ready(AUTOMATION_CHANNELS.workflowReviseRun, (value: unknown) => service.workflows.reviseWorkflowV2Run(workflowReviseSchema.parse(value) as unknown as ReviseWorkflowV2RunRequest));
  ready(AUTOMATION_CHANNELS.workflowStopRun, (value: unknown) => service.workflows.stopWorkflowRun(workflowStopSchema.parse(value) as StopWorkflowRunRequest));
  ready(AUTOMATION_CHANNELS.workflowResolveIntervention, (value: unknown) => service.workflows.resolveWorkflowV2Intervention(workflowInterventionSchema.parse(value) as ResolveWorkflowV2InterventionRequest));
  ready(AUTOMATION_CHANNELS.workflowSendNodeMessage, (value: unknown) => {
    const request = z.object({ conversationId: idSchema, message: z.string().trim().min(1).max(200_000) }).parse(value);
    return service.workflows.sendWorkflowNodeMessage(request as SendWorkflowNodeMessageRequest);
  });
  ready(AUTOMATION_CHANNELS.workflowCompleteNodeConversation, (value: unknown) => service.workflows.completeWorkflowNodeConversation(z.object({ conversationId: idSchema }).parse(value)));
  ready(AUTOMATION_CHANNELS.workflowRejectNodeCompletion, (value: unknown) => {
    const request = z.object({ conversationId: idSchema, instruction: z.string().trim().min(1).max(200_000) }).parse(value);
    return service.workflows.rejectWorkflowNodeCompletion(request as RejectWorkflowNodeCompletionRequest);
  });
  ready(AUTOMATION_CHANNELS.workflowInterruptNodeConversation, (value: unknown) => service.workflows.interruptWorkflowNodeConversation(z.object({ conversationId: idSchema }).parse(value) as InterruptWorkflowNodeConversationRequest));
  ready(AUTOMATION_CHANNELS.workflowStartNode, (value: unknown) => service.workflows.startWorkflowNode(workflowNodeSchema.parse(value) as StartWorkflowNodeRequest));
  ready(AUTOMATION_CHANNELS.workflowSubmitScriptInput, (value: unknown) => service.workflows.submitWorkflowScriptInput(workflowScriptInputSchema.parse(value) as SubmitWorkflowScriptInputRequest));
  ready(AUTOMATION_CHANNELS.workflowOutputsList, (value: unknown) => service.workflows.listWorkflowOutputs(workflowStopSchema.parse(value) as ListWorkflowOutputsRequest));
  ready(AUTOMATION_CHANNELS.workflowOutputRead, async (value: unknown) => {
    if (!readLocalFile) throw new Error("Workflow output preview is unavailable.");
    return readLocalFile(pathSchema.parse(value), service.workflows.allowedFileRoots());
  });
  ready(AUTOMATION_CHANNELS.workflowOutputReveal, async (value: unknown) => {
    if (!revealPath) throw new Error("Workflow output reveal is unavailable.");
    return revealPath(pathSchema.parse(value));
  });
  ready(AUTOMATION_CHANNELS.approvalResolve, (value: unknown) => {
    const request = z.object({
      ownerId: idSchema,
      requestId: idSchema,
      decision: z.enum(["approved", "rejected"]),
    }).parse(value) as ResolveRuntimeApprovalRequest;
    return service.resolveRuntimeApproval(request);
  });

  return service.subscribe((snapshot) => send(AUTOMATION_CHANNELS.snapshotChanged, snapshot));
}
