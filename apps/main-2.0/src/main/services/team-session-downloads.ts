import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { TeamSessionContext } from "./team-session-sharing";
import type { TeamSessionFetchState } from "../../shared/team-sessions";

export interface TeamSessionDownloadInput { context: TeamSessionContext; id: number; digest: string; }
export interface TeamSessionDownloadWorkerData extends TeamSessionDownloadInput { connectionUrl: string; }
type Run = (input: TeamSessionDownloadInput, signal: AbortSignal, indexing: () => void) => Promise<void>;
interface Job { input: TeamSessionDownloadInput; state: TeamSessionFetchState; abort: AbortController; }
const key = (input: TeamSessionDownloadInput) => JSON.stringify([input.context.repository, input.context.teamWide ? null : input.context.projectIdentity, input.id, input.digest]);

/** App-owned queue: navigating or closing a reader does not abandon an accepted download. */
export class TeamSessionDownloads {
  private readonly jobs = new Map<string, Job>();
  private draining: Promise<void> | null = null;
  private closed = false;
  private paused = false;
  constructor(private readonly run: Run) {}

  static worker(workerPath: string, connectionUrl: string): TeamSessionDownloads {
    return new TeamSessionDownloads((input, signal, indexing) => new Promise<void>((resolve, reject) => {
      const data: TeamSessionDownloadWorkerData = { ...input, connectionUrl };
      const worker = new Worker(pathToFileURL(workerPath), { workerData: data });
      let result: "ready" | "failed" | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        worker.postMessage("cancel");
        // CPU-bound parsing may delay delivery. Termination closes its DB connection and rolls back an unfinished transaction.
        timeout ??= setTimeout(() => { void worker.terminate(); }, 5000);
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      worker.on("message", (message: unknown) => {
        if (message === "indexing") indexing();
        else if (message === "ready" || message === "failed") result = message;
      });
      worker.on("error", () => { result = "failed"; });
      worker.once("exit", () => {
        if (timeout) clearTimeout(timeout);
        signal.removeEventListener("abort", cancel);
        if (result === "ready") resolve();
        else reject(new Error("共享会话下载或索引失败，请重试。"));
      });
    }));
  }

  start(input: TeamSessionDownloadInput): TeamSessionFetchState {
    if (this.closed || this.paused) throw new Error("Team downloads are closed");
    const identity = key(input), existing = this.jobs.get(identity);
    if (existing && !["failed", "cancelled"].includes(existing.state.phase)) return { ...existing.state };
    if (this.jobs.size >= 100) {
      for (const [id, job] of this.jobs) if (["ready", "failed", "cancelled"].includes(job.state.phase)) this.jobs.delete(id);
      if (this.jobs.size >= 100) throw new Error("下载队列已满，请等待当前任务完成。");
    }
    const job: Job = { input, state: { id: input.id, digest: input.digest, phase: "queued" }, abort: new AbortController() };
    this.jobs.set(identity, job);
    this.drain();
    return { ...job.state };
  }
  status(input: TeamSessionDownloadInput): TeamSessionFetchState | null { return this.jobs.get(key(input))?.state ?? null; }
  cancel(input: TeamSessionDownloadInput): void {
    const job = this.jobs.get(key(input));
    if (!job || ["ready", "failed", "cancelled"].includes(job.state.phase)) return;
    job.abort.abort();
    if (job.state.phase === "queued") job.state = { ...job.state, phase: "cancelled" };
  }
  resume(): void { this.paused = false; }
  async pause(): Promise<void> { this.paused = true; await this.cancelAll(); }
  private async cancelAll(): Promise<void> {
    for (const job of this.jobs.values()) this.cancel(job.input);
    await this.draining;
  }
  async close(): Promise<void> { this.closed = true; await this.cancelAll(); }
  private drain(): void {
    if (this.draining) return;
    this.draining = (async () => {
      for (;;) {
        const job = [...this.jobs.values()].find(entry => entry.state.phase === "queued");
        if (!job) break;
        job.state = { ...job.state, phase: "downloading" };
        try {
          await this.run(job.input, job.abort.signal, () => { job.state = { ...job.state, phase: "indexing" }; });
          job.state = { ...job.state, phase: "ready" };
        } catch {
          job.state = { ...job.state, phase: job.abort.signal.aborted ? "cancelled" : "failed", ...(job.abort.signal.aborted ? {} : { error: "共享会话下载或索引失败，请重试。" }) };
        }
      }
    })().finally(() => {
      this.draining = null;
      if (!this.closed && !this.paused && [...this.jobs.values()].some(job => job.state.phase === "queued")) this.drain();
    });
  }
}
