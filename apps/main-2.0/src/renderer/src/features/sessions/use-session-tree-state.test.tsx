// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionTreeState, type SessionTreeState } from "./use-session-tree-state";

describe("useSessionTreeState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let tree: SessionTreeState;
  let stored: Map<string, string>;

  function Harness() {
    tree = useSessionTreeState();
    return null;
  }

  async function mount(): Promise<void> {
    await act(async () => root.render(createElement(Harness)));
  }

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    stored = new Map();
    // Node 26 exposes an undefined localStorage global that shadows happy-dom's.
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("remembers folded sidebar sections and environments across restarts but not unfolded projects", async () => {
    await mount();
    expect(tree.sections.views).toBe(false);
    await act(async () => {
      tree.toggleSection("views");
      tree.toggleEnvironment("local");
      tree.toggleProject("local:/repo");
    });
    expect(tree.sections.views).toBe(true);
    expect([...tree.collapsedEnvironments]).toEqual(["local"]);
    expect([...tree.expandedProjects]).toEqual(["local:/repo"]);

    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(tree.sections.views).toBe(true);
    expect([...tree.collapsedEnvironments]).toEqual(["local"]);
    expect([...tree.expandedProjects]).toEqual([]);

    await act(async () => tree.toggleEnvironment("local"));
    expect(JSON.parse(stored.get("agent-recall-collapsed-project-groups")!)).toEqual([]);
  });

  it("ignores unreadable saved state", async () => {
    stored.set("agent-recall-collapsed-project-groups", "{not json");
    stored.set("agent-recall-sidebar-sections", "[]");
    await mount();
    expect([...tree.collapsedEnvironments]).toEqual([]);
    expect(tree.sections).toEqual({ environments: true, remaining: true, sources: true, views: false });
  });
});
