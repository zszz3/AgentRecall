import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TeamSessionDownloads } from "./team-session-downloads";
const queues: TeamSessionDownloads[] = [];
afterEach(async () => { await Promise.all(queues.splice(0).map(queue => queue.close())); });
const item = (id = 1) => ({ context: { repository: "https://github.com/example/assets", projectIdentity: "team:shared", teamWide: true, projectId: "", root: null }, id, digest: "a".repeat(64) });
it("owns a bounded sequential queue, deduplicates requests and exposes indexing and completion", async () => {
  let finish!: () => void, indexing!: () => void;
  const run = vi.fn(async (_input, signal: AbortSignal, progress: () => void) => {
    indexing = progress;
    await new Promise<void>((resolve, reject) => { finish = resolve; signal.addEventListener("abort", () => reject(new Error("cancel")), { once: true }); });
  });
  const queue = new TeamSessionDownloads(run); queues.push(queue);
  expect(queue.start(item()).phase).toBe("downloading");
  queue.start(item()); expect(queue.start(item(2)).phase).toBe("queued"); expect(run).toHaveBeenCalledTimes(1);
  indexing(); expect(queue.status(item())?.phase).toBe("indexing");
  finish(); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(queue.status(item())?.phase).toBe("ready");
  queue.cancel(item(2)); await vi.waitFor(() => expect(queue.status(item(2))?.phase).toBe("cancelled"));
  queue.start(item(2)); expect(run).toHaveBeenCalledTimes(3);
  await queue.pause(); expect(queue.status(item(2))?.phase).toBe("cancelled");
  expect(() => queue.start(item(3))).toThrow(); queue.resume(); queue.start(item(3));
});
it("retains retryable failures and does not report success before the operation finishes", async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error("failure")).mockResolvedValue(undefined);
  const queue = new TeamSessionDownloads(run); queues.push(queue);
  queue.start(item()); await vi.waitFor(() => expect(queue.status(item())?.phase).toBe("failed"));
  queue.start(item()); await vi.waitFor(() => expect(queue.status(item())?.phase).toBe("ready"));
  expect(run).toHaveBeenCalledTimes(2);
});
it("runs worker progress off the caller thread and waits for worker exit on cancellation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "team-download-worker-"));
  const workerPath = path.join(root, "fixture.mjs");
  await fs.writeFile(workerPath, `import {parentPort,workerData} from 'node:worker_threads';
    parentPort.postMessage('indexing');
    if(workerData.id===1) { parentPort.postMessage('ready'); parentPort.close(); }
    else parentPort.on('message',()=>{parentPort.postMessage('failed');parentPort.close();});`);
  const queue = TeamSessionDownloads.worker(workerPath, "postgres://synthetic"); queues.push(queue);
  try {
    queue.start(item()); await vi.waitFor(() => expect(queue.status(item())?.phase).toBe("ready"));
    queue.start(item(2)); await vi.waitFor(() => expect(queue.status(item(2))?.phase).toBe("indexing"));
    await queue.close(); expect(queue.status(item(2))?.phase).toBe("cancelled");
  } finally { await queue.close(); await fs.rm(root, {recursive:true,force:true}); }
});
