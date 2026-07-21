import type { IpcMain } from "electron";
import { z } from "zod";
import type {
  AgentChannel,
  ConfiguredAgent,
  ConfirmWorkflowRequest,
  CreateWorkflowDraftRequest,
  InterruptWorkflowNodeConversationRequest,
  InterruptWorkflowReviewRequest,
  ListWorkflowOutputsRequest,
  LocalFilePreview,
  PatchWorkflowDraftRequest,
  PauseWorkflowNodeRequest,
  RejectWorkflowNodeCompletionRequest,
  ResolveWorkflowV2InterventionRequest,
  ReviewWorkflowRequest,
  ReviseWorkflowV2RunRequest,
  RunWorkflowRequest,
  SendWorkflowDraftReplyRequest,
  SendWorkflowNodeMessageRequest,
  StartWorkflowNodeRequest,
  StopWorkflowRunRequest,
  SubmitWorkflowScriptInputRequest,
  UpdateWorkflowRequest,
} from "../../automation/engine/shared/types";
import type { ResolveRuntimeApprovalRequest } from "../../automation/engine/shared/runtime-approval";
import type { McpServerDefinition } from "../../automation/engine/shared/mcp/types";
import type { McpInstallRequest } from "../../automation/engine/shared/mcp-config";
import { loadClaudeDefaultConfig, loadCodexDefaultConfig } from "../../automation/engine/main/channels/model-config";
import { discoverMcpTools } from "../../automation/engine/main/mcp-client";
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
  name: z.string().trim().min(1).max(200),
  runtimeAgentId: runtimeIdSchema,
  channelId: idSchema,
  modelId: idSchema,
  description: z.string().max(20_000),
  tags: z.array(z.string().max(200)).max(200),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).passthrough();
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

  ipc.handle(AUTOMATION_CHANNELS.health, () => service.health());
  ready(AUTOMATION_CHANNELS.snapshot, () => service.snapshot());
  ready(AUTOMATION_CHANNELS.runtimeSaveChannels, (value: unknown) =>
    service.hub().saveModelChannels(z.array(channelSchema).max(500).parse(value) as AgentChannel[]));
  ready(AUTOMATION_CHANNELS.runtimeSaveAgents, (value: unknown) =>
    service.hub().updateConfiguredAgents(z.array(agentSchema).max(500).parse(value) as ConfiguredAgent[]));
  ready(AUTOMATION_CHANNELS.runtimeTestChannel, (value: unknown) =>
    service.hub().testRuntimeChannel(idSchema.parse(value), (event) => send(AUTOMATION_CHANNELS.runtimeTestEvent, event)));
  ready(AUTOMATION_CHANNELS.runtimeTestAgent, (value: unknown) =>
    service.hub().testConfiguredAgent(idSchema.parse(value), (event) => send(AUTOMATION_CHANNELS.runtimeTestEvent, event)));
  ready(AUTOMATION_CHANNELS.runtimeBalance, (value: unknown) => service.hub().queryRuntimeChannelBalance(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.runtimeLoadCodexDefault, () => loadCodexDefaultConfig());
  ready(AUTOMATION_CHANNELS.runtimeLoadClaudeDefault, () => loadClaudeDefaultConfig());
  ready(AUTOMATION_CHANNELS.runtimeImportLocal, (value: unknown) => {
    const request = z.object({ runtimeId: runtimeIdSchema, channelId: idSchema.optional() }).parse(value);
    return service.hub().importRuntimeLocalConfig(request.runtimeId, request.channelId);
  });
  ready(AUTOMATION_CHANNELS.runtimeRefreshModels, (value: unknown) => service.hub().refreshModelCatalog(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.runtimeListCodexPlugins, () => service.hub().listCodexPluginCatalog());
  ready(AUTOMATION_CHANNELS.workDirSet, (value: unknown) => {
    service.hub().setWorkDir(pathSchema.parse(value));
    return service.hub().snapshot();
  });
  ready(AUTOMATION_CHANNELS.workDirChoose, async () => {
    if (!pickDirectory) throw new Error("Directory picker is unavailable.");
    const selected = await pickDirectory(service.hub().getWorkDir());
    if (selected) service.hub().setWorkDir(pathSchema.parse(selected));
    return service.hub().snapshot();
  });
  ready(AUTOMATION_CHANNELS.directoryPick, async (value: unknown) => {
    if (!pickDirectory) throw new Error("Directory picker is unavailable.");
    const defaultPath = value === undefined ? undefined : pathSchema.parse(value);
    return pickDirectory(defaultPath);
  });

  ready(AUTOMATION_CHANNELS.mcpList, () => service.mcpRegistry().list());
  ready(AUTOMATION_CHANNELS.mcpSave, (value: unknown) => service.mcpRegistry().upsert(mcpServerSchema.parse(value) as McpServerDefinition));
  ready(AUTOMATION_CHANNELS.mcpTest, async (value: unknown) => {
    const server = mcpServerSchema.parse(value) as McpServerDefinition;
    try {
      return await service.mcpRegistry().recordTest(server, await discoverMcpTools(server));
    } catch (error) {
      return service.mcpRegistry().recordTest(server, [], error instanceof Error ? error.message : String(error));
    }
  });
  ready(AUTOMATION_CHANNELS.mcpDelete, (value: unknown) => service.mcpRegistry().delete(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.mcpSetupStatus, () => service.mcpAgents().status());
  ready(AUTOMATION_CHANNELS.mcpInstalledList, () => service.mcpAgents().listInstalled());
  ready(AUTOMATION_CHANNELS.mcpAgentList, (value: unknown) => service.mcpAgents().listForAgent(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.mcpAgentInstall, (value: unknown) => service.mcpAgents().install(mcpInstallSchema.parse(value) as McpInstallRequest));
  ready(AUTOMATION_CHANNELS.mcpAgentUninstall, (value: unknown) => service.mcpAgents().uninstall(mcpInstallSchema.parse(value) as McpInstallRequest));

  ready(AUTOMATION_CHANNELS.workflowDraftCreate, (value: unknown) =>
    service.hub().createWorkflowDraft((value === undefined ? {} : z.object({
      title: z.string().trim().min(1).max(200).optional(),
      configuredAgentId: idSchema.optional(),
      modelId: idSchema.optional(),
      reviewerConfiguredAgentId: idSchema.optional(),
      reviewerModelId: idSchema.optional(),
    }).passthrough().parse(value)) as CreateWorkflowDraftRequest));
  ready(AUTOMATION_CHANNELS.workflowDraftPatch, (value: unknown) => service.hub().patchWorkflowDraft(workflowRequestSchema.parse(value) as PatchWorkflowDraftRequest));
  ready(AUTOMATION_CHANNELS.workflowUpdate, (value: unknown) => service.hub().updateWorkflow(workflowRequestSchema.parse(value) as UpdateWorkflowRequest));
  ready(AUTOMATION_CHANNELS.workflowDraftReset, (value: unknown) => service.hub().resetWorkflowDraftSession(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.workflowDraftSend, (value: unknown) => service.hub().sendWorkflowDraftReply(workflowDraftReplySchema.parse(value) as SendWorkflowDraftReplyRequest));
  ready(AUTOMATION_CHANNELS.workflowDraftAbandon, (value: unknown) => service.hub().abandonWorkflowDraftReply(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.workflowSelect, (value: unknown) => service.hub().selectWorkflow(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.workflowRename, (value: unknown) => {
    const request = z.object({ workflowId: idSchema, title: z.string().trim().min(1).max(200) }).parse(value);
    return service.hub().renameWorkflow(request.workflowId, request.title);
  });
  ready(AUTOMATION_CHANNELS.workflowDelete, (value: unknown) => service.hub().deleteWorkflow(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.workflowConfirm, (value: unknown) => service.hub().confirmWorkflow(workflowRequestSchema.parse(value) as ConfirmWorkflowRequest));
  ready(AUTOMATION_CHANNELS.workflowReview, (value: unknown) => service.hub().reviewWorkflow(workflowReviewSchema.parse(value) as ReviewWorkflowRequest));
  ready(AUTOMATION_CHANNELS.workflowReviewInterrupt, (value: unknown) => service.hub().interruptWorkflowReview(workflowRequestSchema.parse(value) as InterruptWorkflowReviewRequest));
  ready(AUTOMATION_CHANNELS.workflowRun, (value: unknown) => service.hub().runWorkflow(workflowRequestSchema.parse(value) as RunWorkflowRequest));
  ready(AUTOMATION_CHANNELS.workflowPauseNode, (value: unknown) => service.hub().pauseWorkflowNode(workflowNodeSchema.parse(value) as PauseWorkflowNodeRequest));
  ready(AUTOMATION_CHANNELS.workflowReviseRun, (value: unknown) => service.hub().reviseWorkflowV2Run(workflowReviseSchema.parse(value) as unknown as ReviseWorkflowV2RunRequest));
  ready(AUTOMATION_CHANNELS.workflowStopRun, (value: unknown) => service.hub().stopWorkflowRun(workflowStopSchema.parse(value) as StopWorkflowRunRequest));
  ready(AUTOMATION_CHANNELS.workflowResolveIntervention, (value: unknown) => service.hub().resolveWorkflowV2Intervention(workflowInterventionSchema.parse(value) as ResolveWorkflowV2InterventionRequest));
  ready(AUTOMATION_CHANNELS.workflowSendNodeMessage, (value: unknown) => {
    const request = z.object({ conversationId: idSchema, message: z.string().trim().min(1).max(200_000) }).parse(value);
    return service.hub().sendWorkflowNodeMessage(request as SendWorkflowNodeMessageRequest);
  });
  ready(AUTOMATION_CHANNELS.workflowCompleteNodeConversation, (value: unknown) => service.hub().completeWorkflowNodeConversation(z.object({ conversationId: idSchema }).parse(value)));
  ready(AUTOMATION_CHANNELS.workflowRejectNodeCompletion, (value: unknown) => {
    const request = z.object({ conversationId: idSchema, instruction: z.string().trim().min(1).max(200_000) }).parse(value);
    return service.hub().rejectWorkflowNodeCompletion(request as RejectWorkflowNodeCompletionRequest);
  });
  ready(AUTOMATION_CHANNELS.workflowInterruptNodeConversation, (value: unknown) => service.hub().interruptWorkflowNodeConversation(z.object({ conversationId: idSchema }).parse(value) as InterruptWorkflowNodeConversationRequest));
  ready(AUTOMATION_CHANNELS.workflowStartNode, (value: unknown) => service.hub().startWorkflowNode(workflowNodeSchema.parse(value) as StartWorkflowNodeRequest));
  ready(AUTOMATION_CHANNELS.workflowSubmitScriptInput, (value: unknown) => service.hub().submitWorkflowScriptInput(workflowScriptInputSchema.parse(value) as SubmitWorkflowScriptInputRequest));
  ready(AUTOMATION_CHANNELS.workflowOutputsList, (value: unknown) => service.hub().listWorkflowOutputs(workflowStopSchema.parse(value) as ListWorkflowOutputsRequest));
  ready(AUTOMATION_CHANNELS.workflowOutputRead, async (value: unknown) => {
    if (!readLocalFile) throw new Error("Workflow output preview is unavailable.");
    return readLocalFile(pathSchema.parse(value), service.hub().allowedFileRoots());
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
    service.hub().runtimeApprovals.resolveOrThrow(request);
    return service.hub().snapshot();
  });

  return service.subscribe((snapshot) => send(AUTOMATION_CHANNELS.snapshotChanged, snapshot));
}
