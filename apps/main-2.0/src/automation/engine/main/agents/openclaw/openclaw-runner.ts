import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "../../../shared/types";
import { runtimeModelId } from "../../../shared/models";
import { spawnCli } from "../../platform/cli-launcher";
import { openClawRuntimeStateCodec } from "./openclaw-runtime-state-codec";

const MAX_STDERR_CHARS = 8_000;

export interface OpenClawRunOptions {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  prompt: string;
  sessionId: string;
  modelId?: string;
  onEvent: (event: AgentEvent) => void;
  onStderr?: (text: string) => void;
  onExit: (code: number | null) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function responsePayloads(record: Record<string, unknown>): unknown[] {
  if (Array.isArray(record.payloads)) return record.payloads;
  const result = asRecord(record.result);
  return Array.isArray(result?.payloads) ? result.payloads : [];
}

export function textFromOpenClawResponse(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  return responsePayloads(record)
    .map((item) => asRecord(item)?.text)
    .filter((text): text is string => typeof text === "string" && Boolean(text.trim()))
    .join("\n")
    .trim();
}

export function errorFromOpenClawResponse(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return "OpenClaw returned a non-object JSON response.";
  const status = typeof record.status === "string" ? record.status : undefined;
  if (status && status !== "ok" && status !== "accepted") {
    const error = asRecord(record.error);
    return typeof error?.message === "string"
      ? error.message
      : typeof record.error === "string"
        ? record.error
        : `OpenClaw returned status ${status}.`;
  }
  return undefined;
}

export class OpenClawRunner {
  private proc: ChildProcess | undefined;
  private stopping = false;

  constructor(private readonly options: OpenClawRunOptions) {}

  async start(): Promise<void> {
    // Requires an OpenClaw CLI that keys agent runs by `--session-id`
    // (earlier builds used `--session-key`); an unsupported flag exits
    // non-zero and surfaces as a failed invocation.
    const args = [
      "agent",
      "--session-id",
      this.options.sessionId,
      "--message",
      this.options.prompt,
      "--json",
    ];
    const modelArg = runtimeModelId(this.options.modelId ?? "");
    if (modelArg) args.push("--model", modelArg);
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
      throw new Error("OpenClaw runner failed to create stdout/stderr pipes.");
    }
    this.options.onEvent({
      type: "runtime_conversation",
      runtimeConversation: openClawRuntimeStateCodec.encodeConversation({
        native: { sessionId: this.options.sessionId },
        appContext: {
          cwd: this.options.cwd,
          ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
        },
      }),
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
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
        finish(() => {
          if (!this.stopping && code === 0) {
            let response: unknown;
            try {
              response = JSON.parse(stdout.trim());
            } catch {
              this.options.onEvent({ type: "error", error: `OpenClaw emitted invalid JSON: ${stdout.trim().slice(0, 400) || "empty stdout"}` });
              this.options.onExit(code);
              return;
            }
            const responseError = errorFromOpenClawResponse(response);
            const content = textFromOpenClawResponse(response);
            if (responseError) this.options.onEvent({ type: "error", error: responseError });
            else if (content) this.options.onEvent({ type: "completed", content });
            else this.options.onEvent({ type: "error", error: "OpenClaw completed without assistant text." });
          } else if (!this.stopping) {
            const detail = stderr.trim() || stdout.trim() || "no output";
            this.options.onEvent({ type: "error", error: `OpenClaw exited with ${code ?? "unknown"}: ${detail.slice(0, 800)}` });
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
