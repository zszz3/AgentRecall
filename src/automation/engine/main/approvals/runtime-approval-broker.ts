import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentEvent, ApprovalDecision } from "../../shared/types";
import { workflowStoragePlanFor } from "../../shared/workflow-v2/runtime-utils";

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
  private readonly allowedFileWriteRootsByOwner = new Map<string, Set<string>>();

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

    if (this.isAllowedFileWrite(input)) {
      input.emit({
        type: "approval_response",
        requestId,
        decision: "approved",
        content: "Auto-approved workflow output file write.",
        metadata: { approvalMode: "workflow_output_whitelist" },
      });
      return Promise.resolve("approved");
    }

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

  allowFileWritesWithin(ownerId: string, rootPath: string): void {
    const roots = this.allowedFileWriteRootsByOwner.get(ownerId) ?? new Set<string>();
    roots.add(path.resolve(rootPath));
    this.allowedFileWriteRootsByOwner.set(ownerId, roots);
  }

  allowWorkflowOutputWrites(ownerId: string, workDir: string, workflowId: string, runId: string): void {
    this.allowFileWritesWithin(ownerId, path.resolve(workDir, workflowStoragePlanFor(workflowId, runId).outputDir));
  }

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

  resolveOrThrow(input: { ownerId: string; requestId: string; decision: ApprovalDecision }): void {
    if (!this.resolve(input)) {
      throw new Error("The runtime approval request is no longer pending or does not belong to this run.");
    }
  }

  cancelOwner(ownerId: string): void {
    this.allowedFileWriteRootsByOwner.delete(ownerId);
    for (const [requestId, pending] of this.pending) {
      if (pending.ownerId !== ownerId) continue;
      this.resolve({ ownerId, requestId, decision: "rejected" });
    }
  }

  cancelAll(): void {
    this.allowedFileWriteRootsByOwner.clear();
    for (const [requestId, pending] of [...this.pending]) {
      this.resolve({ ownerId: pending.ownerId, requestId, decision: "rejected" });
    }
  }

  private isAllowedFileWrite(input: RuntimeApprovalRequest): boolean {
    const operation = input.operation;
    const allowedRoots = this.allowedFileWriteRootsByOwner.get(input.ownerId);
    if (operation?.kind !== "file_write" || !allowedRoots || operation.paths.length === 0) return false;
    return operation.paths.every((candidate) => {
      const target = path.resolve(operation.cwd, candidate);
      return [...allowedRoots].some((root) => path.dirname(target) === root);
    });
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
