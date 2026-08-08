import type { ApprovalDecision, TaskRun, WorkflowRunProgressItem } from "../../../../shared/types";
import type { WorkflowV2Node } from "../../../../shared/workflow-v2/definition";
import type { WorkflowNodeConversation } from "../../../../shared/workflow-v2/conversation";
import { WorkflowNodeAgentWindow, type WorkflowNodeAgentSession } from "./WorkflowNodeAgentWindow";
import { WorkflowNodeDrawer } from "./WorkflowNodeDrawer";
import { WorkflowScriptNodePanel } from "./WorkflowScriptNodePanel";

export function WorkflowNodeSurface(props: {
  node: WorkflowV2Node;
  progress?: WorkflowRunProgressItem;
  conversation?: WorkflowNodeConversation;
  task?: TaskRun;
  reviewTask?: TaskRun;
  reviewEnabled?: boolean;
  sessions?: WorkflowNodeAgentSession[];
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
  onClose: () => void;
  onSubmitScriptInput?: (values: Record<string, unknown>) => void | Promise<void>;
  onResolveScriptApproval?: (action: "approve_once" | "reject") => void | Promise<void>;
  onSend?: (message: string) => void | Promise<void>;
  onConfirm?: () => void | Promise<void>;
  onReject?: (instruction: string) => void | Promise<void>;
  onInterrupt?: () => void | Promise<void>;
  onResolveRuntimeApproval?: (ownerId: string, requestId: string, decision: ApprovalDecision) => void | Promise<void>;
  editable?: boolean;
  onUpdateNode?: (update: Partial<WorkflowV2Node>) => void | Promise<void>;
  agentLabel?: string;
  modelLabel?: string;
}) {
  if (props.node.execModel === "script") return <WorkflowScriptNodePanel node={props.node} {...(props.progress ? { progress: props.progress } : {})} {...(props.onSubmitScriptInput ? { onSubmitInput: props.onSubmitScriptInput } : {})} {...(props.onResolveScriptApproval ? { onResolveApproval: props.onResolveScriptApproval } : {})} {...(props.editable !== undefined ? { editable: props.editable } : {})} {...(props.onUpdateNode ? { onUpdateNode: props.onUpdateNode } : {})} onClose={props.onClose} />;

  // When there is no runtime activity, show the definition drawer instead of
  // the full-screen conversation overlay.
  const hasRuntime = Boolean(props.conversation || props.task);
  if (!hasRuntime) {
    return <WorkflowNodeDrawer node={props.node} editable={props.editable} onClose={props.onClose} agentLabel={props.agentLabel} modelLabel={props.modelLabel} />;
  }

  const inputPrompt = props.progress?.inputRequest?.kind === "agent_message" ? props.progress.inputRequest.prompt : undefined;
  return <WorkflowNodeAgentWindow nodeTitle={props.node.title} prompt={props.node.prompt} {...(inputPrompt ? { inputPrompt } : {})} {...(props.progress ? { progress: props.progress } : {})} {...(props.conversation ? { conversation: props.conversation } : {})} {...(props.task ? { task: props.task } : {})} {...(props.reviewTask ? { reviewTask: props.reviewTask } : {})} {...(props.reviewEnabled !== undefined ? { reviewEnabled: props.reviewEnabled } : {})} {...(props.sessions ? { sessions: props.sessions } : {})} {...(props.selectedNodeId ? { selectedNodeId: props.selectedNodeId } : {})} {...(props.onSelectNode ? { onSelectNode: props.onSelectNode } : {})} onClose={props.onClose} {...(props.onSend ? { onSend: props.onSend } : {})} {...(props.onConfirm ? { onConfirm: props.onConfirm } : {})} {...(props.onReject ? { onReject: props.onReject } : {})} {...(props.onInterrupt ? { onInterrupt: props.onInterrupt } : {})} {...(props.onResolveRuntimeApproval ? { onResolveRuntimeApproval: props.onResolveRuntimeApproval } : {})} {...(props.editable !== undefined ? { editable: props.editable } : {})} {...(props.onUpdateNode ? { onSavePrompt: (prompt: string) => props.onUpdateNode?.({ prompt }) } : {})} />;
}
