import { describe, expect, it, vi } from "vitest";
import type { UsageQuotaSnapshot } from "../../core/types";
import { QuotaService, type QuotaCacheRecord, type QuotaServiceDependencies } from "./quota-service";

const NOW = Date.parse("2026-07-23T08:00:00.000Z");

function snapshot(kind: "fresh" | "transient" | "auth"): UsageQuotaSnapshot {
  const failed = kind !== "fresh";
  return {
    generatedAt: new Date(NOW).toISOString(),
    providers: [
      {
        provider: "codex",
        displayName: "Codex",
        status: failed ? "error" : "supported",
        quotas: failed
          ? []
          : [{ key: "five_hour", label: "5h", usedPercent: 20, remainingPercent: 80, usedDisplay: "20%", remainingDisplay: "80%" }],
        detail: failed ? "refresh failed" : undefined,
        errorKind: kind === "transient" ? "transient" : kind === "auth" ? "auth" : undefined,
      },
    ],
  };
}

function createService(overrides: Partial<QuotaServiceDependencies> = {}) {
  const dependencies: QuotaServiceDependencies = {
    load: vi.fn(async () => snapshot("fresh")),
    getSettings: () => ({ hideCodexQuota: false, hideClaudeQuota: false }),
    authPath: () => "/tmp/auth.json",
    identity: vi.fn(async () => "account-a"),
    readCache: vi.fn(async () => null),
    writeCache: vi.fn(async () => undefined),
    publish: vi.fn(),
    delay: vi.fn(async () => undefined),
    now: () => NOW,
    watch: vi.fn(() => () => undefined),
    ...overrides,
  };
  return { service: new QuotaService(dependencies), dependencies };
}

describe("QuotaService", () => {
  it("retries transient card failures twice and publishes the successful snapshot", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(snapshot("transient"))
      .mockResolvedValueOnce(snapshot("transient"))
      .mockResolvedValueOnce(snapshot("fresh"));
    const { service, dependencies } = createService({ load });

    await expect(service.getSnapshot(true)).resolves.toMatchObject({
      freshness: "fresh",
      lastSuccessfulAt: new Date(NOW).toISOString(),
    });
    expect(load).toHaveBeenCalledTimes(3);
    expect(dependencies.delay).toHaveBeenCalledTimes(2);
    expect(dependencies.publish).toHaveBeenCalledOnce();
  });

  it("returns same-account cache when all transient attempts fail", async () => {
    const cached: QuotaCacheRecord = {
      schemaVersion: 1,
      identity: "account-a",
      savedAt: NOW - 60_000,
      snapshot: { ...snapshot("fresh"), lastSuccessfulAt: new Date(NOW - 60_000).toISOString() },
    };
    const { service } = createService({
      readCache: vi.fn(async () => cached),
      load: vi.fn(async () => snapshot("transient")),
    });

    await expect(service.getSnapshot(true)).resolves.toMatchObject({
      freshness: "stale",
      lastSuccessfulAt: new Date(NOW - 60_000).toISOString(),
      error: "refresh failed",
    });
  });

  it("does not expose another account cache", async () => {
    const cached: QuotaCacheRecord = {
      schemaVersion: 1,
      identity: "account-a",
      savedAt: NOW - 60_000,
      snapshot: snapshot("fresh"),
    };
    const { service } = createService({
      identity: vi.fn(async () => "account-b"),
      readCache: vi.fn(async () => cached),
      load: vi.fn(async () => snapshot("transient")),
    });

    await expect(service.getSnapshot(true)).resolves.toMatchObject({
      freshness: "unavailable",
      error: "refresh failed",
    });
  });

  it("does not retry an expired login", async () => {
    const load = vi.fn(async () => snapshot("auth"));
    const { service } = createService({ load });

    await expect(service.getSnapshot(true)).resolves.toMatchObject({ freshness: "auth-required" });
    expect(load).toHaveBeenCalledOnce();
  });

  it("refreshes after a debounced auth file change and disposes the watcher", async () => {
    vi.useFakeTimers();
    try {
      let changed: (() => void) | undefined;
      const dispose = vi.fn();
      const { service, dependencies } = createService({
        watch: vi.fn((_path, callback) => {
          changed = callback;
          return dispose;
        }),
      });
      service.start();
      changed?.();
      changed?.();
      await vi.advanceTimersByTimeAsync(500);

      expect(dependencies.load).toHaveBeenCalledOnce();
      service.stop();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
