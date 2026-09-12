// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useMessageLinks } from "./use-message-links";

describe("external message navigation", () => {
  it("consumes a cold-start location only after mounting and unsubscribes on close", async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const element = document.createElement("div");
    const root = createRoot(element);
    const open = vi.fn(async () => {}); const onError = vi.fn(); const unsubscribe = vi.fn();
    const locator = { sessionKey: "codex:fixture", messageIndex: 0, fingerprint: "a".repeat(64) };
    const session = { sessionKey: locator.sessionKey };
    const hit = { messageIndex: 0, turnId: "turn-0", role: "user", timestamp: "", snippet: "hello", matchedTerms: [] };
    const takePending = vi.fn().mockResolvedValueOnce(locator).mockResolvedValue(null);
    const resolve = vi.fn(async () => ({ sessionKey: locator.sessionKey, hit }));
    Object.defineProperty(window, "sessionSearch", { configurable: true, value: {
      getSession: vi.fn(async () => session), messageTools: {
        takePending, resolve, onOpen: vi.fn(() => unsubscribe),
      },
    } });
    function Harness() { useMessageLinks(open, onError); return null; }
    try {
      await act(async () => root.render(<Harness />));
      expect(open).toHaveBeenCalledWith(session, hit);
      expect(resolve).toHaveBeenCalledWith(locator);
      expect(onError).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); }
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("reports a stale location without opening another message", async () => {
    const element = document.createElement("div"); const root = createRoot(element);
    const open = vi.fn(async () => {}); const onError = vi.fn();
    Object.defineProperty(window, "sessionSearch", { configurable: true, value: { messageTools: {
      takePending: vi.fn(async () => ({})), resolve: vi.fn(async () => { throw new Error("Message removed"); }), onOpen: () => () => {},
    } } });
    function Harness() { useMessageLinks(open, onError); return null; }
    try {
      await act(async () => root.render(<Harness />));
      expect(open).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Message removed" }));
    } finally { await act(async () => root.unmount()); }
  });
});
