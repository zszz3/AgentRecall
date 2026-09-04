import { afterEach, describe, expect, it, vi } from "vitest";
import { DshSessionDiscovery } from "./dsh-session-discovery";

describe("DshSessionDiscovery", () => {
  afterEach(() => vi.useRealTimers());

  it("reports the only Session created after the owned DSH process starts", async () => {
    vi.useFakeTimers();
    let ids = new Set(["session-existing"]);
    const onSessionId = vi.fn();
    const discovery = new DshSessionDiscovery("/dsh/sessions", onSessionId, {
      readSessionIds: vi.fn(async () => new Set(ids)),
      setInterval,
      clearInterval,
    });

    await discovery.prepare(new AbortController().signal);
    discovery.observe();
    ids = new Set([...ids, "session-created"]);
    await vi.advanceTimersByTimeAsync(100);
    await discovery.finish();

    expect(onSessionId).toHaveBeenCalledOnce();
    expect(onSessionId).toHaveBeenCalledWith("session-created");
  });

  it("does not guess when more than one Session appears in the discovery window", async () => {
    vi.useFakeTimers();
    let ids = new Set<string>();
    const onSessionId = vi.fn();
    const discovery = new DshSessionDiscovery("/dsh/ambiguous", onSessionId, {
      readSessionIds: vi.fn(async () => new Set(ids)),
      setInterval,
      clearInterval,
    });

    await discovery.prepare(new AbortController().signal);
    discovery.observe();
    ids = new Set(["session-one", "session-two"]);
    await vi.advanceTimersByTimeAsync(100);
    await discovery.finish();

    expect(onSessionId).not.toHaveBeenCalled();
  });

  it("does not attribute Sessions when the owned process never entered observation", async () => {
    let ids = new Set<string>();
    const onSessionId = vi.fn();
    const discovery = new DshSessionDiscovery("/dsh/not-started", onSessionId, {
      readSessionIds: vi.fn(async () => new Set(ids)),
      setInterval,
      clearInterval,
    });

    await discovery.prepare(new AbortController().signal);
    ids = new Set(["session-external"]);
    await discovery.finish();

    expect(onSessionId).not.toHaveBeenCalled();
  });

  it("surfaces polling failures during deterministic cleanup", async () => {
    vi.useFakeTimers();
    const readSessionIds = vi.fn()
      .mockResolvedValueOnce(new Set<string>())
      .mockRejectedValueOnce(new Error("read denied"));
    const discovery = new DshSessionDiscovery("/dsh/unreadable", vi.fn(), {
      readSessionIds,
      setInterval,
      clearInterval,
    });

    await discovery.prepare(new AbortController().signal);
    discovery.observe();
    await vi.advanceTimersByTimeAsync(100);

    await expect(discovery.finish()).rejects.toThrow("read denied");
  });

  it("keeps later discovery queued when an intermediate waiter is cancelled", async () => {
    const dependencies = {
      readSessionIds: vi.fn(async () => new Set<string>()),
      setInterval,
      clearInterval,
    };
    const first = new DshSessionDiscovery("/dsh/serialized", vi.fn(), dependencies);
    const cancelled = new DshSessionDiscovery("/dsh/serialized", vi.fn(), dependencies);
    const last = new DshSessionDiscovery("/dsh/serialized", vi.fn(), dependencies);
    const cancelledController = new AbortController();

    await first.prepare(new AbortController().signal);
    const cancelledPreparation = cancelled.prepare(cancelledController.signal);
    cancelledController.abort();
    await expect(cancelledPreparation).rejects.toMatchObject({ name: "AbortError" });

    let lastPrepared = false;
    const lastPreparation = last.prepare(new AbortController().signal).then(() => {
      lastPrepared = true;
    });
    await Promise.resolve();
    expect(lastPrepared).toBe(false);

    await first.finish();
    await lastPreparation;
    expect(lastPrepared).toBe(true);
    await last.finish();
  });
});
