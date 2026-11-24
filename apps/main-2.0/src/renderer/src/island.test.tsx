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

      const pill = container.querySelector(".island-pill") as HTMLDivElement;
      expect(pill).toBeTruthy();
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

      // Moving over transparent space outside the pill keeps click-through active.
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 20, clientY: 20 }));
      });
      expect(setIslandInteractive).not.toHaveBeenCalled();

      // Moving into the pill activates interactivity immediately and opens drawer after 90ms.
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 220, clientY: 22 }));
      });
      expect(setIslandInteractive).toHaveBeenLastCalledWith(true);

      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(pill.getAttribute("data-mode")).toBe("drawer");

      // Moving outside collapses after the 140ms grace delay and restores click-through.
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 300 }));
      });
      expect(pill.getAttribute("data-mode")).toBe("drawer");
      await act(async () => {
        vi.advanceTimersByTime(160);
      });
      expect(pill.getAttribute("data-mode")).toBe("standby");
      expect(setIslandInteractive).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
