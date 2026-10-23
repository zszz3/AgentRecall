import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSessionBackendHost, type SessionBackend } from "./session-backend-host";

const directories: string[] = [];
const hosts: Array<Awaited<ReturnType<typeof startSessionBackendHost>>> = [];

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(overrides: Partial<SessionBackend> = {}) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "agentrecall-backend-host-"));
  directories.push(userDataPath);
  const backend: SessionBackend = {
    connectionUrl: "postgresql://synthetic-secret@localhost/test",
    refresh: vi.fn(async () => backend.status()),
    status: () => ({ running: false, indexed: 1, skipped: 0, total: 1, lastIndexedAt: null, error: null }),
    search: vi.fn(async (input) => ({ input })),
    get: vi.fn(async () => ({ session: "synthetic" })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    backend,
    options: { userDataPath, packagePath: "/synthetic/package", appVersion: "0.0.0-test", createBackend: vi.fn(async () => backend) },
  };
}

async function start(options: Parameters<typeof startSessionBackendHost>[0]) {
  const host = await startSessionBackendHost(options);
  hosts.push(host);
  const discovery = JSON.parse(await fs.readFile(path.join(options.userDataPath, "session-backend.json"), "utf8")) as { token: string };
  return {
    ...host,
    token: discovery.token,
    call(operation: string, input: unknown = {}, extra: { token?: string; method?: string; raw?: string } = {}) {
      return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const request = httpRequest({
          host: "127.0.0.1", port: host.port, path: `/session/${operation}`,
          method: extra.method ?? "POST",
          headers: { authorization: `Bearer ${extra.token ?? discovery.token}`, "content-type": "application/json" },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
            catch (error) { reject(error); }
          });
        });
        request.on("error", reject);
        request.end(extra.raw ?? JSON.stringify(input));
      });
    },
  };
}

describe("session backend host", () => {
  it("holds one creator lock throughout startup and serving, then releases ownership", async () => {
    const { options, backend } = await fixture();
    const gate = deferred<SessionBackend>();
    const creating = vi.fn(() => gate.promise);
    const first = start({ ...options, createBackend: creating });
    await vi.waitFor(() => expect(creating).toHaveBeenCalledOnce());
    await expect(startSessionBackendHost(options)).rejects.toThrow("already owned");
    expect(options.createBackend).not.toHaveBeenCalled();
    gate.resolve(backend);
    const host = await first;
    await expect(startSessionBackendHost(options)).rejects.toThrow("already owned");
    if (process.platform !== "win32") {
      const stat = await fs.stat(path.join(options.userDataPath, "session-backend.json"));
      expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(host.token).toMatch(/^[a-f0-9]{64}$/);
    await host.stop();
    const replacement = await start(options);
    expect((await replacement.call("status")).status).toBe(200);
  });

  it("authenticates and bounds HTTP input/output without exposing backend errors", async () => {
    const { options, backend } = await fixture();
    const host = await start(options);
    expect((await host.call("status", {}, { token: "bad" })).status).toBe(401);
    expect((await host.call("status", {}, { method: "GET" })).status).toBe(405);
    expect((await host.call("unknown")).status).toBe(404);
    expect((await host.call("search", {}, { raw: "{" })).status).toBe(400);
    expect((await host.call("search", {}, { raw: JSON.stringify("x".repeat(33 * 1024)) })).status).toBe(413);
    expect(backend.search).not.toHaveBeenCalled();
    expect((await host.call("refresh", { retryFailures: "yes" })).status).toBe(400);
    await host.call("refresh", { retryFailures: true });
    expect(backend.refresh).toHaveBeenCalledWith(true);
    const result = await host.call("search", { query: "synthetic" });
    expect(result).toEqual({ status: 200, body: { input: { query: "synthetic" } } });
    vi.mocked(backend.get).mockResolvedValueOnce({ content: "x".repeat(1024 * 1024) });
    expect((await host.call("get")).status).toBe(413);
    vi.mocked(backend.search).mockRejectedValueOnce(new Error(backend.connectionUrl));
    const error = await host.call("search");
    expect(error.status).toBe(500);
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toContain("synthetic-secret");
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toContain("postgresql://");
  });

  it("leases protect desktop use, renew only existing leases, and release without stopping", async () => {
    const { options, backend } = await fixture();
    const host = await start({ ...options, idleTimeoutMs: 40, leaseTimeoutMs: 250 });
    const attached = await host.call("attach");
    expect(attached.body.connectionUrl).toBe(backend.connectionUrl);
    const leaseId = attached.body.leaseId;
    expect((await host.call("attach", { leaseId: "forged" })).status).toBe(409);
    expect((await host.call("release", { leaseId: "forged" })).status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 65));
    expect((await host.call("status")).body.desktopClients).toBe(1);
    expect((await host.call("stop")).status).toBe(409);
    expect((await host.call("attach", { leaseId })).body.leaseId).toBe(leaseId);
    expect((await host.call("release", { leaseId })).status).toBe(200);
    expect(backend.close).not.toHaveBeenCalled();
    expect((await host.call("status")).body.desktopClients).toBe(0);
    await host.closed;
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("expires an abandoned desktop lease and stops the endpoint when idle", async () => {
    const { options, backend } = await fixture();
    const host = await start({ ...options, idleTimeoutMs: 25, leaseTimeoutMs: 60 });
    await host.call("attach");
    await host.closed;
    expect(backend.close).toHaveBeenCalledOnce();
    await expect(host.call("status")).rejects.toThrow();
    await expect(fs.access(path.join(options.userDataPath, "session-backend.json"))).rejects.toThrow();
  });

  it("keeps active requests alive past idle and rejects stop until they settle", async () => {
    const gate = deferred<unknown>();
    const { options, backend } = await fixture({ search: vi.fn(() => gate.promise) });
    const host = await start({ ...options, idleTimeoutMs: 35 });
    const pending = host.call("search");
    await vi.waitFor(() => expect(backend.search).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(backend.close).not.toHaveBeenCalled();
    expect((await host.call("stop")).status).toBe(409);
    gate.resolve({ found: true });
    expect((await pending).body).toEqual({ found: true });
    await host.closed;
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("direct stop waits for requests and is idempotent", async () => {
    const gate = deferred<unknown>();
    const { options, backend } = await fixture({ get: vi.fn(() => gate.promise) });
    const host = await start(options);
    const pending = host.call("get");
    await vi.waitFor(() => expect(backend.get).toHaveBeenCalledOnce());
    const first = host.stop();
    expect(host.stop()).toBe(first);
    expect(backend.close).not.toHaveBeenCalled();
    gate.resolve({ found: true });
    expect((await pending).status).toBe(200);
    await first;
    await host.closed;
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("HTTP stop responds before closing and does not deadlock on its own request", async () => {
    const { options, backend } = await fixture();
    const host = await start(options);
    expect(await host.call("stop")).toEqual({ status: 200, body: { stopped: true } });
    await host.closed;
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("startup failure releases the lock and does not remove discovery owned by another token", async () => {
    const { options } = await fixture();
    const discoveryPath = path.join(options.userDataPath, "session-backend.json");
    await fs.writeFile(discoveryPath, JSON.stringify({ token: "other-owner" }));
    await expect(startSessionBackendHost({ ...options, createBackend: async () => { throw new Error("synthetic failure"); } }))
      .rejects.toThrow("synthetic failure");
    expect(JSON.parse(await fs.readFile(discoveryPath, "utf8"))).toEqual({ token: "other-owner" });
    const host = await start(options);
    expect((await host.call("status")).status).toBe(200);
  });

  it("closes a created backend if publishing discovery fails", async () => {
    const { options, backend } = await fixture();
    vi.mocked(backend.close).mockRejectedValueOnce(new Error(`Synthetic close failure: ${backend.connectionUrl}`));
    await fs.mkdir(path.join(options.userDataPath, "session-backend.json"));
    await expect(startSessionBackendHost(options)).rejects.toThrow();
    expect(backend.close).toHaveBeenCalledOnce();
    const diagnostics = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(diagnostics).toContain("Backend close failed");
    expect(diagnostics).toContain("Discovery cleanup failed");
    expect(diagnostics).toContain("Startup cleanup failed");
    expect(diagnostics).not.toContain("synthetic-secret");
    expect(diagnostics).not.toContain("postgresql://");
    await fs.rm(path.join(options.userDataPath, "session-backend.json"), { recursive: true });
    const host = await start(options);
    expect((await host.call("status")).status).toBe(200);
  });

  it("times out an incomplete authenticated body so it cannot hold the backend indefinitely", async () => {
    const { options, backend } = await fixture();
    const host = await start(options);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldClearNativeTimers: true });
    const pending = new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1", port: host.port, path: "/session/search", method: "POST",
        headers: { authorization: `Bearer ${host.token}`, "content-length": "100" },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
      });
      request.on("error", reject);
      request.write("{");
    });
    await host.call("status");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(408);
    expect(backend.search).not.toHaveBeenCalled();
    await host.stop();
    vi.useRealTimers();
  });
});
