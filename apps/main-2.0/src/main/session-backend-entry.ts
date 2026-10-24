import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionBackend } from "./session-backend-core";
import { startSessionBackendHost } from "./session-backend-host";
import { redactPostgresConnectionText } from "../core/postgres/database";

async function main(): Promise<void> {
  const userDataPath = process.env.AGENT_RECALL_USER_DATA_DIR;
  if (!userDataPath || !path.isAbsolute(userDataPath)) throw new Error("An absolute search backend data directory is required.");
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const packagePath = path.resolve(directory, "../..");
  const metadata = JSON.parse(await fs.readFile(path.join(packagePath, "package.json"), "utf8")) as { version: string };
  let host: Awaited<ReturnType<typeof startSessionBackendHost>> | undefined;
  let stopRequested = false;
  const stop = () => {
    stopRequested = true;
    void host?.stop().catch((error: unknown) => console.error(redactPostgresConnectionText(String(error))));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    host = await startSessionBackendHost({
      userDataPath, packagePath, appVersion: metadata.version,
      createBackend: () => createSessionBackend({ userDataPath, homeDir: process.env.AGENT_RECALL_SESSION_HOME || os.homedir(), workerPath: path.join(directory, "session-index-worker.js") }),
    });
    if (stopRequested) await host.stop();
    await host.closed;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

void main().catch((error: unknown) => {
  console.error(redactPostgresConnectionText(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
