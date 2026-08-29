import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalLiveSessionService } from "./local-live-session-service";

const roots: string[] = [];
const services: LocalLiveSessionService[] = [];

function workerScript(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-live-session-service-"));
  roots.push(root);
  const workerPath = path.join(root, "worker.mjs");
  fs.writeFileSync(workerPath, source);
  return workerPath;
}

function serviceFor(source: string): LocalLiveSessionService {
  const service = new LocalLiveSessionService(workerScript(source));
  services.push(service);
  return service;
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LocalLiveSessionService", () => {
  it("keeps one worker alive and pairs concurrent out-of-order snapshots by request ID", async () => {
    const service = serviceFor(`
      import { parentPort, threadId } from "node:worker_threads";
      parentPort.on("message", (request) => {
        const key = request.options.homeDir || "unknown";
        const delay = key === "slow" ? 40 : 0;
        setTimeout(() => parentPort.postMessage({
          type: "result",
          requestId: request.requestId,
          result: {
            generatedAt: key,
            sessions: [{ family: "codex", rawId: key + ":" + threadId, pid: threadId }],
          },
        }), delay);
      });
    `);
    const completionOrder: string[] = [];
    const slow = service.load({ homeDir: "slow" }).then((snapshot) => {
      completionOrder.push("slow");
      return snapshot;
    });
    const fast = service.load({ homeDir: "fast" }).then((snapshot) => {
      completionOrder.push("fast");
      return snapshot;
    });

    const [slowSnapshot, fastSnapshot] = await Promise.all([slow, fast]);
    expect(completionOrder).toEqual(["fast", "slow"]);
    expect(slowSnapshot.generatedAt).toBe("slow");
    expect(fastSnapshot.generatedAt).toBe("fast");
    expect(slowSnapshot.sessions[0]?.rawId.split(":")[1]).toBe(
      fastSnapshot.sessions[0]?.rawId.split(":")[1],
    );
  });

  it("propagates serialized scan errors without killing the persistent worker", async () => {
    const service = serviceFor(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", (request) => {
        if (request.options.homeDir === "bad") {
          parentPort.postMessage({
            type: "error",
            requestId: request.requestId,
            error: { name: "ScanFailure", message: "scan boom", stack: "worker stack" },
          });
          return;
        }
        parentPort.postMessage({
          type: "result",
          requestId: request.requestId,
          result: { generatedAt: "ok", sessions: [] },
        });
      });
    `);

    await expect(service.load({ homeDir: "bad" })).rejects.toMatchObject({
      name: "ScanFailure",
      message: "scan boom",
    });
    await expect(service.load()).resolves.toEqual({ generatedAt: "ok", sessions: [] });
  });

  it("restarts after an unexpected worker crash", async () => {
    const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-live-session-restart-"));
    roots.push(markerRoot);
    const markerPath = path.join(markerRoot, "crashed-once");
    const service = serviceFor(`
      import fs from "node:fs";
      import { parentPort } from "node:worker_threads";
      const markerPath = ${JSON.stringify(markerPath)};
      parentPort.on("message", (request) => {
        if (!fs.existsSync(markerPath)) {
          fs.writeFileSync(markerPath, "1");
          throw new Error("worker crashed once");
        }
        parentPort.postMessage({
          type: "result",
          requestId: request.requestId,
          result: { generatedAt: "restarted", sessions: [] },
        });
      });
    `);

    await expect(service.load()).rejects.toThrow("worker crashed once");
    await expect(service.load()).resolves.toEqual({ generatedAt: "restarted", sessions: [] });
  });

  it("terminates the crashed worker so its thread is reclaimed", async () => {
    const service = serviceFor(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", () => {
        throw new Error("live worker crashed");
      });
    `);

    const terminateSpy = vi.spyOn(Worker.prototype, "terminate");
    try {
      await expect(service.load({ homeDir: "boom" })).rejects.toThrow("live worker crashed");
      expect(terminateSpy).toHaveBeenCalled();
    } finally {
      terminateSpy.mockRestore();
    }
  });

  it("keeps the main-thread heartbeat running during a blocking scan", async () => {
    const service = serviceFor(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", (request) => {
        const deadline = Date.now() + 150;
        while (Date.now() < deadline) {}
        parentPort.postMessage({
          type: "result",
          requestId: request.requestId,
          result: { generatedAt: "done", sessions: [] },
        });
      });
    `);
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
      heartbeats += 1;
    }, 5);

    try {
      await expect(service.load()).resolves.toEqual({ generatedAt: "done", sessions: [] });
    } finally {
      clearInterval(heartbeat);
    }

    expect(heartbeats).toBeGreaterThan(5);
  });

  it("rejects pending and future loads when stopped", async () => {
    const service = serviceFor(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", () => undefined);
      setInterval(() => undefined, 1_000);
    `);
    const pending = service.load();

    service.stop();

    await expect(pending).rejects.toThrow("worker stopped");
    await expect(service.load()).rejects.toThrow("has stopped");
  });
});
