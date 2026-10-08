// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { SessionSearchResult, SessionTurnSummary } from "../../../../core/types";
import { useSessionDetail } from "./use-session-detail";

it("paints cached turns immediately, revalidates, shares turn reads and isolates changed sessions", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const session = { sessionKey: "codex:a", fileMtimeMs: 1, fileSize: 10 } as SessionSearchResult;
  const turns = [{ id: "turn-a" }] as SessionTurnSummary[];
  const api = { getSession: vi.fn().mockResolvedValue(session), listSessionTurns: vi.fn().mockResolvedValue(turns), getSessionTurn: vi.fn().mockResolvedValue({ id: "turn-a" }) };
  Object.defineProperty(window, "sessionSearch", { configurable: true, value: api });
  const error = vi.fn();
  let hook!: ReturnType<typeof useSessionDetail>;
  const container = document.createElement("div");
  const root = createRoot(container);
  function Harness() { hook = useSessionDetail(error); return createElement("div", null, hook.turnsLoading ? "Loading" : hook.turns.map(t => t.id).join(",")); }
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { await hook.openLocal(session); });
    await hook.loadTurn(session, "turn-a");
    await act(async () => hook.closeLocal());
    let finish!: (value: SessionSearchResult | null) => void;
    api.getSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let opening!: Promise<void>;
    await act(async () => { opening = hook.openLocal(session); });
    expect(container.textContent).toBe("turn-a");
    expect(hook.turnsLoading).toBe(false);
    await hook.loadTurn(session, "turn-a");
    expect(api.getSessionTurn).toHaveBeenCalledTimes(1);
    await act(async () => { finish(null); await opening; });
    expect(hook.detail).toBeNull();
    expect(hook.turns).toEqual([]);
    await hook.loadTurn({ ...session, fileMtimeMs: 2 }, "turn-a");
    expect(api.getSessionTurn).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("keeps cached content on refresh errors and ignores results after switching or closing", async () => {
  const session = { sessionKey: "codex:a", fileMtimeMs: 1, fileSize: 10 } as SessionSearchResult;
  const api = { getSession: vi.fn().mockResolvedValue(session), listSessionTurns: vi.fn().mockResolvedValue([{ id: "a" }]) };
  Object.defineProperty(window, "sessionSearch", { configurable: true, value: api });
  const error = vi.fn();
  let hook!: ReturnType<typeof useSessionDetail>;
  const root = createRoot(document.createElement("div"));
  function Harness() { hook = useSessionDetail(error); return null; }
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { await hook.openLocal(session); });
    api.getSession.mockRejectedValueOnce(new Error("read failed"));
    await act(async () => { await hook.openLocal(session); });
    expect(hook.turns).toEqual([{ id: "a" }]);
    expect(error).toHaveBeenCalledTimes(1);
    let finish!: (value: SessionSearchResult) => void;
    api.getSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let opening!: Promise<void>;
    await act(async () => { opening = hook.openLocal(session); });
    await act(async () => hook.closeLocal());
    await act(async () => { finish(session); await opening; });
    expect(hook.detail).toBeNull();
    expect(hook.turns).toEqual([]);
  } finally { await act(async () => root.unmount()); }
});
