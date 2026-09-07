import { useEffect, useRef, useState, type ReactElement } from "react";
import { Bot, ChevronDown, GitBranch, Send, Square, Wand2, X } from "lucide-react";
import type { WorkflowDefinition, WorkflowPlanningState, WorkflowProposal } from "../../../../automation/engine/shared/workflow/model";
import { agentRecallAutomationService } from "../../../../automation/engine/renderer/src/app/services/agent-recall-service";
import { Markdown } from "../../markdown";
import { localize, type LanguageMode } from "../../language";

export function WorkflowPlanningPanel({ definition, agents, language, reply, onReplyChange: setReply, disabled, onBusyChange, onPlanning, onApply, onClose }: {
  definition: WorkflowDefinition;
  agents: Array<{ id: string; name: string }>;
  language: LanguageMode;
  reply: string;
  onReplyChange: (reply: string) => void;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onPlanning: (planning: WorkflowPlanningState) => Promise<void>;
  onApply: (proposal: WorkflowProposal) => void;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string): string => localize(language, en, zh);
  const [agentId, setAgentId] = useState(definition.planning?.agentId ?? agents[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingSave, setPendingSave] = useState<WorkflowPlanningState>();
  const active = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const transcript = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onPlanning });
  callbacks.current = { onPlanning };
  const api = agentRecallAutomationService();
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) {
        // Window destruction is also handled by main; this covers panel unmount.
        void api.cancelWorkflowPlanning(active.current).catch((cause: unknown) => {
          console.error("Unable to cancel Workflow planning on unmount:", cause);
        });
        active.current = undefined;
      }
    };
  }, [api]);
  useEffect(() => {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [definition.planning?.messages.length, busy]);

  const send = async (intent: "interview" | "generate"): Promise<void> => {
    if (active.current || busy || disabled || pendingSave) return;
    const message = reply.trim() || (intent === "generate" ? l("Generate the Workflow from our agreed decisions.", "请根据已经确认的需求生成 Workflow。") : "");
    if (!message || !agentId) return;
    const requestId = `workflow_plan_${crypto.randomUUID()}`;
    active.current = requestId;
    setBusy(true); setError(undefined);
    try {
      const planning = await api.replyWorkflowPlanning({ requestId, definition, agentId, message, intent });
      if (!mounted.current || active.current !== requestId) return;
      setPendingSave(planning);
      await callbacks.current.onPlanning(planning);
      if (mounted.current) setPendingSave(undefined);
      if (mounted.current && active.current === requestId) setReply("");
    } catch (cause) {
      if (mounted.current && active.current === requestId) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (active.current === requestId) {
        active.current = undefined;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const cancel = async (): Promise<void> => {
    const requestId = active.current;
    if (!requestId) return;
    try {
      await api.cancelWorkflowPlanning(requestId);
      // Keep the turn busy until its executor has settled; no orphaned retry.
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const retrySave = async (): Promise<void> => {
    if (!pendingSave || busy || disabled) return;
    setBusy(true); setError(undefined);
    try {
      await callbacks.current.onPlanning(pendingSave);
      if (mounted.current) { setPendingSave(undefined); setReply(""); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const proposal = definition.planning?.proposal;
  return <section className="workflow-core-planning" aria-label={l("Plan Workflow", "询问规划")}>
    <header><strong><Wand2 size={14} />{l("Plan Workflow", "询问规划")}</strong><button type="button" className="icon-btn" aria-label={l("Close planning", "收起规划")} onClick={onClose}><X size={14} /></button></header>
    <label className="workflow-core-field workflow-core-planning-agent"><span>{l("Planning Agent", "规划 Agent")}</span><select aria-label={l("Planning Agent", "规划 Agent")} value={agentId} disabled={busy} onChange={(event) => setAgentId(event.currentTarget.value)}><option value="" disabled>{l("Select an Agent", "选择 Agent")}</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
    <div className="workflow-core-planning-messages" ref={transcript} aria-live="polite" aria-busy={busy}>
      <p className="workflow-core-planning-intro">{definition.planning?.messages.length ? l("Clarify requirements, then apply the proposal to the canvas.", "澄清需求后，将方案应用到画布。") : l("What would you like to automate? Describe the goal; we will clarify the details one at a time.", "想让这个流程完成什么？描述目标，我们逐步确认细节。")}</p>
      {definition.planning?.messages.map((message, index) => <article key={index} className={`is-${message.role}`}><strong>{message.role === "user" ? l("You", "你") : <><Bot size={12} /> Agent</>}</strong><Markdown text={message.content} language={language} /></article>)}
      {busy ? <p role="status">{l("Planning…", "正在规划…")}</p> : null}
    {proposal ? <div className="workflow-core-planning-proposal"><div className="workflow-core-planning-proposal-label"><GitBranch size={12} /><span>{l("Ready for review", "方案待确认")}</span></div><details><summary><strong>{proposal.name}</strong><span>{proposal.nodes.length} {l("nodes", "个节点")}</span><ChevronDown size={13} /></summary><p>{proposal.description}</p><ol>{proposal.nodes.map((node) => <li key={node.id}><span>{node.title}</span><small>{node.kind}</small></li>)}</ol></details><button type="button" className="send-btn compact" disabled={busy || disabled} onClick={() => onApply(proposal)}>{l("Apply to canvas", "应用到画布")}</button><small>{l("Review the proposal before replacing the current nodes. You can then edit them manually.", "确认后替换当前节点，仍可手动调整。")}</small></div> : null}
    </div>
    {error ? <p className="workflow-core-error" role="alert">{error}</p> : null}
    {pendingSave && !busy ? <button type="button" className="control-btn compact" disabled={disabled} onClick={() => void retrySave()}>{l("Retry saving this response", "重试保存本次回复")}</button> : null}
    {agents.length === 0 ? <p role="alert">{l("Create an Agent in Agents before planning.", "请先到 Agents 中配置一个 Agent，再开始规划。")}</p> : null}
    <form className="workflow-core-planning-composer" onSubmit={(event) => { event.preventDefault(); void send("interview"); }}>
      <textarea aria-label={l("Goal or answer", "目标或回答")} placeholder={l("Describe the task or answer the question…", "描述任务，或回答 Agent 的问题…")} value={reply} disabled={busy} maxLength={50_000} onChange={(event) => setReply(event.currentTarget.value)} />
      <div>{busy ? <button type="button" className="control-btn compact" disabled={Boolean(pendingSave)} onClick={() => void cancel()}><Square size={12} />{pendingSave ? l("Saving…", "保存中…") : l("Stop", "停止")}</button> : <><button type="submit" className="send-btn compact" disabled={disabled || Boolean(pendingSave) || !reply.trim() || !agents.some((agent) => agent.id === agentId)}><Send size={12} />{l("Send", "发送")}</button><button type="button" className="control-btn compact" disabled={disabled || Boolean(pendingSave) || !agents.some((agent) => agent.id === agentId) || (!reply.trim() && !definition.planning?.messages.length)} onClick={() => void send("generate")}><Wand2 size={12} />{l("Generate Workflow", "生成 Workflow")}</button></>}</div>
    </form>
  </section>;
}
