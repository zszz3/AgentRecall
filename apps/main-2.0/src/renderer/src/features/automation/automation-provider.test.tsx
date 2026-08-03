// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SNAPSHOT } from "../../../../automation/engine/renderer/src/app/app-state";
import type { AppSnapshot } from "../../../../automation/contracts";
import type { WorkflowSidebarSnapshot } from "../../../../shared/ipc/automation";
import { AutomationProvider, useAutomation } from "./automation-provider";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

function Observer(): ReactElement {
  const { snapshot, workflowSidebar, workflowSidebarLoading, detailsLoaded, loading, error } = useAutomation();
  const visibleWorkflows = detailsLoaded ? snapshot.workflowStore.workflows : workflowSidebar.workflows;
  return (
    <div
      data-sidebar-loading={String(workflowSidebarLoading)}
      data-details-loading={String(loading)}
      data-details-loaded={String(detailsLoaded)}
      data-error={error ?? ""}
    >
      {visibleWorkflows.map((workflow) => workflow.title).join(",")}
    </div>
  );
}

describe("AutomationProvider progressive Workflow loading", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("requests full details only after sidebar summaries settle", async () => {
    const sidebar = deferred<WorkflowSidebarSnapshot>();
    const snapshot = deferred<AppSnapshot>();
    const api = {
      getWorkflowSidebar: vi.fn(() => sidebar.promise),
      getSnapshot: vi.fn(() => snapshot.promise),
      getHealth: vi.fn(async () => ({ state: "initializing" as const })),
      onSnapshot: vi.fn(() => () => undefined),
      onChange: vi.fn(() => () => undefined),
    };
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { automation: api },
    });

    await act(async () => {
      root.render(<AutomationProvider><Observer /></AutomationProvider>);
    });

    expect(api.getWorkflowSidebar).toHaveBeenCalledOnce();
    expect(api.getSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      sidebar.resolve({
        activeWorkflowId: "workflow-1",
        workflows: [{
          workflowId: "workflow-1",
          sourceType: "user",
          title: "Visible first",
          status: "completed",
          revision: 2,
          objective: "Load progressively",
          nodeCount: 3,
          createdAt: 1,
          updatedAt: 2,
        }],
      });
      await sidebar.promise;
    });

    expect(container.textContent).toContain("Visible first");
    expect(container.firstElementChild?.getAttribute("data-sidebar-loading")).toBe("false");
    expect(container.firstElementChild?.getAttribute("data-details-loading")).toBe("true");
    expect(api.getSnapshot).toHaveBeenCalledOnce();

    await act(async () => {
      snapshot.resolve(DEFAULT_SNAPSHOT);
      await snapshot.promise;
    });

    expect(container.firstElementChild?.getAttribute("data-details-loading")).toBe("false");
    expect(container.firstElementChild?.getAttribute("data-details-loaded")).toBe("true");
  });

  it("keeps sidebar summaries visible when full details fail", async () => {
    const sidebar = deferred<WorkflowSidebarSnapshot>();
    const snapshot = deferred<AppSnapshot>();
    const api = {
      getWorkflowSidebar: vi.fn(() => sidebar.promise),
      getSnapshot: vi.fn(() => snapshot.promise),
      getHealth: vi.fn(async () => ({ state: "initializing" as const })),
      onSnapshot: vi.fn(() => () => undefined),
      onChange: vi.fn(() => () => undefined),
    };
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { automation: api },
    });

    await act(async () => {
      root.render(<AutomationProvider><Observer /></AutomationProvider>);
    });
    await act(async () => {
      sidebar.resolve({
        activeWorkflowId: "workflow-1",
        workflows: [{
          workflowId: "workflow-1",
          sourceType: "user",
          title: "Still visible",
          status: "completed",
          revision: 1,
          objective: "Keep the summary",
          nodeCount: 2,
          createdAt: 1,
          updatedAt: 1,
        }],
      });
      await sidebar.promise;
    });
    await act(async () => {
      snapshot.reject(new Error("details unavailable"));
      await snapshot.promise.catch(() => undefined);
    });

    expect(container.textContent).toContain("Still visible");
    expect(container.firstElementChild?.getAttribute("data-details-loaded")).toBe("false");
    expect(container.firstElementChild?.getAttribute("data-details-loading")).toBe("false");
    expect(container.firstElementChild?.getAttribute("data-error")).toBe("details unavailable");
  });
});
