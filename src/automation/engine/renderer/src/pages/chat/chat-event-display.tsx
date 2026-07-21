import { useState } from "react";
import { agentLabel } from "../../app/agents";
import type { ApprovalDecision, ChatEvent } from "../../../../shared/types";

export function chatEventDisplayContent(event: ChatEvent): string {
  if (event.type === "tool_call") {
    const name = event.name ?? "tool";
    return event.content ? `→ ${name}\n${event.content}` : `→ ${name}`;
  }
  if (event.type === "tool_result") {
    const name = event.name ?? "tool";
    return event.content ? `✓ ${name}\n${event.content}` : `✓ ${name}`;
  }
  if (event.type === "system") {
    return event.content ? `system\n${event.content}` : "system";
  }
  if (event.type === "handoff") {
    const from = event.fromAgentId ? agentLabel(event.fromAgentId) : "Agent";
    const to = event.toAgentId ? agentLabel(event.toAgentId) : "Agent";
    return event.content ? `${from} → ${to}\n${event.content}` : `${from} → ${to}`;
  }
  if (event.type === "approval_request") {
    const label = event.requestState === "expired" ? "approval expired" : "approval pending";
    const metadata = event.metadata && Object.keys(event.metadata).length > 0
      ? JSON.stringify(event.metadata, null, 2)
      : "";
    return [label, event.content, metadata].filter(Boolean).join("\n");
  }
  if (event.type === "approval_response") {
    const label = event.decision === "rejected" ? "approval rejected" : "approval approved";
    return event.content ? `${label}\n${event.content}` : label;
  }
  if (event.type === "user_input_request") {
    const label = event.requestState === "expired" ? "input request expired" : "input request";
    return event.content ? `${label}\n${event.content}` : label;
  }
  if (event.type === "user_input_response") {
    return event.content ? `input provided\n${event.content}` : "input provided";
  }
  if (event.type === "error") {
    return event.content ? `error\n${event.content}` : "error";
  }
  return event.content;
}

export function MetaMessage({ content }: { content: string }) {
  const [summary, ...bodyLines] = content.split("\n");
  const body = bodyLines.join("\n").trim();

  if (!body) {
    return <pre>{summary}</pre>;
  }

  return (
    <details className="cli-meta-details">
      <summary>{summary}</summary>
      <pre>{body}</pre>
    </details>
  );
}

export function ChatEventMessage({
  event,
  ownerId,
  onResolveApproval,
}: {
  event: ChatEvent;
  ownerId: string;
  onResolveApproval: ((ownerId: string, requestId: string, decision: ApprovalDecision) => void | Promise<void>) | undefined;
}) {
  const [resolving, setResolving] = useState(false);
  const liveApproval = event.type === "approval_request"
    && event.requestState === "live"
    && event.requestId
    && onResolveApproval;
  if (!liveApproval) return <MetaMessage content={chatEventDisplayContent(event)} />;
  const resolve = async (decision: ApprovalDecision): Promise<void> => {
    if (resolving) return;
    setResolving(true);
    try {
      await onResolveApproval(ownerId, event.requestId!, decision);
    } catch {
      setResolving(false);
    }
  };

  return (
    <div className="runtime-approval-card">
      <MetaMessage content={chatEventDisplayContent(event)} />
      <div className="runtime-approval-actions">
        <button type="button" className="send-btn" disabled={resolving} onClick={() => void resolve("approved")}>
          Approve once
        </button>
        <button type="button" className="icon-btn" disabled={resolving} onClick={() => void resolve("rejected")}>
          Reject
        </button>
      </div>
    </div>
  );
}
