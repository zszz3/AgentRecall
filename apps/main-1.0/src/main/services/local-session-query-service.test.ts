import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSessionQueryService } from "./local-session-query-service";

const roots: string[] = [];
const services: LocalSessionQueryService[] = [];

function workerScript(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-query-service-"));
  roots.push(root);
  const workerPath = path.join(root, "worker.mjs");
  fs.writeFileSync(workerPath, source);
  return workerPath;
}

function serviceFor(source: string): LocalSessionQueryService {
  const workerPath = workerScript(source);
  const service = new LocalSessionQueryService(workerPath, {
    dbPath: path.join(path.dirname(workerPath), "unused.sqlite"),
    codexHome: path.join(path.dirname(workerPath), "codex-home"),
  });
  services.push(service);
  return service;
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LocalSessionQueryService", () => {
  it("keeps one worker alive and pairs concurrent out-of-order responses by request ID", async () => {
    const service = serviceFor(`
      import { parentPort, threadId } from "node:worker_threads";
      parentPort.on("message", (request) => {
        const key = request.options.projectPath || "";
        const delay = key === "slow" ? 30 : 0;
        setTimeout(() => parentPort.postMessage({
          type: "result",
          requestId: request.requestId,
          result: [key + ":" + threadId],
        }), delay);
      });
    `);
    const completionOrder: string[] = [];
    const slow = service.listTags({ projectPath: "slow" }).then((result) => {
      completionOrder.push("slow");
      return result;
    });
    const fast = service.listTags({ projectPath: "fast" }).then((result) => {
      completionOrder.push("fast");
      return result;
    });

    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    expect(completionOrder).toEqual(["fast", "slow"]);
    expect(slowResult[0]?.split(":")[0]).toBe("slow");
    expect(fastResult[0]?.split(":")[0]).toBe("fast");
    expect(slowResult[0]?.split(":")[1]).toBe(fastResult[0]?.split(":")[1]);
  });

  it("propagates serialized query errors without killing the worker", async () => {
    const service = serviceFor(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", (request) => {
        if (request.options.projectPath === "bad") {
          parentPort.postMessage({
            type: "error",
            requestId: request.requestId,
            error: { name: "QueryFailure", message: "query boom", stack: "worker stack" },
          });
          return;
        }
        parentPort.postMessage({ type: "result", requestId: request.requestId, result: ["ok"] });
      });
    `);

    const failure = service.listTags({ projectPath: "bad" });
    await expect(failure).rejects.toMatchObject({ name: "QueryFailure", message: "query boom" });
    await expect(service.listTags()).resolves.toEqual(["ok"]);
  });

  it("rejects every pending request when the worker crashes", async () => {
    const service = serviceFor(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", () => {
        throw new Error("worker crashed");
      });
    `);

    const first = service.listTags({ projectPath: "first" });
    const second = service.listTags({ projectPath: "second" });

    await expect(first).rejects.toThrow("worker crashed");
    await expect(second).rejects.toThrow("worker crashed");
  });

  it("terminates the crashed worker so its thread is reclaimed", async () => {
    const service = serviceFor(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", () => {
        throw new Error("worker crashed");
      });
    `);

    const terminateSpy = vi.spyOn(Worker.prototype, "terminate");
    try {
      await expect(service.listTags({ projectPath: "boom" })).rejects.toThrow("worker crashed");
      expect(terminateSpy).toHaveBeenCalled();
    } finally {
      terminateSpy.mockRestore();
    }
  });

  it("returns a rejected promise when the worker cannot be started", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-query-service-missing-"));
    roots.push(root);
    const service = new LocalSessionQueryService(path.join(root, "missing-worker.mjs"), {
      dbPath: path.join(root, "unused.sqlite"),
      codexHome: path.join(root, "codex-home"),
    });
    services.push(service);

    await expect(service.listTags()).rejects.toThrow();
  });

  it("rejects pending and future requests when stopped", async () => {
    const service = serviceFor(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", () => undefined);
      setInterval(() => undefined, 1_000);
    `);
    const pending = service.listTags();

    service.stop();

    await expect(pending).rejects.toThrow("worker stopped");
    await expect(service.listTags()).rejects.toThrow("has stopped");
  });
});
