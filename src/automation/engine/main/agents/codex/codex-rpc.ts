import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { normalizeCodexNotification, createCodexStreamState } from "./codex-events";
import type { AgentEvent } from "../../../shared/types";
import { spawnCli } from "../../platform/cli-launcher";

interface RpcPending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexRpcClientOptions {
  executable: string;
  cwd: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  onEvent: (event: AgentEvent) => void;
  onRequest?: (id: number, method: string, params: Record<string, unknown>) => void;
  onStderr?: (text: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
}

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_EXIT_STDERR_CHARS = 4_000;

export class CodexRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;
  private readonly pending = new Map<number, RpcPending>();
  private nextId = 1;
  private stderr = "";
  private state = createCodexStreamState();

  constructor(private readonly options: CodexRpcClientOptions) {}

  async start(): Promise<void> {
    if (this.proc) throw new Error("Codex client already started");

    const args = ["--yolo", ...(this.options.extraArgs ?? []), "app-server", "--listen", "stdio://"];
    const proc = spawnCli({
      executable: this.options.executable,
      args,
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("Codex app-server failed to create stdio pipes");
    }
    this.proc = proc as ChildProcessWithoutNullStreams;

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderr += text;
      this.options.onStderr?.(text);
    });

    proc.on("exit", (code, signal) => {
      this.teardown(code, signal);
    });

    proc.on("error", (error) => {
      this.teardown(null, null, error);
    });

    this.rl = createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: { name: "agent-recall", title: "AgentRecall", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.proc?.stdin.writable) throw new Error("Codex client is not running");

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout after ${REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, method, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: number, result: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async interruptTurn(threadId: string, turnId: string | undefined): Promise<void> {
    if (!turnId) {
      await this.shutdown();
      return;
    }
    try {
      await this.request("turn/cancel", { threadId, turnId });
    } catch {
      await this.shutdown();
    }
  }

  async shutdown(): Promise<void> {
    this.rl?.close();
    this.rl = null;
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
  }

  private write(message: Record<string, unknown>): void {
    this.proc?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof raw.id === "number" && (raw.result !== undefined || raw.error !== undefined)) {
      const pending = this.pending.get(raw.id);
      if (!pending) return;
      this.pending.delete(raw.id);
      clearTimeout(pending.timer);

      if (raw.error && typeof raw.error === "object") {
        const err = raw.error as Record<string, unknown>;
        pending.reject(new Error(`${pending.method}: ${String(err.message ?? "unknown error")}`));
      } else {
        pending.resolve(raw.result);
      }
      return;
    }

    if (typeof raw.id === "number" && typeof raw.method === "string") {
      this.options.onRequest?.(raw.id, raw.method, (raw.params as Record<string, unknown>) ?? {});
      return;
    }

    if (typeof raw.method === "string") {
      const events = normalizeCodexNotification(raw.method, (raw.params as Record<string, unknown>) ?? {}, this.state);
      for (const event of events) this.options.onEvent(event);
    }
  }

  private teardown(
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ): void {
    const exitError = error ?? this.createExitError(code, signal);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(exitError);
    }
    this.pending.clear();
    this.rl?.close();
    this.rl = null;
    this.proc = null;
    this.options.onExit?.(code, signal, this.stderr);
  }

  private createExitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const status = code === null ? `unknown${signal ? ` (${signal})` : ""}` : String(code);
    const stderr = this.stderr.trim();
    if (!stderr) return new Error(`Codex exited with ${status}`);
    const detail = stderr.length > MAX_EXIT_STDERR_CHARS ? `...${stderr.slice(-MAX_EXIT_STDERR_CHARS)}` : stderr;
    return new Error(`Codex exited with ${status}: ${detail}`);
  }
}
