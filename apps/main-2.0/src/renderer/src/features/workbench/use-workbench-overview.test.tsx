// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionStats } from "../../../../core/types";
import { useWorkbenchOverview } from "./use-workbench-overview";

const stats: SessionStats = { total: { sessionCount: 7, messageCount: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }, bySource: [], dailyTokenUsage: [], previousTotal: null, range: { period: "today", since: null, until: 0 } };
let root: Root, host: HTMLDivElement;
let current: ReturnType<typeof useWorkbenchOverview>;
const api = { getStats: vi.fn(async () => stats), getQuotas: vi.fn(async () => ({ generatedAt: "", providers: [] })), getLiveSessions: vi.fn(async () => ({ generatedAt: "", sessions: [] })), searchSessionPage: vi.fn(async () => ({ sessions: [], totalCount: 0, hasMore: false })), onQuotaUpdated: vi.fn(() => vi.fn()) };
function Harness({ active }: { active: boolean }) { current = useWorkbenchOverview("zh", active); return null; }
async function render(active: boolean) { await act(async () => root.render(<Harness active={active} />)); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  Object.defineProperty(window, "sessionSearch", { value: api, configurable: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("pauses workbench requests off-page while keeping global activity detection and refreshes on return", async () => {
  await render(false); await advance(120_000);
  expect(api.getStats).not.toHaveBeenCalled(); expect(api.getQuotas).not.toHaveBeenCalled(); expect(api.searchSessionPage).not.toHaveBeenCalled();
  expect(api.getLiveSessions).toHaveBeenCalled();
  await render(true); await advance(301);
  expect(api.getStats).toHaveBeenCalledTimes(1); expect(api.getQuotas).toHaveBeenCalledTimes(1); expect(api.searchSessionPage).toHaveBeenCalled();
  const searches = api.searchSessionPage.mock.calls.length, lives = api.getLiveSessions.mock.calls.length;
  await render(false); await advance(120_000);
  await act(async () => { await current.loadStats(); await current.loadSessions(); await current.loadQuotas(); });
  expect(api.getStats).toHaveBeenCalledTimes(1); expect(api.getQuotas).toHaveBeenCalledTimes(1); expect(api.searchSessionPage).toHaveBeenCalledTimes(searches);
  expect(api.getLiveSessions.mock.calls.length).toBeGreaterThan(lives);
  await render(true); await advance(301);
  expect(api.getStats).toHaveBeenCalledTimes(2); expect(api.getQuotas).toHaveBeenCalledTimes(2);
});

it("pauses workbench polling in hidden windows and cleans up listeners and timers", async () => {
  await render(true); await advance(301);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await advance(120_000);
  expect(api.getStats).toHaveBeenCalledTimes(1); expect(api.getQuotas).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  const lives = api.getLiveSessions.mock.calls.length; await advance(120_000);
  expect(api.getLiveSessions).toHaveBeenCalledTimes(lives);
  expect(api.onQuotaUpdated.mock.results[0].value).toHaveBeenCalledOnce();
});

it("shares an in-flight statistics request and ignores a result from before leaving the page", async () => {
  let resolve!: (value: SessionStats) => void;
  api.getStats.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render(true); await advance(1);
  let first!: Promise<void>, second!: Promise<void>;
  await act(async () => { first = current.loadStats(); second = current.loadStats(); });
  expect(api.getStats).toHaveBeenCalledTimes(1);
  await render(false);
  await act(async () => { resolve({ ...stats, total: { ...stats.total, sessionCount: 999 } }); await Promise.all([first, second]); });
  expect(current.stats.total.sessionCount).toBe(0);
  await render(true); await advance(1);
  expect(current.stats.total.sessionCount).toBe(7); expect(api.getStats).toHaveBeenCalledTimes(2);
});

it("starts fresh after a mutation instead of sharing an older query", async () => {
  let resolve!: (value: SessionStats) => void;
  api.getStats.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render(true); await advance(1);
  await act(async () => current.loadStats(true));
  expect(api.getStats).toHaveBeenCalledTimes(2);
  expect(current.stats.total.sessionCount).toBe(7);
  await act(async () => resolve({ ...stats, total: { ...stats.total, sessionCount: 999 } }));
  expect(current.stats.total.sessionCount).toBe(7);
});
