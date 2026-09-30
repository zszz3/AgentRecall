import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { syncDefaultSessionsInBatches } from "../core/indexer";
import { PostgresDatabase, redactPostgresConnectionText } from "../core/postgres/database";
import { SessionStore } from "../core/session-store";
import { SessionIndexFailures } from "../core/session-index-failures";
import { createSessionIndexFailureLogger } from "./session-index-failure-log";
import type { SessionIndexWorkerData, SessionIndexWorkerRequest, SessionIndexWorkerResponse } from "./session-index-worker-protocol";

const port = parentPort;
if (!port) throw new Error("Session index worker requires a parent port.");
const data = workerData as SessionIndexWorkerData;
const failures = new SessionIndexFailures();
const logger = createSessionIndexFailureLogger(data.userDataPath);
let running = false;
const emit = (response: SessionIndexWorkerResponse): void => port.postMessage(response);

port.on("message", (request: SessionIndexWorkerRequest) => {
  if (running) {
    emit({ type: "error", requestId: request.requestId, error: "Session indexing is already running." });
    return;
  }
  running = true;
  void (async () => {
    // Main finishes schema initialization before starting this worker. Each run
    // owns its connections; the thread retains only failure backoff between runs.
    const database = PostgresDatabase.connect(data.connectionUrl);
    const store = new SessionStore(database, Promise.resolve(), path.join(data.userDataPath, "session-attachments"));
    try {
      return await syncDefaultSessionsInBatches(store, {
        batchSize: 50,
        timeBudgetMs: 8,
        loadOptions: request.loadOptions,
        failureState: failures,
        retryFailures: request.retryFailures,
        indexFailureLogPath: logger.logPath,
        logIndexFailure: logger.write,
        onProgress: (status) => {
          if (status.running) emit({ type: "progress", requestId: request.requestId, status });
        },
        onEnvironmentsChanged: () => emit({ type: "environments-changed", requestId: request.requestId }),
      });
    } finally {
      await store.close();
    }
  })().then((status) => {
    running = false;
    emit({ type: "result", requestId: request.requestId, status });
  }, (error: unknown) => {
    running = false;
    emit({ type: "error", requestId: request.requestId,
      error: redactPostgresConnectionText(error instanceof Error ? error.message : String(error)) });
  });
});
