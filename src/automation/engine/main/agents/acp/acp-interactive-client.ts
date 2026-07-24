import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentEvent,
} from "../../../shared/types";
import {
  workflowMcpToolDecision,
  workflowMcpToolNameFromIdentifier,
  type WorkflowMcpScope,
  type WorkflowMcpToolDecision,
} from "../../../shared/workflow-mcp-policy";
import { spawnCli } from "../../platform/cli-launcher";
  import type { RuntimeApprovalOperation, RuntimeApprovalRequester } from "../../approvals/runtime-approval-broker";

const ACP_ATTACH_TIMEOUT_MS = 20_000;
const ACP_CONFIG_TIMEOUT_MS = 10_000;
const MAX_STDERR_CHARS = 8_000;

export interface AcpInteractiveClientOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  mcpServers?: acp.McpServer[];
  onEvent: (event: AgentEvent) => void;
  onExit?: (error?: Error) => void;
  approvalOwnerId?: string;
  requestApproval?: RuntimeApprovalRequester;
  workflowMcpScope?: WorkflowMcpScope;
}

export function workflowMcpDecisionFromAcpToolCall(
  title: string,
  scope: WorkflowMcpScope,
): WorkflowMcpToolDecision {
  const toolName = workflowMcpToolNameFromIdentifier(title);
  return toolName ? workflowMcpToolDecision(scope, toolName) : "deny";
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function textFromContent(content: acp.ContentBlock): string {
  if (content.type === "text") return content.text;
  return stringifyValue(content);
}

export function agentEventsFromAcpUpdate(update: acp.SessionUpdate): AgentEvent[] {
  if (update.sessionUpdate === "agent_message_chunk") {
    const content = textFromContent(update.content);
    return content ? [{ type: "delta", content }] : [];
  }
  if (update.sessionUpdate === "agent_thought_chunk") {
    const content = textFromContent(update.content);
    return content ? [{ type: "meta", content }] : [];
  }
  if (update.sessionUpdate === "tool_call") {
    return [{
      type: "tool_call",
      name: update.title,
      content: stringifyValue(update.rawInput),
      metadata: {
        toolCallId: update.toolCallId,
        ...(update.kind ? { kind: update.kind } : {}),
        ...(update.status ? { status: update.status } : {}),
      },
    }];
  }
  if (update.sessionUpdate === "tool_call_update") {
    const terminal = update.status === "completed" || update.status === "failed";
    const content = stringifyValue(update.rawOutput ?? update.content ?? update.title ?? update.status);
    return [{
      type: terminal ? "tool_result" : "meta",
      ...(update.title ? { name: update.title } : {}),
      content,
      metadata: {
        toolCallId: update.toolCallId,
        ...(update.kind ? { kind: update.kind } : {}),
        ...(update.status ? { status: update.status } : {}),
      },
    } as AgentEvent];
  }
  if (update.sessionUpdate === "plan" || update.sessionUpdate === "plan_update") {
    return [{ type: "meta", content: stringifyValue(update) }];
  }
  if (update.sessionUpdate === "session_info_update" || update.sessionUpdate === "current_mode_update") {
    return [{ type: "system", content: stringifyValue(update), metadata: { acpUpdate: update.sessionUpdate } }];
  }
  return [];
}

export function fileWriteOperationFromAcpUpdate(
  update: acp.SessionUpdate,
  cwd: string,
): RuntimeApprovalOperation | undefined {
  if (update.sessionUpdate !== "tool_call") return undefined;
  const writeLike = update.kind === "edit" || /\b(write|edit|create)\b/i.test(update.title);
  if (!writeLike || !update.rawInput || typeof update.rawInput !== "object") return undefined;
  const input = update.rawInput as Record<string, unknown>;
  const candidate = [input.file_path, input.path, input.notebook_path]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return candidate ? { kind: "file_write", cwd, paths: [candidate] } : undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class AcpInteractiveClient {
  private proc: ChildProcess | undefined;
  private connection: acp.ClientConnection | undefined;
  private currentSessionId: string | undefined;
  private stderr = "";
  private detaching = false;
  private readonly fileWriteOperationByToolCallId = new Map<string, RuntimeApprovalOperation>();

  constructor(private readonly options: AcpInteractiveClientOptions) {}

  isAttached(): boolean {
    return Boolean(this.proc && this.connection && this.currentSessionId);
  }

  sessionId(): string | undefined {
    return this.currentSessionId;
  }

  async attach(resumeSessionId?: string): Promise<string> {
    if (this.isAttached()) return this.currentSessionId!;
    const proc = spawnCli({
      executable: this.options.executable,
      args: this.options.args,
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.detaching = false;
    this.stderr = "";

    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      this.clearConnection();
      throw new Error("ACP runtime failed to create stdio pipes.");
    }

    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
    });
    proc.once("error", (error) => this.handleProcessExit(proc, error));
    proc.once("exit", (code, signal) => {
      const status = code === null ? signal ?? "unknown" : String(code);
      const detail = this.stderr.trim();
      this.handleProcessExit(proc, new Error(`ACP runtime exited with ${status}${detail ? `: ${detail}` : ""}`));
    });

    const app = acp
      .client({ name: "agent-recall" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params, requestId }) =>
        this.handlePermissionRequest(params, requestId))
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.sessionId !== this.currentSessionId) return;
        const operation = fileWriteOperationFromAcpUpdate(params.update, this.options.cwd);
        if (params.update.sessionUpdate === "tool_call" && operation) {
          this.fileWriteOperationByToolCallId.set(params.update.toolCallId, operation);
        }
        for (const event of agentEventsFromAcpUpdate(params.update)) this.options.onEvent(event);
      });
    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    this.connection = connection;

    try {
      await withTimeout(
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "agent-recall", version: "0.1.0" },
        }),
        ACP_ATTACH_TIMEOUT_MS,
        "ACP initialize",
      );

      if (resumeSessionId) {
        this.currentSessionId = resumeSessionId;
        await withTimeout(
          connection.agent.request(acp.methods.agent.session.resume, {
            sessionId: resumeSessionId,
            cwd: this.options.cwd,
            mcpServers: this.options.mcpServers ?? [],
          }),
          ACP_ATTACH_TIMEOUT_MS,
          "ACP session resume",
        );
      } else {
        const response = await withTimeout(
          connection.agent.request(acp.methods.agent.session.new, {
            cwd: this.options.cwd,
            mcpServers: this.options.mcpServers ?? [],
          }),
          ACP_ATTACH_TIMEOUT_MS,
          "ACP session create",
        );
        this.currentSessionId = response.sessionId;
      }

      if (this.options.modelId && this.options.modelId !== "default") {
        await withTimeout(
          connection.agent.request("session/set_model", {
            sessionId: this.currentSessionId,
            modelId: this.options.modelId,
          }),
          ACP_CONFIG_TIMEOUT_MS,
          "ACP model selection",
        );
      }
      return this.currentSessionId;
    } catch (error) {
      await this.detach();
      throw error;
    }
  }

  async prompt(prompt: string): Promise<void> {
    const connection = this.connection;
    const sessionId = this.currentSessionId;
    if (!connection || !sessionId) throw new Error("ACP interactive client is not attached.");
    const response = await connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    if (response.stopReason === "refusal") {
      this.options.onEvent({ type: "error", error: "ACP runtime refused the prompt." });
      return;
    }
    this.options.onEvent({ type: "completed" });
  }

  async interrupt(): Promise<void> {
    const connection = this.connection;
    const sessionId = this.currentSessionId;
    if (!connection || !sessionId) return;
    await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async detach(): Promise<void> {
    this.detaching = true;
    const proc = this.proc;
    this.connection?.close();
    this.clearConnection();
    if (proc && !proc.killed) proc.kill("SIGTERM");
  }

  private handlePermissionRequest(
    params: acp.RequestPermissionRequest,
    requestId: acp.JsonRpcId,
  ): Promise<acp.RequestPermissionResponse> {
    const allowOnce = params.options.find((option) => option.kind === "allow_once");
    const workflowDecision = this.options.workflowMcpScope
      ? workflowMcpDecisionFromAcpToolCall(params.toolCall.title ?? "", this.options.workflowMcpScope)
      : undefined;
    if (allowOnce && workflowDecision === "allow") {
      return Promise.resolve({ outcome: { outcome: "selected", optionId: allowOnce.optionId } });
    }
    if (!allowOnce || !this.options.approvalOwnerId || workflowDecision === "deny" || !this.options.requestApproval) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    return this.options.requestApproval({
      ownerId: this.options.approvalOwnerId,
      provider: "acp",
      content: params.toolCall.title ?? "ACP runtime requests permission.",
      metadata: {
        nativeRequestId: String(requestId ?? `permission:${randomUUID()}`),
        sessionId: params.sessionId,
        toolCallId: params.toolCall.toolCallId,
        options: params.options.map((option) => ({ id: option.optionId, name: option.name, kind: option.kind })),
      },
      emit: this.options.onEvent,
      ...(this.fileWriteOperationByToolCallId.get(params.toolCall.toolCallId)
        ? { operation: this.fileWriteOperationByToolCallId.get(params.toolCall.toolCallId)! }
        : {}),
    }).then((decision) => decision === "approved"
      ? { outcome: { outcome: "selected", optionId: allowOnce.optionId } }
      : { outcome: { outcome: "cancelled" } });
  }

  private handleProcessExit(proc: ChildProcess, error: Error): void {
    if (this.proc !== proc) return;
    const expected = this.detaching;
    this.clearConnection();
    if (expected) return;
    this.options.onEvent({ type: "error", error: error.message });
    this.options.onExit?.(error);
  }

  private clearConnection(): void {
    this.proc = undefined;
    this.connection = undefined;
    this.currentSessionId = undefined;
    this.fileWriteOperationByToolCallId.clear();
  }
}
