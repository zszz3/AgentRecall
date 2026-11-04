import { randomUUID } from "node:crypto";
import type { AgentEvent, ApprovalDecision } from "../../shared/types";

export interface RuntimeApprovalOperation {
  kind: "file_write";
  cwd: string;
  paths: string[];
}

export interface RuntimeApprovalRequest {
  ownerId: string;
  provider: string;
  content: string;
  metadata?: Record<string, unknown>;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  operation?: RuntimeApprovalOperation;
}

export type RuntimeApprovalRequester = (request: RuntimeApprovalRequest) => Promise<ApprovalDecision>;

interface PendingApproval {
  ownerId: string;
  emit: (event: AgentEvent) => void;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

export class RuntimeApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly timeoutMs = 5 * 60_000) {}

  readonly request: RuntimeApprovalRequester = (input) => {
    const requestId = `runtime-approval:${randomUUID()}`;
    input.emit({
      type: "approval_request",
      requestId,
      content: input.content,
      metadata: {
        provider: input.provider,
        approvalMode: "once",
        ...(input.operation ? { operation: input.operation } : {}),
        ...sanitizeApprovalMetadata(input.metadata),
      },
    });

    return new Promise<ApprovalDecision>((resolve) => {
      const finish = (decision: ApprovalDecision, content: string): void => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.removeAbortListener?.();
        pending.emit({ type: "approval_response", requestId, decision, content });
        pending.resolve(decision);
      };
      const timer = setTimeout(
        () => finish("rejected", "Permission request expired and was rejected."),
        this.timeoutMs,
      );
      const pending: PendingApproval = { ownerId: input.ownerId, emit: input.emit, resolve, timer };
      if (input.signal) {
        const abort = (): void => finish("rejected", "Permission request was cancelled.");
        input.signal.addEventListener("abort", abort, { once: true });
        pending.removeAbortListener = () => input.signal?.removeEventListener("abort", abort);
      }
      this.pending.set(requestId, pending);
      if (input.signal?.aborted) finish("rejected", "Permission request was cancelled.");
    });
  };

  resolve(input: { ownerId: string; requestId: string; decision: ApprovalDecision }): boolean {
    const pending = this.pending.get(input.requestId);
    if (!pending || pending.ownerId !== input.ownerId) return false;
    this.pending.delete(input.requestId);
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    pending.emit({
      type: "approval_response",
      requestId: input.requestId,
      decision: input.decision,
      content: input.decision === "approved" ? "Approved once by user." : "Rejected by user.",
    });
    pending.resolve(input.decision);
    return true;
  }

  cancelOwner(ownerId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.ownerId !== ownerId) continue;
      this.resolve({ ownerId, requestId, decision: "rejected" });
    }
  }

  cancelAll(): void {
    for (const [requestId, pending] of [...this.pending]) {
      this.resolve({ ownerId: pending.ownerId, requestId, decision: "rejected" });
    }
  }
}

function sanitizeApprovalMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  return sanitizeApprovalValue(metadata, 0) as Record<string, unknown>;
}

function sanitizeApprovalValue(value: unknown, depth: number, key = ""): unknown {
  if (/api[_-]?key|token|password|secret|authorization|cookie/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.length > 1_000 ? `${value.slice(0, 1_000)}…` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeApprovalValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 30)
      .map(([childKey, childValue]) => [childKey, sanitizeApprovalValue(childValue, depth + 1, childKey)]),
  );
}
