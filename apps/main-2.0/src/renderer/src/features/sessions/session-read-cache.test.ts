import { expect, it, vi } from "vitest";
import { SessionReadCache } from "./session-read-cache";

it("shares reads, retries failures, and does not let an invalidated request refill the cache", async () => {
  const cache = new SessionReadCache<string>(2, 1024, 1000);
  let finish!: (value: string) => void;
  const loader = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const first = cache.read("a", loader);
  expect(cache.read("a", loader)).toBe(first);
  await Promise.resolve();
  expect(loader).toHaveBeenCalledTimes(1);
  cache.clear();
  const fresh = cache.read("a", async () => "new");
  await fresh;
  finish("old"); await first;
  expect(cache.peek("a")).toBe("new");
  await expect(cache.read("b", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(cache.peek("b")).toBeUndefined();
  expect(await cache.read("b", async () => "retry")).toBe("retry");
});

it("evicts by recency, expires reads, and rejects oversized values without truncating the caller's value", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  try {
    const cache = new SessionReadCache<string>(2, 64, 1000);
    await cache.read("a", async () => "中文"); // 20 estimated bytes including the string header
    await cache.read("b", async () => "B");
    expect(cache.peek("a")).toBe("中文");
    await cache.read("c", async () => "C");
    expect(cache.peek("b")).toBeUndefined();
    expect(await cache.read("exact", async () => "中".repeat(24))).toHaveLength(24);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("exact")).toHaveLength(24);
    expect(await cache.read("large", async () => "中".repeat(25))).toHaveLength(25);
    expect(cache.peek("large")).toBeUndefined();
    now.mockReturnValue(1100);
    expect(cache.peek("exact")).toBeUndefined();
    expect(await cache.read("empty", async () => "")).toBe("");
    expect(cache.peek("empty")).toBe("");
  } finally { now.mockRestore(); }
});
