import { useEffect, useMemo, useState } from "react";
import { CircleStop, Pencil, Save, Send, X } from "lucide-react";
import type { ApprovalDecision, TaskRun } from "../../../../shared/types";
import type { WorkflowNodeConversation } from "../../../../shared/workflow-v2/conversation";
import { WorkflowMessageContent } from "./WorkflowMessageContent";
import { useWorkflowNodeInputController } from "./workflow-node-input-controller";
import { ChatEventMessage } from "../chat/chat-event-display";

export interface WorkflowNodeAgentSession { nodeId: string; nodeTitle: string; conversation?: WorkflowNodeConversation; task?: TaskRun; }

function sessionStatus(session: WorkflowNodeAgentSession): { label: string; attention: boolean; group: number } {
  const status = session.conversation?.status ?? session.task?.status;
  if (status === "waiting_for_user") return { label: "Waiting for input", attention: true, group: 0 };
  if (status === "completion_proposed") return { label: "Confirm completion", attention: true, group: 0 };
  if (status === "starting" || status === "active" || status === "running" || status === "queued") return { label: "Running", attention: false, group: 1 };
  if (status === "failed") return { label: "Failed", attention: false, group: 2 };
  return { label: "Completed", attention: false, group: 2 };
}

export function WorkflowNodeAgentWindow(props: {
  conversation?: WorkflowNodeConversation; task?: TaskRun; sessions?: WorkflowNodeAgentSession[]; selectedNodeId?: string; nodeTitle: string; inputPrompt?: string;
  prompt?: string; editable?: boolean; onSavePrompt?: (prompt: string) => void | Promise<void>;
  onClose: () => void; onSelectNode?: (nodeId: string) => void; onSend?: (message: string) => void | Promise<void>;
  onConfirm?: () => void | Promise<void>; onReject?: (instruction: string) => void | Promise<void>; onInterrupt?: () => void | Promise<void>;
  onResolveRuntimeApproval?: (ownerId: string, requestId: string, decision: ApprovalDecision) => void | Promise<void>;
}) {
  const { conversation, task, sessions = [], selectedNodeId, nodeTitle } = props;
  const [rejecting, setRejecting] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(props.prompt ?? "");
  const [promptSaving, setPromptSaving] = useState(false);
  const draftKey = selectedNodeId ?? conversation?.nodeId ?? task?.id ?? "current";
  const acceptsInput = Boolean(conversation && conversation.status !== "closed" && conversation.status !== "failed" && (conversation.status !== "completion_proposed" || rejecting));
  const canInterrupt = Boolean(conversation && conversation.status !== "closed" && conversation.status !== "failed");
  const inputAdapter = useMemo(() => ({
    prepare: (values: Record<string, string>) => {
      const content = values.message?.trim() ?? "";
      if (!content) throw new Error("A node message is required.");
      return content;
    },
    submit: async (content: string) => {
      if (rejecting) {
        if (!props.onReject) throw new Error("This node cannot reject completion.");
        await props.onReject(content);
        return;
      }
      if (!props.onSend) throw new Error("This node cannot accept messages.");
      await props.onSend(content);
    },
  }), [props.onReject, props.onSend, rejecting]);
  const input = useWorkflowNodeInputController({ scope: `agent:${draftKey}`, adapter: inputAdapter });
  const message = input.values.message ?? "";
  const orderedSessions = useMemo(() => [...sessions].sort((a, b) => sessionStatus(a).group - sessionStatus(b).group || a.nodeTitle.localeCompare(b.nodeTitle)), [sessions]);
  const attentionCount = sessions.filter((session) => sessionStatus(session).attention).length;
  const identity = conversation ? `${conversation.status} ? ${conversation.modelId} ? ${conversation.conversationId}` : task ? `${task.status} ? ${task.modelId} ? ${task.runtimeConversation?.runtimeId ?? "one-shot"}` : "Node has not started yet.";

  const submitMessage = async () => {
    if (await input.submit()) setRejecting(false);
  };

  const conversationMessages = conversation?.messages ?? [];
  const timelineMessages = conversationMessages.filter((item) => item.role !== "system");
  const runtimeMessages = conversationMessages.filter((item) => item.role === "system");
  const conversationApprovalOwnerId = conversation ? `workflow-node:${conversation.workflowId}:${conversation.runId}:${conversation.nodeId}` : undefined;

  useEffect(() => {
    setPromptDraft(props.prompt ?? "");
    setEditingPrompt(false);
    setActionError(undefined);
  }, [props.nodeTitle, props.prompt]);

  const savePrompt = async () => {
    const prompt = promptDraft.trim();
    if (!prompt) {
      setActionError("Agent prompt cannot be empty.");
      return;
    }
    if (!props.onSavePrompt) return;
    setPromptSaving(true);
    setActionError(undefined);
    try {
      await props.onSavePrompt(prompt);
      setPromptDraft(prompt);
      setEditingPrompt(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPromptSaving(false);
    }
  };

  return <section className="workflow-node-agent-overlay" role="dialog" aria-modal="true" aria-label={`${nodeTitle} agent conversation`}>
    <article className="workflow-node-agent-window">
      {orderedSessions.length ? <aside className="workflow-node-agent-sidebar"><div className="workflow-node-agent-queue-summary"><strong>Node conversations</strong><span>{attentionCount} {attentionCount === 1 ? "node needs" : "nodes need"} attention</span></div><div className="workflow-node-agent-session-list">{orderedSessions.map((session) => { const state = sessionStatus(session); return <button key={session.nodeId} className={`workflow-node-agent-session${session.nodeId === selectedNodeId ? " is-selected" : ""}${state.attention ? " needs-attention" : ""}`} onClick={() => props.onSelectNode?.(session.nodeId)}><strong>{session.nodeTitle}</strong><span>{state.label}</span></button>; })}</div></aside> : null}
      <div className="workflow-node-agent-main">
        <header><div><strong>{nodeTitle}</strong><span>{identity}</span></div><button className="icon-btn" onClick={props.onClose} aria-label="Close node conversation"><X size={16} /></button></header>
        {props.editable && props.onSavePrompt ? <section className="workflow-node-prompt-editor" aria-label="Agent node prompt editor">
          <div><strong>Agent prompt</strong><span>This instruction is used the next time this workflow revision runs.</span></div>
          {editingPrompt ? <>
            <textarea aria-label={`Prompt for ${nodeTitle}`} value={promptDraft} onChange={(event) => setPromptDraft(event.currentTarget.value)} rows={8} spellCheck={false} />
            <div className="workflow-node-editor-actions"><button className="control-btn compact" disabled={promptSaving} onClick={() => { setPromptDraft(props.prompt ?? ""); setEditingPrompt(false); }}>Cancel</button><button className="send-btn" disabled={promptSaving || !promptDraft.trim()} onClick={() => void savePrompt()}><Save size={14} /><span>{promptSaving ? "Saving..." : "Save prompt"}</span></button></div>
          </> : <><pre><code>{props.prompt}</code></pre><button className="control-btn compact" onClick={() => setEditingPrompt(true)}><Pencil size={14} /><span>Edit prompt</span></button></>}
        </section> : null}
        <div className="workflow-node-agent-messages">
          {conversation ? timelineMessages.map((item) => { const kind = item.eventType === "tool_call" ? "tool-call" : item.eventType === "tool_result" ? "tool-result" : item.role; const structuredCompletion = item.eventType === "tool_call" && item.name?.toLowerCase().includes("workflow_node_complete"); const label = structuredCompletion ? "Structured result submitted" : item.eventType === "tool_call" ? `Tool call${item.name ? ` · ${item.name}` : ""}` : item.eventType === "tool_result" ? `Tool result${item.name ? ` · ${item.name}` : ""}` : item.role === "assistant" ? "Agent" : "You"; const content = item.event && conversationApprovalOwnerId ? <ChatEventMessage event={item.event} ownerId={conversationApprovalOwnerId} onResolveApproval={props.onResolveRuntimeApproval} /> : <WorkflowMessageContent content={item.content} />; return <div key={item.id} className={`workflow-node-agent-message is-${kind}`}><span>{label} · {new Date(item.at).toLocaleTimeString()}</span>{item.role === "tool" ? <details className="workflow-node-agent-tool-payload"><summary>{item.eventType === "tool_result" ? "View result" : "View input"}</summary>{content}</details> : content}</div>; })
          : task ? task.messages.map((item) => <div key={item.id} className={`workflow-node-agent-message is-${item.role}`}><span>{item.role} ? {new Date(item.timestamp).toLocaleTimeString()}</span>{item.content ? <WorkflowMessageContent content={item.content} /> : null}{item.events?.map((event) => <ChatEventMessage key={event.id} event={event} ownerId={task.id} onResolveApproval={props.onResolveRuntimeApproval} />)}</div>)
          : <div className="workflow-node-agent-message is-system"><span>Node status</span><p>This agent node has not produced runtime activity yet. Its full conversation will appear here after execution starts.</p></div>}
          {conversation && runtimeMessages.length ? <details className="workflow-node-agent-runtime-details"><summary>Runtime details <span>{runtimeMessages.length} events</span></summary><div>{runtimeMessages.map((item) => <div key={item.id} className="workflow-node-agent-message is-system"><span>System instruction · {new Date(item.at).toLocaleTimeString()}</span><WorkflowMessageContent content={item.content} /></div>)}</div></details> : null}
        </div>
        {conversation?.status === "completion_proposed" && conversation.completionProposal ? <div className="workflow-node-completion-proposal"><strong>Completion proposal</strong><p>{conversation.completionProposal.output.summary}</p>{conversation.completionProposal.unresolvedRisks.length ? <ul>{conversation.completionProposal.unresolvedRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : null}<div className="workflow-node-agent-actions"><button className="control-btn compact" onClick={() => void Promise.resolve(props.onConfirm?.()).catch((error) => setActionError(error instanceof Error ? error.message : String(error)))}>Confirm and continue</button><button className="control-btn compact secondary" onClick={() => setRejecting(true)}>Reject / request changes</button></div></div> : null}
        {input.error || actionError ? <div className="workflow-node-agent-error" role="alert">{input.error ?? actionError}</div> : null}
        <footer><textarea value={message} disabled={!acceptsInput} onChange={(event) => input.setValue("message", event.currentTarget.value)} placeholder={conversation ? rejecting ? "Describe required changes..." : props.inputPrompt ?? "Send information to this node agent..." : task ? "This one-shot node is read-only." : "This node has not started; there is no active conversation yet."} rows={3} /><div><button className="icon-btn" disabled={!canInterrupt} onClick={() => void props.onInterrupt?.()} title="Interrupt agent"><CircleStop size={16} /></button><button className="send-btn" disabled={!acceptsInput || !message.trim()} onClick={() => void submitMessage()}><Send size={14} /><span>Send</span></button></div></footer>
      </div>
    </article>
  </section>;
}
