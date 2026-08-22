import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { LiveSessionSnapshot } from "../../core/types";
import type {
  LiveSessionWorkerLoadOptions,
  LiveSessionWorkerRequest,
  LiveSessionWorkerResponse,
} from "../live-session-worker-protocol";

interface PendingLoad {
  worker: Worker;
  resolve: (snapshot: LiveSessionSnapshot) => void;
  reject: (error: Error) => void;
}

function workerError(response: Extract<LiveSessionWorkerResponse, { type: "error" }>): Error {
  const error = new Error(response.error.message);
  error.name = response.error.name || "Error";
  if (response.error.stack) error.stack = response.error.stack;
  return error;
}

export class LocalLiveSessionService {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingLoad>();
  private nextRequestId = 1;
  private stopped = false;

  constructor(private readonly workerPath: string) {}

  load(options: LiveSessionWorkerLoadOptions = {}): Promise<LiveSessionSnapshot> {
    if (this.stopped) {
      return Promise.reject(new Error("Local live session worker has stopped."));
    }
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const requestId = this.nextRequestId++;
    const request: LiveSessionWorkerRequest = {
      type: "load",
      requestId,
      options,
    };

    return new Promise<LiveSessionSnapshot>((resolve, reject) => {
      this.pending.set(requestId, { worker, resolve, reject });
      try {
        worker.postMessage(request);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const worker = this.worker;
    this.worker = null;
    const error = new Error("Local live session worker stopped.");
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.reject(error);
    }
    if (worker) void worker.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(pathToFileURL(this.workerPath));
    this.worker = worker;
    worker.on("message", (response: LiveSessionWorkerResponse) => this.handleResponse(worker, response));
    worker.once("error", (error) => this.failWorker(worker, error));
    worker.once("exit", (code) => {
      if (this.worker !== worker && !this.hasPendingFor(worker)) return;
      this.failWorker(
        worker,
        new Error(`Local live session worker exited unexpectedly (code ${code}).`),
      );
    });
    return worker;
  }

  private handleResponse(worker: Worker, response: LiveSessionWorkerResponse): void {
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
