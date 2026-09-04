import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "../../../shared/types";
import { runtimeModelId } from "../../../shared/models";
import { spawnCli } from "../../platform/cli-launcher";
import { hermesRuntimeStateCodec } from "./hermes-runtime-state-codec";

export interface HermesRunOptions {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  prompt: string;
  modelId?: string;
  onEvent: (event: AgentEvent) => void;
  onStderr?: (text: string) => void;
  onExit: (code: number | null) => void;
}

export class HermesRunner {
  private proc: ChildProcess | null = null;
  private stopping = false;

  constructor(private readonly options: HermesRunOptions) {}

  async start(): Promise<void> {
    const args = ["chat", "--quiet", "--query", this.options.prompt];
    const modelArg = runtimeModelId(this.options.modelId ?? "");
    if (modelArg) {
      args.push("--model", modelArg);
    }
    args.push("--source", "tool");

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
      throw new Error("Hermes runner failed to create stdout/stderr pipes");
    }

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      this.options.onStderr?.(text);
    });

    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.proc = null;
        callback();
      };

      proc.once("exit", (code) => {
        finish(() => {
          const content = stdout.trim();
          if (!this.stopping && code === 0) {
            const sessionId = hermesSessionIdFromStderr(stderr);
            if (sessionId) {
              this.options.onEvent({
                type: "runtime_conversation",
                runtimeConversation: hermesRuntimeStateCodec.encodeConversation({
                  native: { sessionId },
                  appContext: {
                    cwd: this.options.cwd,
                    ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
                  },
                }),
              });
            }
            if (content) this.options.onEvent({ type: "completed", content });
            else this.options.onEvent({ type: "error", error: "Hermes completed without assistant text." });
          } else if (!this.stopping) {
            const detail = stderr.trim() || content || "no output";
            this.options.onEvent({ type: "error", error: `Hermes exited with ${code ?? "unknown"}: ${detail.slice(0, 800)}` });
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

/** Reads the machine-readable session reference emitted by `hermes chat --quiet`. */
export function hermesSessionIdFromStderr(stderr: string): string | undefined {
  let sessionId: string | undefined;
  for (const match of stderr.matchAll(/^session_id:\s*(\S+)\s*$/gm)) sessionId = match[1];
  return sessionId;
}
