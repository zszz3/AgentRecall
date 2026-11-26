// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePageNavigation, type PageNavigation } from "./use-page-navigation";

describe("usePageNavigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let navigation: PageNavigation;
  const renders: Array<{ page: string; request: unknown }> = [];

  function Harness() {
    navigation = usePageNavigation();
    renders.push({ page: navigation.activePage, request: navigation.request });
    return null;
  }

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    renders.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("hands a request to the page it opens in the same render and drops it when the user moves on", async () => {
    expect(navigation.activePage).toBe("workbench");
    await act(async () => {
      await navigation.open({ page: "evaluation", runId: "run-1", caseId: "case-1" });
    });
    expect(renders.find((render) => render.page === "evaluation")?.request).toEqual({ page: "evaluation", runId: "run-1", caseId: "case-1" });

    await act(async () => {
      await navigation.navigate("sessions");
    });
    expect(navigation.request).toBeNull();

    await act(async () => {
      await navigation.open({ page: "providers", view: "gateway-overview" });
    });
    expect(navigation.request).toEqual({ page: "providers", view: "gateway-overview" });
    await act(async () => navigation.consumeRequest());
    expect(navigation.request).toBeNull();
    expect(navigation.activePage).toBe("providers");
  });

  it("stays on the page and keeps no request when its guard refuses to leave or fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await act(async () => {
      await navigation.navigate("evaluation");
    });
    const guard = vi.fn(async () => false);
    act(() => navigation.setGuard(guard));
    let opened = true;
    await act(async () => {
      opened = await navigation.open({ page: "runtimes", agentId: "agent-1" });
    });
    expect(opened).toBe(false);
    expect(navigation.activePage).toBe("evaluation");
    expect(navigation.request).toBeNull();

    act(() => navigation.setGuard(async () => {
      throw new Error("unsaved draft check failed");
    }));
    await act(async () => {
      opened = await navigation.navigate("workbench");
    });
    expect(opened).toBe(false);
    expect(navigation.activePage).toBe("evaluation");

    act(() => navigation.setGuard(async () => true));
    await act(async () => {
      opened = await navigation.open({ page: "skills", discovery: true });
    });
    expect(opened).toBe(true);
    expect(navigation.activePage).toBe("skills");
    expect(navigation.request).toEqual({ page: "skills", discovery: true });
  });
});
