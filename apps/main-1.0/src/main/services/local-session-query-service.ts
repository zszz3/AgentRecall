import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type {
  ProjectQueryOptions,
  ProjectSummary,
  ProjectTagEntry,
  SearchOptions,
  SessionSearchPage,
  SessionSearchResult,
  SessionStats,
  SessionStatsOptions,
  SessionStatsTrend,
  TagListOptions,
} from "../../core/types";
import type {
  SessionQueryWorkerInput,
  SessionQueryWorkerMethod,
  SessionQueryWorkerOperations,
  SessionQueryWorkerRequest,
  SessionQueryWorkerResponse,
} from "../session-query-worker-protocol";

interface PendingQuery {
  worker: Worker;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function workerError(response: Extract<SessionQueryWorkerResponse, { type: "error" }>): Error {
  const error = new Error(response.error.message);
  error.name = response.error.name || "Error";
  if (response.error.stack) error.stack = response.error.stack;
  return error;
}

export class LocalSessionQueryService {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingQuery>();
  private nextRequestId = 1;
  private stopped = false;

  constructor(
    private readonly workerPath: string,
    private readonly input: SessionQueryWorkerInput,
  ) {}

  searchSessions(options: SearchOptions = {}): Promise<SessionSearchResult[]> {
    return this.request("searchSessions", options);
  }

  searchSessionPage(options: SearchOptions = {}): Promise<SessionSearchPage> {
    return this.request("searchSessionPage", options);
  }

  getStats(options: SessionStatsOptions = {}): Promise<SessionStats> {
    return this.request("getStats", options);
  }

  getStatsTrend(options: SessionStatsOptions = {}): Promise<SessionStatsTrend> {
    return this.request("getStatsTrend", options);
  }

  listTags(options: TagListOptions = {}): Promise<string[]> {
    return this.request("listTags", options);
  }

  listProjects(options: ProjectQueryOptions = {}): Promise<ProjectSummary[]> {
    return this.request("listProjects", options);
  }

  listTagsByProject(options: { excludeSubagents?: boolean } = {}): Promise<ProjectTagEntry[]> {
    return this.request("listTagsByProject", options);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const worker = this.worker;
    this.worker = null;
    const error = new Error("Local session query worker stopped.");
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.reject(error);
    }
    if (worker) void worker.terminate();
  }

  private request<Method extends SessionQueryWorkerMethod>(
    method: Method,
    options: SessionQueryWorkerOperations[Method]["options"],
  ): Promise<SessionQueryWorkerOperations[Method]["result"]> {
    if (this.stopped) {
      return Promise.reject(new Error("Local session query worker has stopped."));
    }
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const requestId = this.nextRequestId++;
    const request = {
      type: "request",
      requestId,
      method,
      options,
    } as SessionQueryWorkerRequest;

    return new Promise<SessionQueryWorkerOperations[Method]["result"]>((resolve, reject) => {
      this.pending.set(requestId, {
        worker,
        resolve: (value) => resolve(value as SessionQueryWorkerOperations[Method]["result"]),
        reject,
      });
      try {
        worker.postMessage(request);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(pathToFileURL(this.workerPath), { workerData: this.input });
    this.worker = worker;
    worker.on("message", (response: SessionQueryWorkerResponse) => this.handleResponse(worker, response));
    worker.once("error", (error) => this.failWorker(worker, error));
    worker.once("exit", (code) => {
      if (this.worker !== worker && !this.hasPendingFor(worker)) return;
      this.failWorker(
        worker,
        new Error(`Local session query worker exited unexpectedly (code ${code}).`),
      );
    });
    return worker;
  }

  private handleResponse(worker: Worker, response: SessionQueryWorkerResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.worker !== worker) return;
    this.pending.delete(response.requestId);
    if (response.type === "error") {
      pending.reject(workerError(response));
      return;
    }
    pending.resolve(response.result);
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker === worker) this.worker = null;
    for (const [requestId, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      this.pending.delete(requestId);
      pending.reject(error);
    }
    // The worker may not have exited on its own (e.g. an uncaught error in a
    // thread that stays alive); reclaim its thread instead of leaking it.
    void worker.terminate();
  }

  private hasPendingFor(worker: Worker): boolean {
    for (const pending of this.pending.values()) {
      if (pending.worker === worker) return true;
    }
    return false;
  }
}
