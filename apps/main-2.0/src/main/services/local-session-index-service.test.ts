import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalSessionIndexService } from "./local-session-index-service";

const roots: string[] = [];
const services: LocalSessionIndexService[] = [];
const status = { running: false, indexed: 1, skipped: 0, total: 1, lastIndexedAt: 1, error: null };
const handlers = () => ({ onProgress: vi.fn(), onEnvironmentsChanged: vi.fn() });

function createService(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-index-worker-"));
  roots.push(root);
  const entry = path.join(root, "worker.mjs");
  fs.writeFileSync(entry, source);
  const service = new LocalSessionIndexService(entry, { connectionUrl: "postgres://synthetic", userDataPath: root });
  services.push(service);
  return service;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("keeps main responsive during CPU work, forwards notifications and reuses its worker", async () => {
  const service = createService(`
    import { parentPort, threadId } from "node:worker_threads";
    parentPort.on("message", ({ requestId }) => {
      parentPort.postMessage({ type: "progress", requestId, status: ${JSON.stringify(status)} });
      const until = performance.now() + 250;
      while (performance.now() < until) Math.sqrt(performance.now());
      parentPort.postMessage({ type: "environments-changed", requestId });
      parentPort.postMessage({ type: "result", requestId, status: { ...${JSON.stringify(status)}, total: threadId } });
    });
  `);
  const callbacks = handlers();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const first = service.run({}, false, callbacks);
    await expect(service.run({}, false, handlers())).rejects.toThrow("already running");
    const result = await first;
    expect(ticks).toBeGreaterThan(2);
    expect(callbacks.onProgress).toHaveBeenCalledWith(status);
    expect(callbacks.onEnvironmentsChanged).toHaveBeenCalledOnce();
    expect((await service.run({}, true, handlers())).total).toBe(result.total);
  } finally {
    clearInterval(timer);
  }
});

it("propagates run errors without losing the persistent worker", async () => {
  const service = createService(`
    import { parentPort } from "node:worker_threads";
    let runs = 0;
    parentPort.on("message", ({ requestId }) => parentPort.postMessage(++runs === 1
      ? { type: "error", requestId, error: "synthetic database unavailable" }
      : { type: "result", requestId, status: ${JSON.stringify(status)} }));
  `);
  await expect(service.run({}, false, handlers())).rejects.toThrow("synthetic database unavailable");
  await expect(service.run({}, true, handlers())).resolves.toEqual(status);
});

it("reclaims a crashed worker and permits a later retry", async () => {
  const service = createService(`
    import fs from "node:fs";
    import path from "node:path";
    import { parentPort, workerData } from "node:worker_threads";
    parentPort.on("message", ({ requestId }) => {
      const marker = path.join(workerData.userDataPath, "crashed");
      if (!fs.existsSync(marker)) { fs.writeFileSync(marker, "1"); throw new Error("synthetic crash"); }
      parentPort.postMessage({ type: "result", requestId, status: ${JSON.stringify(status)} });
    });
  `);
  await expect(service.run({}, false, handlers())).rejects.toThrow("synthetic crash");
  await expect(service.run({}, false, handlers())).resolves.toEqual(status);
});

it("waits for termination, rejects the active request and never restarts after stop", async () => {
  const service = createService(`
    import { parentPort } from "node:worker_threads";
    parentPort.on("message", ({ requestId }) => {
      parentPort.postMessage({ type: "progress", requestId, status: ${JSON.stringify(status)} });
      while (true) Math.sqrt(performance.now());
    });
  `);
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const request = service.run({}, false, { ...handlers(), onProgress: ready });
  const rejected = expect(request).rejects.toThrow("stopped");
  await started;
  const stop = service.stop();
  expect(service.stop()).toBe(stop);
  await stop;
  await rejected;
  await expect(service.run({}, false, handlers())).rejects.toThrow("stopped");
});
