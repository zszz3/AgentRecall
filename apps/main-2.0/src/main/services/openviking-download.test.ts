import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { net } from "electron";

import { downloadFileWithResume } from "./openviking-download";

vi.mock("electron", () => ({ net: { fetch: vi.fn((url: string, init: RequestInit) => fetch(url, init)) } }));

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-download-"));
  roots.push(value);
  return value;
}

interface ServeOptions {
  body: string;
  /** Replies 200 with the whole body even when a range was requested. */
  ignoreRange?: boolean;
  status?: number;
  interruptFirst?: boolean;
}

async function serve(options: ServeOptions): Promise<{
  url: string;
  ranges: Array<string | undefined>;
}> {
  const ranges: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    ranges.push(request.headers.range);
    if (options.status && options.status !== 200) {
      response.writeHead(options.status).end();
      return;
    }
    const range = options.ignoreRange ? undefined : request.headers.range;
    const offset = range ? Number(/^bytes=(\d+)-/u.exec(range)?.[1] ?? 0) : 0;
    const chunk = options.body.slice(offset);
    response.writeHead(range ? 206 : 200, {
      "content-length": String(Buffer.byteLength(chunk)),
      ...(range
        ? { "content-range": `bytes ${offset}-${options.body.length - 1}/${options.body.length}` }
        : {}),
    });
    if (options.interruptFirst && ranges.length === 1) {
      response.write(chunk.slice(0, 8));
      setTimeout(() => response.destroy(), 30);
      return;
    }
    response.end(chunk);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/artifact`, ranges };
}

describe("downloadFileWithResume", () => {
  it("downloads a fresh artifact without asking for a range", async () => {
    const destination = path.join(await root(), "artifact");
    const { url, ranges } = await serve({ body: "runtime archive" });

    await downloadFileWithResume(url, destination);

    await expect(readFile(destination, "utf8")).resolves.toBe("runtime archive");
    expect(ranges).toEqual([undefined]);
    expect(net.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("resumes a partial file through a range request", async () => {
    const destination = path.join(await root(), "artifact");
    await writeFile(destination, "runtime ");
    const { url, ranges } = await serve({ body: "runtime archive" });

    await downloadFileWithResume(url, destination);

    await expect(readFile(destination, "utf8")).resolves.toBe("runtime archive");
    expect(ranges).toEqual(["bytes=8-"]);
  });

  it("reports progress that counts the resumed bytes toward the artifact total", async () => {
    const destination = path.join(await root(), "artifact");
    await writeFile(destination, "runtime ");
    const { url } = await serve({ body: "runtime archive" });
    const progress: Array<{ downloadedBytes: number; totalBytes?: number }> = [];

    await downloadFileWithResume(url, destination, (downloadedBytes, totalBytes) => {
      progress.push({ downloadedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) });
    });

    expect(progress[0]).toEqual({ downloadedBytes: 8, totalBytes: 15 });
    expect(progress.at(-1)).toEqual({ downloadedBytes: 15, totalBytes: 15 });
  });

  it("overwrites the partial file when the server ignores the range header", async () => {
    const destination = path.join(await root(), "artifact");
    await writeFile(destination, "stale bytes that must not survive");
    const { url } = await serve({ body: "runtime archive", ignoreRange: true });

    await downloadFileWithResume(url, destination);

    await expect(readFile(destination, "utf8")).resolves.toBe("runtime archive");
  });

  it("treats an unsatisfiable range as a complete transfer for the caller to checksum", async () => {
    const destination = path.join(await root(), "artifact");
    await writeFile(destination, "already complete");
    const { url } = await serve({ body: "runtime archive", status: 416 });

    await downloadFileWithResume(url, destination);

    await expect(readFile(destination, "utf8")).resolves.toBe("already complete");
  });

  it("surfaces a failing status code", async () => {
    const destination = path.join(await root(), "artifact");
    const { url } = await serve({ body: "runtime archive", status: 503 });

    await expect(downloadFileWithResume(url, destination, undefined, { retryDelayMs: 1 })).rejects.toThrow("HTTP 503");
  });

  it("automatically resumes bytes written before a connection drops", async () => {
    const destination = path.join(await root(), "artifact");
    const { url, ranges } = await serve({ body: "runtime archive", interruptFirst: true });
    await downloadFileWithResume(url, destination, undefined, { retryDelayMs: 1 });
    expect(ranges).toEqual([undefined, "bytes=8-"]);
    await expect(readFile(destination, "utf8")).resolves.toBe("runtime archive");
  });

  it("bounds retries of stalled streams and preserves already downloaded bytes", async () => {
    const destination = path.join(await root(), "artifact");
    await writeFile(destination, "runtime ");
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return new Response(new ReadableStream({}), {
        status: 206, headers: { "content-range": "bytes 8-14/15", "content-length": "7" },
      });
    });
    await expect(downloadFileWithResume("https://synthetic.example/artifact", destination, undefined, {
      fetchImpl, idleTimeoutMs: 20, retryDelayMs: 1,
    })).rejects.toThrow("stalled");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await expect(readFile(destination, "utf8")).resolves.toBe("runtime ");
  });

  it("allows slow healthy transfers to outlive a single idle timeout", async () => {
    const destination = path.join(await root(), "artifact");
    const timers: ReturnType<typeof setTimeout>[] = [];
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i += 1) timers.push(setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("a"));
          if (i === 4) controller.close();
        }, i * 20));
      },
      cancel() { timers.forEach(clearTimeout); },
    }), { headers: { "content-length": "5" } }));
    await downloadFileWithResume("https://synthetic.example/artifact", destination, undefined, {
      fetchImpl, idleTimeoutMs: 60, retryDelayMs: 1,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(readFile(destination, "utf8")).resolves.toBe("aaaaa");
  });

  it("does not retry permanent HTTP errors or append a mismatched range", async () => {
    const destination = path.join(await root(), "artifact");
    const { url, ranges } = await serve({ body: "runtime archive", status: 403 });
    await expect(downloadFileWithResume(url, destination)).rejects.toThrow("HTTP 403");
    expect(ranges).toHaveLength(1);
    await writeFile(destination, "runtime ");
    const fetchImpl = vi.fn(async () => new Response("wrong", {
      status: 206, headers: { "content-range": "bytes 0-4/15" },
    }));
    await expect(downloadFileWithResume("https://synthetic.example/artifact", destination, undefined, {
      fetchImpl,
    })).rejects.toThrow("invalid resume range");
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(readFile(destination, "utf8")).resolves.toBe("runtime ");
  });

  it("copies a local development artifact", async () => {
    const directory = await root();
    const source = path.join(directory, "source");
    const destination = path.join(directory, "artifact");
    await writeFile(source, "development runtime");

    await downloadFileWithResume(pathToFileURL(source).href, destination);

    await expect(readFile(destination, "utf8")).resolves.toBe("development runtime");
  });
});
