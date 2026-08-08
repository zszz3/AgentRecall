import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Bot, CheckCircle2, CircleStop, CircleX, RefreshCw, ShieldAlert, Sparkles, WandSparkles, X } from "lucide-react";
import type { WorkflowV2GenerationReviewState } from "../../../../shared/workflow-v2/generation-review";
import { WorkflowReviewTrace } from "./WorkflowReviewTrace";

interface WorkflowReviewDrawerProps {
  open: boolean;
  review?: WorkflowV2GenerationReviewState;
  reviewerControls: ReactNode;
  canReview: boolean;
  canInterrupt: boolean;
  canApplyReview: boolean;
  reviewDisabledReason?: string;
  onReview: () => void;
  onApplyReview: () => void | Promise<void>;
  onInterrupt: () => void;
  onClose: () => void;
}

const REVIEW_STATUS = {
  not_reviewed: { label: "Not reviewed", detail: "Run an independent review before confirming this revision.", icon: Bot },
  reviewing: { label: "Reviewing", detail: "The reviewer is checking topology, inputs, scripts, and failure paths.", icon: RefreshCw },
  approved: { label: "Approved", detail: "This revision passed independent review.", icon: CheckCircle2 },
  changes_requested: { label: "Changes requested", detail: "Resolve the findings before confirming this revision.", icon: ShieldAlert },
  failed: { label: "Review failed", detail: "The reviewer could not complete this review.", icon: CircleX },
} as const;

export function WorkflowReviewDrawer({ open, review, reviewerControls, canReview, canInterrupt, canApplyReview, reviewDisabledReason, onReview, onApplyReview, onInterrupt, onClose }: WorkflowReviewDrawerProps) {
  const [applyState, setApplyState] = useState<"idle" | "sending" | "sent">("idle");
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  useEffect(() => {
    setApplyState("idle");
  }, [review?.reviewedRevision, review?.status]);

  const applyReview = async () => {
    if (!canApplyReview || applyState !== "idle") return;
    setApplyState("sending");
    try {
      const pending = onApplyReview();
      setApplyState("sent");
      await pending;
      setApplyState("idle");
    } catch {
      setApplyState("idle");
    }
  };

  if (!open) return null;

  const status = review?.status ?? "not_reviewed";
  const statusMeta = REVIEW_STATUS[status];
  const StatusIcon = statusMeta.icon;
  const result = review?.result;
  const scriptRisks = result ? Object.entries(result.scriptRisks) : [];
  const isReviewing = status === "reviewing";

  return (
    <aside className="workflow-review-drawer" role="dialog" aria-modal="false" aria-label="Review Agent">
      <header className="workflow-review-drawer-header">
        <div className="workflow-review-agent-identity">
          <span className="workflow-review-agent-avatar"><Bot size={18} /></span>
          <div>
            <span className="workflow-review-eyebrow">Independent reviewer</span>
            <h3>Review Agent</h3>
          </div>
        </div>
        <button type="button" className="icon-btn" aria-label="Close Review Agent" title="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className={`workflow-review-summary is-${status}`}>
        <span className={`workflow-review-status-icon ${isReviewing ? "is-spinning" : ""}`}><StatusIcon size={18} /></span>
        <div>
          <div className="workflow-review-summary-title">
            <strong>{statusMeta.label}</strong>
            {review?.reviewedRevision !== undefined ? <span>Revision {review.reviewedRevision}</span> : null}
          </div>
          <p>{result?.summary ?? review?.error ?? statusMeta.detail}</p>
        </div>
      </div>

      <div className="workflow-review-drawer-scroll">
        <section className="workflow-review-section">
          <div className="workflow-review-section-heading">
            <div><span>Reviewer setup</span><p>Choose the agent and model used for this independent pass.</p></div>
          </div>
          <div className="workflow-review-controls-shell">{reviewerControls}</div>
        </section>

        {review?.trace?.length ? <section className="workflow-review-section">
          <div className="workflow-review-section-heading">
            <div><span>Review process</span><p>Reviewer requests, responses, tool activity, and runtime events in execution order.</p></div>
            <em>{review.trace.length}</em>
          </div>
          <WorkflowReviewTrace trace={review.trace} />
        </section> : null}

        <section className="workflow-review-section">
          <div className="workflow-review-section-heading">
            <div><span>Review findings</span><p>Blocking issues and warnings, linked to their failure path.</p></div>
            {result?.findings.length ? <em>{result.findings.length}</em> : null}
          </div>
          {result?.findings.length ? (
            <div className="workflow-review-finding-list">
              {result.findings.map((finding, index) => {
                const legacyNodeId = (finding as typeof finding & { nodeId?: string }).nodeId;
                const nodeIds = finding.nodeIds ?? (legacyNodeId ? [legacyNodeId] : []);
                return <article className={`workflow-review-finding is-${finding.severity}`} key={`${nodeIds.join(",") || "workflow"}-${index}`}>
                    <div className="workflow-review-finding-head">
                      <span><AlertTriangle size={14} />{finding.severity}</span>
                      <code>{nodeIds.length ? nodeIds.join(", ") : "workflow"}</code>
                    </div>
                    <strong>{finding.summary}</strong>
                    <p>{finding.failurePath}</p>
                    {finding.requiredChange ? <p><strong>Required change:</strong> {finding.requiredChange}</p> : null}
                  </article>;
              })}
            </div>
          ) : <div className="workflow-review-empty"><CheckCircle2 size={17} /><span>{status === "approved" ? "No findings for this revision." : "Findings will appear here after review."}</span></div>}
        </section>

        {scriptRisks.length ? <section className="workflow-review-section">
          <div className="workflow-review-section-heading"><div><span>Script risk</span><p>Declared capability and reviewer rationale for script nodes.</p></div></div>
          <div className="workflow-review-risk-list">
            {scriptRisks.map(([nodeId, risk]) => <article key={nodeId}>
              <div><code>{nodeId}</code><span className={`workflow-review-risk-level is-${risk.level}`}>{risk.level}</span></div>
              <p>{risk.rationale}</p>
            </article>)}
          </div>
        </section> : null}

        {result?.suggestions.length ? <section className="workflow-review-section">
          <div className="workflow-review-section-heading"><div><span>Suggested improvements</span><p>Optional refinements from the reviewer.</p></div></div>
          <ul className="workflow-review-suggestions">
            {result.suggestions.map((suggestion, index) => <li key={index}><Sparkles size={14} /><span>{suggestion}</span></li>)}
          </ul>
        </section> : null}
      </div>

      <footer className="workflow-review-drawer-footer">
        <span role={applyState === "sent" ? "status" : undefined}>{isReviewing
          ? "You can close this panel; review continues in the background."
          : applyState === "sent"
            ? "Review result sent. Manager Agent is revising this Workflow."
            : reviewDisabledReason ?? "A new review replaces the result for this revision."}</span>
        {isReviewing ? <button type="button" className="control-btn danger" disabled={!canInterrupt} onClick={onInterrupt}><CircleStop size={14} /><span>Interrupt review</span></button>
          : <div className="workflow-review-drawer-actions">
            {result ? <button type="button" className="control-btn" disabled={!canApplyReview || applyState !== "idle"} onClick={() => void applyReview()}>
              {applyState === "sent" ? <CheckCircle2 size={14} /> : applyState === "sending" ? <RefreshCw className="is-spinning" size={14} /> : <WandSparkles size={14} />}
              <span>{applyState === "sent" ? "Sent to Manager" : applyState === "sending" ? "Sending" : "Ask Manager to revise"}</span>
            </button> : null}
            <button type="button" className="send-btn" disabled={!canReview} onClick={onReview}><RefreshCw size={14} /><span>{result ? "Review again" : "Start review"}</span></button>
          </div>}
      </footer>
    </aside>
  );
}
