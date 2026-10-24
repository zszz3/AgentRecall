import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { IndexStatus } from "../core/indexer";
import type { PostgresRuntime } from "./postgres/managed-postgres";

export interface SessionBackendClientOptions {
  userDataPath?: string;
  packagePath?: string;
  nodePath?: string;
  homeDir?: string;
  desktopPid?: number;
  start?: boolean;
  timeoutMs?: number;
}
interface BackendClientModule {
  requestSessionBackend(action: string, body?: unknown, options?: SessionBackendClientOptions): Promise<unknown>;
}

function currentPackagePath(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, "bin", "session-backend-client.cjs"))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("独立搜索组件未安装，请更新 AgentRecall V2。");
    directory = parent;
  }
  return directory;
}

export function requestLocalSessionBackend(action: string, body: unknown = {}, options: SessionBackendClientOptions = {}): Promise<unknown> {
  const packagePath = options.packagePath ?? currentPackagePath();
  const client = createRequire(import.meta.url)(path.join(packagePath, "bin", "session-backend-client.cjs")) as BackendClientModule;
  return client.requestSessionBackend(action, body, { ...options, packagePath });
}

const leaseSchema = z.object({ connectionUrl: z.string().startsWith("postgres"), leaseId: z.string().regex(/^[a-f0-9]{64}$/) });
const indexSchema = z.object({ running: z.boolean(), indexed: z.number(), skipped: z.number(), total: z.number(), lastIndexedAt: z.number().nullable(), error: z.string().nullable() });

export interface DesktopSessionBackend extends PostgresRuntime {
  refresh(retryFailures: boolean, onProgress: (status: IndexStatus) => void): Promise<IndexStatus>;
}

/** A desktop lease pins the shared service; stop releases only this client, never PostgreSQL. */
export async function connectDesktopSessionBackend(options: SessionBackendClientOptions & { onError(message: string): void }): Promise<DesktopSessionBackend> {
  const clientOptions = { ...options, desktopPid: process.pid };
  const request = (action: string, body: unknown = {}, start = true) => requestLocalSessionBackend(action, body, { ...clientOptions, start });
  let lease = leaseSchema.parse(await request("attach"));
  const connectionUrl = lease.connectionUrl;
  let stopped = false;
  let renewing: Promise<void> | null = null;
  const renew = async () => {
    if (stopped || renewing) return;
    renewing = (async () => {
      let value: unknown;
      try { value = await request("attach", { leaseId: lease.leaseId }); }
      catch {
        // A crashed service has lost its in-memory lease. Reattach instead of
        // retaining the old ID; the owner still validates package and version.
        if (stopped) return;
        value = await request("attach");
      }
      lease = leaseSchema.parse(value);
      if (lease.connectionUrl !== connectionUrl) throw new Error("搜索数据库连接已改变，请重新启动 AgentRecall。");
    })().catch((error: unknown) => options.onError(error instanceof Error ? error.message : String(error))).finally(() => { renewing = null; });
    await renewing;
  };
  const timer = setInterval(() => { void renew(); }, 30_000);
  timer.unref();
  let stopping: Promise<void> | null = null;
  return {
    connectionUrl, managed: false,
    refresh: async (retryFailures, onProgress) => {
      if (stopped) throw new Error("桌面已断开搜索后台。");
      let polling: Promise<void> | null = null;
      const poll = () => {
        if (polling) return;
        polling = request("status", {}, false).then((value) => {
          const status = z.object({ indexStatus: indexSchema }).parse(value);
          onProgress(status.indexStatus);
        }).catch((error: unknown) => options.onError(error instanceof Error ? error.message : String(error))).finally(() => { polling = null; });
      };
      const progressTimer = setInterval(poll, 500);
      try { return indexSchema.parse(await request("refresh", { retryFailures })); }
      finally { clearInterval(progressTimer); await polling; }
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      stopping ??= (async () => {
        await renewing;
        await request("release", { leaseId: lease.leaseId }, false);
      })();
      return stopping;
    },
  };
}
