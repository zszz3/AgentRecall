import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSessionBackendHost, type SessionBackend } from "./session-backend-host";
import { connectDesktopSessionBackend, requestLocalSessionBackend } from "./session-backend-client";
import { readSessionBackendSettings } from "./session-backend-core";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function directory() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "agentrecall-desktop-backend-"));
  cleanups.push(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}
const status = { running: false, indexed: 1, skipped: 0, total: 1, lastIndexedAt: 100, error: null };

describe("desktop session backend lease", () => {
  it("reuses one backend and releases the desktop without interrupting a search", async () => {
    const userDataPath = await directory();
    const packagePath = process.cwd();
    let finish!: (value: unknown) => void;
    const backend: SessionBackend = {
      connectionUrl: "postgresql://fixture:fixture@127.0.0.1:65432/fixture", status: () => status,
      refresh: vi.fn(async () => status), search: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
      get: vi.fn(async () => ({ messages: [] })), close: vi.fn(async () => undefined),
    };
    const host = await startSessionBackendHost({ userDataPath, packagePath, appVersion: "0.1.0", createBackend: async () => backend, idleTimeoutMs: 250 });
    cleanups.push(host.stop);
    const options = { userDataPath, packagePath, homeDir: userDataPath };
    const desktop = await connectDesktopSessionBackend({ ...options, onError: (message) => { throw new Error(message); } });
    expect(desktop.connectionUrl).toBe(backend.connectionUrl);
    await expect(desktop.refresh(false, () => undefined)).resolves.toEqual(status);
    const pending = requestLocalSessionBackend("search", { query: "fixture" }, options);
    await vi.waitFor(() => expect(backend.search).toHaveBeenCalledOnce());
    await desktop.stop();
    await desktop.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(backend.close).not.toHaveBeenCalled();
    finish([{ sessionKey: "codex:fixture" }]);
    await expect(pending).resolves.toEqual([{ sessionKey: "codex:fixture" }]);
    await host.closed;
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("reads persisted source/MCP settings and fails closed on malformed configuration", async () => {
    const userDataPath = await directory();
    await fs.writeFile(path.join(userDataPath, "config.json"), JSON.stringify({ includeDeepSeekCli: true, sessionSearchMcpEnabled: false }));
    await expect(readSessionBackendSettings(userDataPath)).resolves.toMatchObject({ includeDeepSeekCli: true, sessionSearchMcpEnabled: false });
    await fs.writeFile(path.join(userDataPath, "config.json"), "{bad");
    await expect(readSessionBackendSettings(userDataPath)).rejects.toThrow();
    await fs.writeFile(path.join(userDataPath, "config.json"), JSON.stringify({ includeDeepSeekCli: "yes" }));
    await expect(readSessionBackendSettings(userDataPath)).rejects.toThrow(/布尔值/);
  });
});
