import type {
  AppSnapshot,
  CreateWorkflowDraftRequest,
  PatchWorkflowDraftRequest,
  UpdateWorkflowRequest,
  PauseWorkflowNodeRequest,
  ReviseWorkflowV2RunRequest,
  RunWorkflowRequest,
  ListWorkflowOutputsRequest,
  SendWorkflowDraftReplyRequest,
  StartWorkflowNodeRequest,
  StopWorkflowRunRequest,
  SubmitWorkflowScriptInputRequest,
  ResolveWorkflowV2InterventionRequest,
  WorkflowOperationResult,
  CompleteWorkflowNodeConversationRequest,
  ConfirmWorkflowRequest,
  ReviewWorkflowRequest,
  InterruptWorkflowNodeConversationRequest,
  InterruptWorkflowReviewRequest,
  RejectWorkflowNodeCompletionRequest,
  SendWorkflowNodeMessageRequest,
} from "../../../../shared/types";
import { agentRecallAutomationService } from "./agent-recall-service";

export interface WorkflowService {
  createDraft: (request?: CreateWorkflowDraftRequest) => Promise<AppSnapshot>;
  patchDraft: (request: PatchWorkflowDraftRequest) => Promise<AppSnapshot>;
  updateWorkflow: (request: UpdateWorkflowRequest) => Promise<WorkflowOperationResult>;
  resetDraftSession: (workflowId: string) => Promise<AppSnapshot>;
  sendDraftReply: (request: SendWorkflowDraftReplyRequest) => Promise<AppSnapshot>;
  abandonDraftReply: (workflowId: string) => Promise<AppSnapshot>;
  selectWorkflow: (workflowId: string) => Promise<AppSnapshot>;
  renameWorkflow: (workflowId: string, title: string) => Promise<AppSnapshot>;
  deleteWorkflow: (workflowId: string) => Promise<AppSnapshot>;
  confirmWorkflow: (request: ConfirmWorkflowRequest) => Promise<WorkflowOperationResult>;
  reviewWorkflow: (request: ReviewWorkflowRequest) => Promise<AppSnapshot>;
  interruptWorkflowReview: (request: InterruptWorkflowReviewRequest) => Promise<AppSnapshot>;
  runWorkflow: (request: RunWorkflowRequest) => Promise<WorkflowOperationResult>;
  pauseNode: (request: PauseWorkflowNodeRequest) => Promise<WorkflowOperationResult>;
  reviseRun: (request: ReviseWorkflowV2RunRequest) => Promise<WorkflowOperationResult>;
  stopRun: (request: StopWorkflowRunRequest) => Promise<WorkflowOperationResult>;
  startNode: (request: StartWorkflowNodeRequest) => Promise<WorkflowOperationResult>;
  submitScriptInput: (request: SubmitWorkflowScriptInputRequest) => Promise<WorkflowOperationResult>;
  resolveIntervention: (request: ResolveWorkflowV2InterventionRequest) => Promise<WorkflowOperationResult>;
  sendNodeMessage: (request: SendWorkflowNodeMessageRequest) => Promise<AppSnapshot>;
  completeNodeConversation: (request: CompleteWorkflowNodeConversationRequest) => Promise<WorkflowOperationResult>;
  rejectNodeCompletion: (request: RejectWorkflowNodeCompletionRequest) => Promise<AppSnapshot>;
  interruptNodeConversation: (request: InterruptWorkflowNodeConversationRequest) => Promise<AppSnapshot>;
  listOutputs: (request: ListWorkflowOutputsRequest) => Promise<Array<{ name: string; path: string }>>;
}

export function workflowService(): WorkflowService {
  const api = agentRecallAutomationService();
  return {
    createDraft: (request) => api.createWorkflowDraft(request),
    patchDraft: (request) => api.patchWorkflowDraft(request),
    updateWorkflow: (request) => api.updateWorkflow(request),
    resetDraftSession: (workflowId) => api.resetWorkflowDraftSession(workflowId),
    sendDraftReply: (request) => api.sendWorkflowDraftReply(request),
    abandonDraftReply: (workflowId) => api.abandonWorkflowDraftReply(workflowId),
    selectWorkflow: (workflowId) => api.selectWorkflow(workflowId),
    renameWorkflow: (workflowId, title) => api.renameWorkflow(workflowId, title),
    deleteWorkflow: (workflowId) => api.deleteWorkflow(workflowId),
    confirmWorkflow: (request) => api.confirmWorkflow(request),
    reviewWorkflow: (request) => api.reviewWorkflow(request),
    interruptWorkflowReview: (request) => api.interruptWorkflowReview(request),
    runWorkflow: (request) => api.runWorkflow(request),
    pauseNode: (request) => api.pauseWorkflowNode(request),
    reviseRun: (request) => api.reviseWorkflowV2Run(request),
    stopRun: (request) => api.stopWorkflowRun(request),
    startNode: (request) => api.startWorkflowNode(request),
    submitScriptInput: (request) => api.submitWorkflowScriptInput(request),
    resolveIntervention: (request) => api.resolveWorkflowV2Intervention(request),
    sendNodeMessage: (request) => api.sendWorkflowNodeMessage(request),
    completeNodeConversation: (request) => api.completeWorkflowNodeConversation(request),
    rejectNodeCompletion: (request) => api.rejectWorkflowNodeCompletion(request),
    interruptNodeConversation: (request) => api.interruptWorkflowNodeConversation(request),
    listOutputs: (request) => api.listWorkflowOutputs(request),
  };
}
