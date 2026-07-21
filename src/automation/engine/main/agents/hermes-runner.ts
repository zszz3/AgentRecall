import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent } from "../../shared/types";
import { spawnCli } from "../platform/cli-launcher";

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
  private lastSessionId: string | undefined;

  constructor(private readonly options: HermesRunOptions) {}

  async start(): Promise<void> {
    const args = ["run", "--json"];
    if (this.options.modelId && this.options.modelId !== "default") {
      args.push("--model", this.options.modelId);
    }
    args.push(this.options.prompt);

    const proc = spawnCli({
      executable: this.options.executable,
      args,
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;

    if (!proc.stdout || !proc.stderr) {
      throw new Error("Hermes runner failed to create stdout/stderr pipes");
    }

    proc.stderr.on("data", (chunk: Buffer) => {
      this.options.onStderr?.(chunk.toString());
    });

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      this.handleLine(line);
    });

    return await new Promise<void>((resolve, reject) => {
      proc.on("exit", (code) => {
        rl.close();
        this.options.onExit(code);
        resolve();
      });

      proc.on("error", (error) => {
        this.options.onEvent({ type: "error", error: error.message });
        rl.close();
        this.options.onExit(null);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    this.proc?.kill("SIGINT");
    this.proc = null;
  }

  private handleLine(line: string): void {
    try {
      const raw = JSON.parse(line) as {
        type?: unknown;
        content?: unknown;
        sessionId?: unknown;
        error?: unknown;
      };
      if (typeof raw.sessionId === "string" && raw.sessionId !== this.lastSessionId) {
        this.lastSessionId = raw.sessionId;
        this.options.onEvent({
          type: "runtime_conversation",
          runtimeConversation: {
            runtimeId: "hermes",
            codecVersion: "v1",
            payload: { sessionId: raw.sessionId },
          },
        });
      }
      if (raw.type === "delta" && typeof raw.content === "string") {
        this.options.onEvent({ type: "delta", content: raw.content });
        return;
      }
      if (raw.type === "completed") {
        if (typeof raw.content === "string") {
          this.options.onEvent({ type: "completed", content: raw.content });
        } else {
          this.options.onEvent({ type: "completed" });
        }
        return;
      }
      if (raw.type === "error" && typeof raw.error === "string") {
        this.options.onEvent({ type: "error", error: raw.error });
      }
    } catch {
      // Ignore non-JSON noise from the CLI.
    }
  }
}
