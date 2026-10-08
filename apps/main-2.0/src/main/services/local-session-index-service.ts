import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { IndexStatus } from "../../core/indexer";
import type { SessionIndexWorkerData, SessionIndexWorkerOptions, SessionIndexWorkerRequest, SessionIndexWorkerResponse } from "../session-index-worker-protocol";

interface IndexHandlers {
  onProgress(status: IndexStatus): void;
  onEnvironmentsChanged(): void;
}

export class LocalSessionIndexService {
  private worker: Worker | null = null;
  private nextRequestId = 0;
  private pending: {
    requestId: number;
    handlers: IndexHandlers;
    resolve(status: IndexStatus): void;
    reject(error: Error): void;
  } | null = null;
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private readonly retiring = new Set<Promise<number>>();

  constructor(private readonly workerPath: string, private readonly data: SessionIndexWorkerData) {}

  run(loadOptions: SessionIndexWorkerOptions, retryFailures: boolean, handlers: IndexHandlers): Promise<IndexStatus> {
    if (this.stopped) return Promise.reject(new Error("Session indexing has stopped."));
    if (this.pending) return Promise.reject(new Error("Session indexing is already running."));
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      this.pending = { requestId, handlers, resolve, reject };
      try {
        if (!this.worker) {
          const worker = new Worker(pathToFileURL(this.workerPath), { workerData: this.data });
          this.worker = worker;
          worker.on("message", (message: SessionIndexWorkerResponse) => {
            if (this.worker !== worker || this.pending?.requestId !== message.requestId) return;
            if (message.type === "progress") this.pending.handlers.onProgress(message.status);
            else if (message.type === "environments-changed") this.pending.handlers.onEnvironmentsChanged();
            else {
              const pending = this.pending;
              this.pending = null;
              if (message.type === "result") pending.resolve(message.status);
              else pending.reject(new Error(message.error));
            }
          });
          worker.once("error", (error) => this.fail(worker, error));
          worker.once("exit", (code) => this.fail(worker, new Error(`Session index worker exited unexpectedly (code ${code}).`)));
        }
        const request: SessionIndexWorkerRequest = { requestId, loadOptions, retryFailures };
        this.worker.postMessage(request);
      } catch (error) {
        this.pending = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    if (this.worker) this.fail(this.worker, new Error("Session indexing has stopped."));
    // Termination closes the worker's sockets: PostgreSQL rolls back any open
    // transaction. Await it before the app stops its embedded database process.
    this.stopping = Promise.all([...this.retiring]).then(() => undefined);
    return this.stopping;
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    const pending = this.pending;
    this.pending = null;
    const termination = worker.terminate();
    this.retiring.add(termination);
    void termination.then(() => this.retiring.delete(termination), () => this.retiring.delete(termination));
    pending?.reject(error);
  }
}
