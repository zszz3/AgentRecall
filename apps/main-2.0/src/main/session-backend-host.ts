import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import lockfile from "proper-lockfile";
import type { IndexStatus } from "../core/indexer";
import { redactPostgresConnectionText } from "../core/postgres/database";
import { AUTO_INDEX_REFRESH_INTERVAL_MS } from "../core/refresh-policy";

export interface SessionBackend {
  connectionUrl: string;
  refresh(retryFailures?: boolean): Promise<IndexStatus>;
  status(): IndexStatus;
  search(input: unknown): Promise<unknown>;
  get(input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

interface SessionBackendHostOptions {
  userDataPath: string;
  packagePath: string;
  appVersion: string;
  createBackend(): Promise<SessionBackend>;
  leaseTimeoutMs?: number;
}

const MAX_BODY_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const HOST = "127.0.0.1";

export class SessionBackendRequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      finish(new SessionBackendRequestError(408, "Request body was not received within 30 seconds."));
      request.resume();
    }, 30_000);
    timer.unref();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAbort);
      request.off("error", onError);
      if (error) reject(error);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        finish(new SessionBackendRequestError(413, "Request body exceeds 32 KiB."));
        request.resume();
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      finish();
      try {
        resolve(bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new SessionBackendRequestError(400, "Request body must be valid JSON."));
      }
    };
    const onAbort = () => finish(new SessionBackendRequestError(400, "Request was interrupted."));
    const onError = () => finish(new SessionBackendRequestError(400, "Request could not be read."));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAbort);
    request.once("error", onError);
  });
}

function recordBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SessionBackendRequestError(400, "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function respond(response: ServerResponse, status: number, result: unknown): void {
  let body = JSON.stringify(result);
  if (body === undefined || Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    status = 413;
    body = JSON.stringify({ error: "Response exceeds 1 MiB; narrow the request." });
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Connection": "close",
  });
  response.end(body);
}

/** Owns the database creator lock until requests and backend shutdown have completed. */
export async function startSessionBackendHost(options: SessionBackendHostOptions): Promise<{
  stop(): Promise<void>;
  closed: Promise<void>;
  port: number;
}> {
  const leaseTimeoutMs = options.leaseTimeoutMs ?? 90_000;
  if (!Number.isFinite(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
    throw new Error("Backend timeouts must be finite and positive.");
  }
  await fs.mkdir(options.userDataPath, { recursive: true, mode: 0o700 });
  let lockCompromised = false;
  let stopAfterLockLoss: (() => void) | undefined;
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await lockfile.lock(path.join(options.userDataPath, "session-backend-owner"), {
      realpath: false,
      retries: 0,
      onCompromised: () => {
        lockCompromised = true;
        stopAfterLockLoss?.();
      },
    });
  } catch {
    throw new Error("Session backend is already owned by another process or its owner lock is unavailable.");
  }

  const token = randomBytes(32).toString("hex");
  const discoveryPath = path.join(options.userDataPath, "session-backend.json");
  const tempPath = `${discoveryPath}.${token}.tmp`;
  const leases = new Map<string, number>();
  let backend: SessionBackend | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let inFlight = 0;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const drained = new Set<() => void>();
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const reportFailure = (operation: string, error: unknown) => {
    let detail = error instanceof Error ? error.message : String(error);
    detail = detail.split(token).join("[redacted]");
    for (const leaseId of leases.keys()) detail = detail.split(leaseId).join("[redacted]");
    if (backend?.connectionUrl) detail = detail.split(backend.connectionUrl).join("[redacted PostgreSQL URL]");
    detail = redactPostgresConnectionText(detail).replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/giu, "[redacted PostgreSQL URL]");
    console.error(`[session-backend] ${operation}: ${detail.slice(0, 2000)}`);
  };

  const activeLeases = () => {
    const now = Date.now();
    for (const [lease, expires] of leases) if (expires <= now) leases.delete(lease);
    return leases.size;
  };

  const server = createServer((request, response) => {
    const remote = request.socket.remoteAddress;
    if (remote !== HOST && remote !== "::ffff:127.0.0.1") {
      respond(response, 403, { error: "Local clients only." });
      return;
    }
    if (!authorized(request, token)) {
      respond(response, 401, { error: "Authentication required." });
      return;
    }
    if (request.method !== "POST") {
      respond(response, 405, { error: "POST is required." });
      return;
    }
    if (stopping || lockCompromised) {
      respond(response, 503, { error: "Session backend is stopping." });
      return;
    }
    inFlight++;
    void (async () => {
      let stopRequested = false;
      try {
        const body = await readBody(request);
        const service = backend!;
        let result: unknown;
        switch (request.url) {
          case "/session/status":
            result = {
              running: true, pid: process.pid, protocolVersion: 1,
              appVersion: options.appVersion, indexStatus: service.status(), desktopClients: activeLeases(),
              lifecycle: "persistent", backgroundRefreshIntervalMs: AUTO_INDEX_REFRESH_INTERVAL_MS,
            };
            break;
          case "/session/search": result = await service.search(body); break;
          case "/session/get": result = await service.get(body); break;
          case "/session/refresh": {
            const input = recordBody(body);
            if (input.retryFailures !== undefined && typeof input.retryFailures !== "boolean") {
              throw new SessionBackendRequestError(400, "retryFailures must be a boolean.");
            }
            result = await service.refresh(input.retryFailures as boolean | undefined);
            break;
          }
          case "/session/attach": {
            const input = recordBody(body);
            activeLeases();
            if (input.leaseId !== undefined && (typeof input.leaseId !== "string" || !leases.has(input.leaseId))) {
              throw new SessionBackendRequestError(409, "Desktop lease expired or is unknown; attach again without a leaseId.");
            }
            const leaseId = typeof input.leaseId === "string" ? input.leaseId : randomBytes(32).toString("hex");
            leases.set(leaseId, Date.now() + leaseTimeoutMs);
            result = { connectionUrl: service.connectionUrl, leaseId };
            break;
          }
          case "/session/release": {
            const input = recordBody(body);
            activeLeases();
            if (typeof input.leaseId !== "string" || !leases.delete(input.leaseId)) {
              throw new SessionBackendRequestError(409, "Desktop lease expired or is unknown.");
            }
            result = { released: true };
            break;
          }
          case "/session/stop":
            if (activeLeases() || inFlight > 1 || service.status().running) {
              throw new SessionBackendRequestError(409, "Session backend is in use.");
            }
            stopping = true;
            stopRequested = true;
            result = { stopped: true };
            break;
          default: throw new SessionBackendRequestError(404, "Unknown session operation.");
        }
        respond(response, 200, result);
      } catch (error) {
        if (!(error instanceof SessionBackendRequestError)) reportFailure("Request failed", error);
        if (!response.destroyed && !response.headersSent) {
          respond(response, error instanceof SessionBackendRequestError ? error.statusCode : 500, {
            error: error instanceof SessionBackendRequestError ? error.message : "Session operation failed; inspect the local backend log.",
          });
        }
      } finally {
        inFlight--;
        if (inFlight === 0) for (const resolve of drained) resolve();
        // Never await server.close from its own response handler.
        if (stopRequested) setImmediate(() => {
          void stop().catch((error: unknown) => reportFailure("Requested shutdown failed", error));
        });
      }
    })();
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  const removeDiscovery = async () => {
    try {
      const current: unknown = JSON.parse(await fs.readFile(discoveryPath, "utf8"));
      if (current && typeof current === "object" && "token" in current && current.token === token) {
        await fs.unlink(discoveryPath);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    if (refreshTimer) clearInterval(refreshTimer);
    stopPromise = (async () => {
      let cleanupFailed = false;
      const clean = async (operation: string, action: () => Promise<unknown>) => {
        try { await action(); } catch (error) {
          cleanupFailed = true;
          reportFailure(operation, error);
        }
      };
      try {
        const serverClosed = new Promise<void>((resolve) => {
          if (!server.listening) resolve();
          else server.close(() => resolve());
        });
        if (inFlight > 0) await new Promise<void>((resolve) => { drained.add(resolve); });
        await serverClosed;
        await clean("Backend close failed", async () => backend?.close());
      } finally {
        await clean("Temporary discovery cleanup failed", () => fs.rm(tempPath, { force: true }));
        await clean("Discovery cleanup failed", removeDiscovery);
        if (!lockCompromised) await clean("Owner lock release failed", releaseLock);
        resolveClosed();
      }
      if (cleanupFailed) throw new Error("Session backend shutdown failed; inspect the local backend log.");
    })();
    return stopPromise;
  };
  try {
    backend = await options.createBackend();
    if (lockCompromised) throw new Error("Session backend owner lock was lost during startup.");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, HOST, () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Session backend could not bind a local port.");
    await fs.writeFile(tempPath, JSON.stringify({
      protocolVersion: 1, pid: process.pid, host: HOST, port: address.port, token,
      packagePath: options.packagePath, appVersion: options.appVersion,
    }), { mode: 0o600, flag: "wx" });
    await fs.rename(tempPath, discoveryPath);
    if (lockCompromised) throw new Error("Session backend owner lock was lost during startup.");
    stopAfterLockLoss = () => {
      void stop().catch((error: unknown) => reportFailure("Shutdown after losing ownership failed", error));
    };
    // Desktop owns its existing refresh cycle while connected. With no desktop,
    // keep the local index fresh without queueing behind an interactive request.
    refreshTimer = setInterval(() => {
      if (stopping || activeLeases() > 0 || inFlight > 0 || backend!.status().running) return;
      inFlight++;
      void Promise.resolve().then(() => backend!.refresh()).then((status) => {
        if (status.error) reportFailure("Background indexing incomplete", new Error(status.error));
      }).catch((error: unknown) => reportFailure("Background indexing failed", error)).finally(() => {
        inFlight--;
        if (inFlight === 0) for (const resolve of drained) resolve();
      });
    }, AUTO_INDEX_REFRESH_INTERVAL_MS);
    refreshTimer.unref();
    return { stop, closed, port: address.port };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { reportFailure("Startup cleanup failed", cleanupError); }
    throw error;
  }
}
