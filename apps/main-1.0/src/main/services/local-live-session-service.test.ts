import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalLiveSessionService } from "./local-live-session-service";

const roots: string[] = [];
const services: LocalLiveSessionService[] = [];

function workerScript(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-live-service-"));
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
  it("keeps one worker alive and pairs concurrent responses by request ID", async () => {
    const service = serviceFor(`
      import { parentPort, threadId } from "node:worker_threads";
      parentPort.on("message", (request) => {
        const key = request.options.homeDir || "";
        const delay = key === "slow" ? 30 : 0;
        setTimeout(() => parentPort.postMessage({
          type: "result",
          requestId: request.requestId,
          result: {
            generatedAt: String(threadId),
            sessions: [{ family: "codex", rawId: key, pid: request.requestId }],
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
    expect(slowSnapshot.sessions[0]?.rawId).toBe("slow");
    expect(fastSnapshot.sessions[0]?.rawId).toBe("fast");
    expect(slowSnapshot.generatedAt).toBe(fastSnapshot.generatedAt);
  });

  it("restarts after an unexpected worker exit", async () => {
    const service = serviceFor(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", (request) => {
        if (request.options.homeDir === "crash") throw new Error("live worker crashed");
        parentPort.postMessage({
          type: "result",
          requestId: request.requestId,
          result: { generatedAt: "restarted", sessions: [] },
        });
      });
    `);

    await expect(service.load({ homeDir: "crash" })).rejects.toThrow("live worker crashed");
    await expect(service.load({ homeDir: "healthy" })).resolves.toMatchObject({
      generatedAt: "restarted",
      sessions: [],
    });
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

  it("keeps the main thread heartbeat responsive during blocking worker work", async () => {
    const service = serviceFor(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", (request) => {
        if (request.options.homeDir !== "warmup") {
          const end = Date.now() + 180;
          while (Date.now() < end) {}
        }
        parentPort.postMessage({
          type: "result",
          requestId: request.requestId,
          result: { generatedAt: "done", sessions: [] },
        });
      });
    `);
    await service.load({ homeDir: "warmup" });

    let heartbeats = 0;
    let settled = false;
    const timer = setInterval(() => {
      heartbeats += 1;
    }, 5);
    const pending = service.load({ homeDir: "blocking" }).finally(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      expect(heartbeats).toBeGreaterThan(2);
      await expect(pending).resolves.toMatchObject({ generatedAt: "done" });
    } finally {
      clearInterval(timer);
    }
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
