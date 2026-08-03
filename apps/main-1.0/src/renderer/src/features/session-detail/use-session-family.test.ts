// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionFamily } from "../../../../core/session-family";
import { useSessionFamily, type FamilySessionOpenResult } from "./use-session-family";

const INITIAL_FAMILY: SessionFamily = {
  parent: null,
  children: [{
    sessionKey: "codex:child",
    rawId: "child",
    title: "Child task",
    source: "codex-cli",
    environmentId: "local",
    environmentLabel: "Local",
    messageCount: 1,
    lastActivityAt: 1,
    aiSummary: null,
    children: [],
  }],
  truncated: false,
};

function Harness({
  refreshVersion,
  onOpen,
}: {
  refreshVersion: number;
  onOpen(sessionKey: string): Promise<FamilySessionOpenResult>;
}) {
  const family = useSessionFamily({
    sessionKey: "codex:parent",
    refreshVersion,
    onOpen,
  });
  return createElement("div", null,
    createElement("span", null, family.loadFailed ? "failed" : family.family.children[0]?.title ?? "empty"),
    createElement("button", { type: "button", onClick: family.retry }, "retry"),
    createElement("button", { type: "button", onClick: () => family.open("codex:child") }, "open"),
  );
}

describe("useSessionFamily", () => {
  let container: HTMLDivElement;
  let root: Root;
  let getSessionFamily: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    getSessionFamily = vi.fn().mockResolvedValue(INITIAL_FAMILY);
    Reflect.set(window, "sessionSearch", { getSessionFamily });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "sessionSearch");
  });

  async function renderHarness({
    refreshVersion = 0,
    onOpen = vi.fn().mockResolvedValue("opened"),
  } = {}): Promise<void> {
    await act(async () => {
      root.render(createElement(Harness, { refreshVersion, onOpen }));
      await Promise.resolve();
    });
  }

  function click(label: string): void {
    const button = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent === label);
    expect(button).toBeDefined();
    button!.click();
  }

  it("reloads the open family when the refresh version changes", async () => {
    getSessionFamily
      .mockResolvedValueOnce(INITIAL_FAMILY)
      .mockResolvedValueOnce({
        ...INITIAL_FAMILY,
        children: [{ ...INITIAL_FAMILY.children[0]!, title: "New child task" }],
      });

    await renderHarness({ refreshVersion: 0 });
    expect(container.textContent).toContain("Child task");
    await renderHarness({ refreshVersion: 1 });

    expect(container.textContent).toContain("New child task");
    expect(getSessionFamily).toHaveBeenCalledTimes(2);
  });

  it("exposes a failed state and retries the family request", async () => {
    getSessionFamily
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(INITIAL_FAMILY);

    await renderHarness();
    expect(container.textContent).toContain("failed");
    await act(async () => {
      click("retry");
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Child task");
    expect(getSessionFamily).toHaveBeenCalledTimes(2);
  });

  it("refreshes the family after opening a missing related session", async () => {
    const onOpen = vi.fn().mockResolvedValue("missing");
    await renderHarness({ onOpen });

    await act(async () => {
      click("open");
      await Promise.resolve();
    });

    expect(onOpen).toHaveBeenCalledWith("codex:child");
    expect(getSessionFamily).toHaveBeenCalledTimes(2);
  });
});
