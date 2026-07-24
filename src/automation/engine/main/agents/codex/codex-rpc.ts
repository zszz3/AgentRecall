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
  requiredMcpTools?: Record<string, readonly string[]>;
}

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_EXIT_STDERR_CHARS = 4_000;
const MCP_STARTUP_TIMEOUT_MS = 15_000;

export class CodexRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;
  private readonly pending = new Map<number, RpcPending>();
  private nextId = 1;
  private stderr = "";
  private state = createCodexStreamState();
  private readonly mcpStartupStatus = new Map<string, { status: string; error: string }>();

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
    await this.ensureRequiredMcpTools();
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
      if (raw.method === "mcpServer/startupStatus/updated") {
        const params = (raw.params as Record<string, unknown>) ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        if (name) {
          this.mcpStartupStatus.set(name, {
            status: typeof params.status === "string" ? params.status : "",
            error: typeof params.error === "string" ? params.error : "",
          });
        }
      }
      const events = normalizeCodexNotification(raw.method, (raw.params as Record<string, unknown>) ?? {}, this.state);
      for (const event of events) this.options.onEvent(event);
    }
  }

  private async ensureRequiredMcpTools(): Promise<void> {
    const requiredServers = Object.entries(this.options.requiredMcpTools ?? {});
    if (requiredServers.length === 0) return;
    const deadline = Date.now() + MCP_STARTUP_TIMEOUT_MS;

    while (Date.now() < deadline) {
      for (const [serverName] of requiredServers) {
        const startup = this.mcpStartupStatus.get(serverName);
        if (startup?.status === "failed" || startup?.status === "cancelled") {
          throw new Error(`Codex MCP server ${serverName} ${startup.status}${startup.error ? `: ${startup.error}` : ""}`);
        }
      }

      const response = await this.request("mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
        threadId: null,
      }) as { data?: Array<{ name?: string; tools?: Record<string, unknown> }> };
      let allReady = true;
      for (const [serverName, requiredTools] of requiredServers) {
        const server = response.data?.find((candidate) => candidate.name === serverName);
        if (!server) {
          allReady = false;
          continue;
        }
        const availableTools = new Set(Object.keys(server.tools ?? {}));
        const missingTools = requiredTools.filter((toolName) => !availableTools.has(toolName));
        if (missingTools.length > 0) {
          throw new Error(`Codex MCP server ${serverName} is missing required tools: ${missingTools.join(", ")}`);
        }
      }
      if (allReady) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Codex MCP startup timed out: ${requiredServers.map(([serverName]) => serverName).join(", ")}`);
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
