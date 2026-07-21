import type { MouseEvent } from "react";
import { GitBranch, LockKeyhole, Plus, SquarePen, Trash2, UserRound, X } from "lucide-react";
import type { WorkflowDraftState } from "../../../../shared/types";

type MaybePromise = void | Promise<void>;

interface WorkflowHistoryPanelProps {
  workflows: WorkflowDraftState[];
  activeWorkflowId?: string | undefined;
  running?: boolean;
  contextMenu?: { workflowId: string; x: number; y: number } | undefined;
  renameDraft?: { workflowId: string; title: string } | undefined;
  onNewWorkflow: () => MaybePromise;
  onSelectWorkflow: (workflowId: string) => MaybePromise;
  onOpenContextMenu?: (event: MouseEvent, workflowId: string) => void;
  onStartRename?: (workflowId: string) => MaybePromise;
  onRenameDraftChange?: (title: string) => void;
  onConfirmRename?: () => MaybePromise;
  onCancelRename?: () => void;
  onDeleteWorkflow?: (workflowId: string) => MaybePromise;
}

export function WorkflowHistoryPanel({
  workflows,
  activeWorkflowId,
  running = false,
  contextMenu,
  renameDraft,
  onNewWorkflow,
  onSelectWorkflow,
  onOpenContextMenu,
  onStartRename,
  onRenameDraftChange,
  onConfirmRename,
  onCancelRename,
  onDeleteWorkflow,
}: WorkflowHistoryPanelProps) {
  const officialWorkflows = workflows.filter((workflow) => workflow.sourceType === "official");
  const userWorkflows = workflows.filter((workflow) => workflow.sourceType === "user");
  const renderWorkflow = (workflow: WorkflowDraftState) => {
    const official = workflow.sourceType === "official";
    return (
    <button
      key={workflow.workflowId}
      className={`workflow-history-card ${official ? "is-official" : "is-personal"} ${workflow.workflowId === activeWorkflowId ? "is-active" : ""}`}
      onClick={() => void onSelectWorkflow(workflow.workflowId)}
      onContextMenu={official ? undefined : (event) => onOpenContextMenu?.(event, workflow.workflowId)}
    >
      <div className="workflow-history-card-title">
        <strong>{workflow.title}</strong>
        {official ? <span className="workflow-official-badge"><LockKeyhole size={10} />Official</span> : null}
      </div>
      <span>{`${workflow.status} · ${workflow.definition.nodes.length} nodes · rev ${workflow.revision}`}</span>
      <small>
        {workflow.objective ||
          (workflow.definition.nodes.length > 0 || workflow.runProgress.length > 0 || Boolean(workflow.contextDocument || workflow.runContextDocument || workflow.finalReport)
            ? "未保存目标"
            : "未开始")}
      </small>
    </button>
    );
  };
  return (
    <section className="resource-panel workflow-list-panel">
      <div className="panel-header">
        <span>Workflows</span>
        <GitBranch size={14} />
      </div>
      <div className="new-chat-menu-wrap">
        <button className="new-chat-compact-btn" onClick={() => void onNewWorkflow()}>
          <Plus size={13} />
          <span>New workflow</span>
        </button>
      </div>
      <div className="workflow-history-list" aria-label="Workflow history">
        {workflows.length === 0 ? <div className="workflow-empty-history">No workflows yet</div> : null}
        {officialWorkflows.length > 0 ? (
          <section className="workflow-history-group is-official" aria-label="Official workflows">
            <header className="workflow-history-group-header">
              <span><LockKeyhole size={12} />Official workflows</span>
              <small>{officialWorkflows.length}</small>
            </header>
            <p>Built-in, read-only workflow templates</p>
            <div className="workflow-history-group-cards">{officialWorkflows.map(renderWorkflow)}</div>
          </section>
        ) : null}
        <section className="workflow-history-group is-personal" aria-label="My workflows">
          <header className="workflow-history-group-header">
            <span><UserRound size={12} />My workflows</span>
            <small>{userWorkflows.length}</small>
          </header>
          <p>Workflows created and managed by you</p>
          {userWorkflows.length > 0
            ? <div className="workflow-history-group-cards">{userWorkflows.map(renderWorkflow)}</div>
            : <div className="workflow-history-group-empty">No personal workflows yet</div>}
        </section>
      </div>
      {contextMenu ? (
        <div
          className="agent-context-menu workflow-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" className="agent-context-menu-item" onClick={() => void onStartRename?.(contextMenu.workflowId)}>
            <SquarePen size={13} />
            <span>Rename workflow</span>
          </button>
          <button
            type="button"
            className="agent-context-menu-item danger"
            disabled={running}
            onClick={() => void onDeleteWorkflow?.(contextMenu.workflowId)}
          >
            <Trash2 size={13} />
            <span>Delete workflow</span>
          </button>
        </div>
      ) : null}
      {renameDraft ? (
        <section className="workflow-rename-overlay" role="dialog" aria-modal="true" aria-label="Rename workflow" onClick={onCancelRename}>
          <form
            className="workflow-rename-modal"
            onSubmit={(event) => {
              event.preventDefault();
              void onConfirmRename?.();
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <strong>Rename workflow</strong>
              <button type="button" className="icon-btn" onClick={onCancelRename} aria-label="Close rename workflow">
                <X size={14} />
              </button>
            </header>
            <input
              value={renameDraft.title}
              onChange={(event) => onRenameDraftChange?.(event.currentTarget.value)}
              aria-label="Workflow name"
              autoFocus
            />
            <footer>
              <button type="button" className="control-btn compact" onClick={onCancelRename}>
                <span>Cancel</span>
              </button>
              <button type="submit" className="send-btn compact" disabled={!renameDraft.title.trim()}>
                <span>Save</span>
              </button>
            </footer>
          </form>
        </section>
      ) : null}
    </section>
  );
}
