import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "../../../shared/types";
import { spawnCli } from "../../platform/cli-launcher";

const MAX_STDERR_CHARS = 8_000;

export interface OpenCodeRunOptions {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  prompt: string;
  modelId?: string;
  onEvent: (event: AgentEvent) => void;
  onStderr?: (text: string) => void;
  onExit: (code: number | null) => void;
}

interface OpenCodeJsonEvent {
  type?: unknown;
  sessionID?: unknown;
  part?: unknown;
  error?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function agentEventsFromOpenCodeJson(record: OpenCodeJsonEvent): AgentEvent[] {
  const type = typeof record.type === "string" ? record.type : undefined;
  const part = asRecord(record.part);
  if (type === "text" && part?.type === "text" && typeof part.text === "string") {
    return part.text ? [{ type: "delta", content: part.text }] : [];
  }
  if (type === "reasoning" && part?.type === "reasoning" && typeof part.text === "string") {
    return part.text ? [{ type: "meta", content: part.text }] : [];
  }
  if (type === "tool_use" && part?.type === "tool") {
    const state = asRecord(part.state);
    const name = typeof part.tool === "string" ? part.tool : undefined;
    return [{
      type: state?.status === "completed" || state?.status === "error" ? "tool_result" : "tool_call",
      ...(name ? { name } : {}),
      content: stringify(state?.output ?? state?.error ?? state?.input ?? state ?? part),
      metadata: {
        ...(typeof part.callID === "string" ? { toolCallId: part.callID } : {}),
        ...(typeof state?.status === "string" ? { status: state.status } : {}),
      },
    }];
  }
  if (type === "step_start" || type === "step_finish") {
    return [{ type: "meta", content: stringify(part ?? record) }];
  }
  if (type === "error") {
    return [{ type: "error", error: stringify(record.error ?? "OpenCode reported an unknown error.") }];
  }
  return [];
}

export class OpenCodeRunner {
  private proc: ChildProcess | undefined;
  private stopping = false;

  constructor(private readonly options: OpenCodeRunOptions) {}

  async start(): Promise<void> {
    const args = ["run", "--format", "json"];
    if (this.options.modelId && this.options.modelId !== "default") args.push("--model", this.options.modelId);
    args.push(this.options.prompt);

    const proc = spawnCli({
      executable: this.options.executable,
      args,
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    this.stopping = false;

    if (!proc.stdout || !proc.stderr) {
      this.proc = undefined;
      throw new Error("OpenCode runner failed to create stdout/stderr pipes.");
    }

    let pending = "";
    let content = "";
    let stderr = "";
    let runtimeError: string | undefined;
    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let record: OpenCodeJsonEvent;
      try {
        record = JSON.parse(trimmed) as OpenCodeJsonEvent;
      } catch {
        runtimeError = `OpenCode emitted invalid JSON: ${trimmed.slice(0, 400)}`;
        this.options.onEvent({ type: "error", error: runtimeError });
        return;
      }
      for (const event of agentEventsFromOpenCodeJson(record)) {
        if (event.type === "delta") content += event.content;
        if (event.type === "error") runtimeError = event.error;
        this.options.onEvent(event);
      }
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = `${stderr}${text}`.slice(-MAX_STDERR_CHARS);
      this.options.onStderr?.(text);
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.proc = undefined;
        callback();
      };
      proc.once("exit", (code) => {
        if (pending) handleLine(pending);
        finish(() => {
          if (!this.stopping && code === 0 && !runtimeError) {
            if (content.trim()) this.options.onEvent({ type: "completed", content: content.trim() });
            else this.options.onEvent({ type: "error", error: "OpenCode completed without assistant text." });
          } else if (!this.stopping && !runtimeError) {
            const detail = stderr.trim() || "no output";
            this.options.onEvent({ type: "error", error: `OpenCode exited with ${code ?? "unknown"}: ${detail.slice(0, 800)}` });
          }
          this.options.onExit(this.stopping ? null : code);
          this.stopping = false;
        });
        resolve();
      });
      proc.once("error", (error) => {
        finish(() => {
          this.options.onEvent({ type: "error", error: error.message });
          this.options.onExit(null);
          this.stopping = false;
        });
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.proc?.kill("SIGINT");
  }
}
