// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IslandSnapshot } from "../../shared/ipc/island";
import { DynamicIsland } from "./island";

describe("DynamicIsland", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let snapshotListener: ((snapshot: IslandSnapshot) => void) | null = null;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    snapshotListener = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders a completion toast for DeepSeek Harness Desktop and wires focus & trajectory actions", async () => {
    const focusIslandTask = vi.fn(async () => ({ focused: true }));
    const openIslandTrajectory = vi.fn(async () => undefined);
    const setIslandInteractive = vi.fn(async () => undefined);
    const snapshot: IslandSnapshot = {
      enabled: true,
      muted: false,
      soundEnabled: true,
      suppressWhenFocused: true,
      autoCollapseSeconds: 6,
      highlightedTaskId: "deepseek-cli:dsh-1",
      highlightVersion: 1,
      tasks: [{
        id: "deepseek-cli:dsh-1",
        source: "deepseek-cli",
        agentLabel: "DeepSeek Harness",
        appKind: "desktop",
        sessionId: "dsh-1",
        sessionKey: "local:deepseek:dsh-1",
        projectPath: "/work/agentrecall",
        projectName: "agentrecall",
        title: "修复测试",
        status: "completed",
        summary: "重构完成，所有测试已通过。",
        activeTool: null,
        model: "deepseek-chat",
        startedAt: 1000,
        updatedAt: 20_000,
        completedAt: 20_000,
        durationMs: 19_000,
        tokens: { input: 2400, output: 300, cached: 1200 },
        pid: null,
        signalSource: "log",
        unread: true,
      }],
    };

    (window as unknown as { sessionSearch: Record<string, unknown> }).sessionSearch = {
      getIslandSnapshot: vi.fn(async () => snapshot),
      onIslandSnapshot: vi.fn((cb: (next: IslandSnapshot) => void) => {
        snapshotListener = cb;
        return () => { snapshotListener = null; };
      }),
      focusIslandTask,
      openIslandTrajectory,
      shareIslandTaskToTeam: vi.fn(async () => undefined),
      dismissIslandTask: vi.fn(async () => ({ ...snapshot, tasks: [], highlightedTaskId: null })),
      clearCompletedIslandTasks: vi.fn(async () => ({ ...snapshot, tasks: [], highlightedTaskId: null })),
      setIslandMuted: vi.fn(async () => snapshot),
      setIslandInteractive,
    };

    await act(async () => {
      root.render(<DynamicIsland />);
    });

    expect(container.textContent).toContain("DeepSeek Harness");
    expect(container.textContent).toContain("重构完成，所有测试已通过。");

    const switchButton = [...container.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("切回应用") || btn.textContent?.includes("Switch to App"),
    );
    expect(switchButton).toBeTruthy();
    await act(async () => {
      switchButton?.click();
    });
    expect(focusIslandTask).toHaveBeenCalledWith("deepseek-cli:dsh-1");

    const trajectoryButton = [...container.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("看轨迹") || btn.textContent?.includes("Trajectory"),
    );
    expect(trajectoryButton).toBeTruthy();
    await act(async () => {
      trajectoryButton?.click();
    });
    expect(openIslandTrajectory).toHaveBeenCalledWith("deepseek-cli:dsh-1");
    expect(snapshotListener).toBeTypeOf("function");
  });

  it("renders a quiet standby drawer without any test-alert button", async () => {
    const setIslandInteractive = vi.fn(async () => undefined);
    (window as unknown as { sessionSearch: Record<string, unknown> }).sessionSearch = {
      getIslandSnapshot: vi.fn(async () => ({
        enabled: true,
        muted: false,
        soundEnabled: true,
        suppressWhenFocused: true,
        autoCollapseSeconds: 6,
        highlightedTaskId: null,
        highlightVersion: 0,
        tasks: [],
      })),
      onIslandSnapshot: vi.fn(() => () => undefined),
      focusIslandTask: vi.fn(async () => ({ focused: true })),
      openIslandTrajectory: vi.fn(async () => undefined),
      shareIslandTaskToTeam: vi.fn(async () => undefined),
      dismissIslandTask: vi.fn(async () => undefined),
      clearCompletedIslandTasks: vi.fn(async () => undefined),
      setIslandMuted: vi.fn(async () => undefined),
      setIslandInteractive,
    };

    await act(async () => {
      root.render(<DynamicIsland />);
    });

    expect(container.textContent).toMatch(/Ready|监听中/);
    const pillBtn = container.querySelector("button.island-compact-btn") as HTMLButtonElement | null;
    expect(pillBtn).toBeTruthy();
    await act(async () => pillBtn!.click());
    expect(container.textContent).toMatch(/Watching|实时监听中/);
    expect(container.textContent).not.toMatch(/测试提醒|Send test alert/);
  });

  it("toggles click-through interactivity from pointer hit-testing without resizing the overlay window", async () => {
    vi.useFakeTimers();
    const setIslandInteractive = vi.fn(async () => undefined);
    (window as unknown as { sessionSearch: Record<string, unknown> }).sessionSearch = {
      getIslandSnapshot: vi.fn(async () => ({
        enabled: true,
        muted: false,
        soundEnabled: true,
        suppressWhenFocused: true,
        autoCollapseSeconds: 6,
        highlightedTaskId: null,
        highlightVersion: 0,
        tasks: [],
      })),
      onIslandSnapshot: vi.fn(() => () => undefined),
      focusIslandTask: vi.fn(async () => ({ focused: true })),
      openIslandTrajectory: vi.fn(async () => undefined),
      shareIslandTaskToTeam: vi.fn(async () => undefined),
      dismissIslandTask: vi.fn(async () => undefined),
      clearCompletedIslandTasks: vi.fn(async () => undefined),
      setIslandMuted: vi.fn(async () => undefined),
      setIslandInteractive,
    };

    try {
      await act(async () => {
        root.render(<DynamicIsland />);
      });

      const stage = container.querySelector(".island-stage") as HTMLDivElement;
      const pill = container.querySelector(".island-pill") as HTMLDivElement;
      expect(stage).toBeTruthy();
      expect(pill).toBeTruthy();
      Object.defineProperty(stage, "clientWidth", { value: 468, configurable: true });
      // Even if DOM getBoundingClientRect lags behind during a CSS transition, hit-testing uses
      // target pill geometry derived from stage width so expansion/collapse never mis-hits.
      vi.spyOn(pill, "getBoundingClientRect").mockReturnValue({
        left: 156,
        right: 312,
        top: 6,
        bottom: 38,
        width: 156,
        height: 32,
        x: 156,
        y: 6,
        toJSON: () => ({}),
      });

      // Moving just outside the collapsed 156x32 pill (156..312, 6..38) never ghost-triggers.
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 150, clientY: 20 }));
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 220, clientY: 44 }));
      });
      expect(setIslandInteractive).not.toHaveBeenCalled();

      // Moving directly onto the pill enables clicks immediately and opens drawer after 220ms dwell.
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 220, clientY: 22 }));
      });
      expect(setIslandInteractive).toHaveBeenLastCalledWith(true);

      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(pill.getAttribute("data-mode")).toBe("standby");

      await act(async () => {
        vi.advanceTimersByTime(130);
      });
      expect(pill.getAttribute("data-mode")).toBe("drawer");

      // Moving onto the expanded 412x84 drawer area (28..440, 6..90) outside the old 156x32 pill
      // keeps the drawer open without prematurely collapsing.
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, clientY: 70 }));
        vi.advanceTimersByTime(300);
      });
      expect(pill.getAttribute("data-mode")).toBe("drawer");
      expect(setIslandInteractive).toHaveBeenLastCalledWith(true);

      // Moving outside releases click-through immediately and collapses after the 240ms grace delay.
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 300 }));
      });
      expect(setIslandInteractive).toHaveBeenLastCalledWith(false);
      expect(pill.getAttribute("data-mode")).toBe("drawer");

      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(pill.getAttribute("data-mode")).toBe("standby");

      // Moving through the previously expanded drawer area (80, 70) must NOT re-trigger standby.
      setIslandInteractive.mockClear();
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, clientY: 70 }));
        vi.advanceTimersByTime(300);
      });
      expect(setIslandInteractive).not.toHaveBeenCalled();
      expect(pill.getAttribute("data-mode")).toBe("standby");
    } finally {
      vi.useRealTimers();
    }
  });
});
