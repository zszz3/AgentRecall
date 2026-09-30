import { parentPort, workerData } from "node:worker_threads";
import { PostgresDatabase } from "../core/postgres/database";
import { PostgresTeamSessionRepository } from "../core/postgres/team-session-repository";
import { SessionStore } from "../core/session-store";
import { TeamSessionSharing } from "./services/team-session-sharing";
import type { TeamSessionDownloadWorkerData } from "./services/team-session-downloads";

const port = parentPort;
if (!port) throw new Error("Team session download requires a worker port");
const data = workerData as TeamSessionDownloadWorkerData;
const abort = new AbortController();
port.on("message", message => { if (message === "cancel") abort.abort(); });
void (async () => {
  // Main has applied migrations. This worker owns only its connection and requested immutable share.
  const database = PostgresDatabase.connect(data.connectionUrl);
  const service = new TeamSessionSharing({ store: new SessionStore(database), cache: new PostgresTeamSessionRepository(database),
    ensureDetails: async () => { throw new Error("Download workers cannot index local sources"); },
    confirm: async () => false, save: async () => false });
  let result: "ready" | "failed" = "failed";
  try {
    await service.open(data.context, data.id, data.digest, abort.signal, () => port.postMessage("indexing"));
    result = "ready";
  } catch { /* Failure is returned to the owning queue; no private packet or connection details cross into the UI. */ }
  finally {
    service.close();
    try { await database.close(); } finally { port.postMessage(result); port.close(); }
  }
})();
