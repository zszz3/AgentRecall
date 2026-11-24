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
    const resizeIslandBounds = vi.fn(async () => undefined);
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
      setIslandInteractive: vi.fn(async () => undefined),
      resizeIslandBounds,
    };

    await act(async () => {
      root.render(<DynamicIsland />);
    });

    expect(container.textContent).toContain("DeepSeek Harness");
    expect(container.textContent).toContain("重构完成，所有测试已通过。");
    expect(resizeIslandBounds).toHaveBeenCalled();

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

  it("renders a visible standby pill when enabled with no active tasks", async () => {
    const resizeIslandBounds = vi.fn(async () => undefined);
    const sendIslandTestAlert = vi.fn(async () => ({
      enabled: true,
      muted: false,
      soundEnabled: true,
      suppressWhenFocused: true,
      autoCollapseSeconds: 6,
      highlightedTaskId: null,
      highlightVersion: 0,
      tasks: [],
    }));
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
      setIslandInteractive: vi.fn(async () => undefined),
      resizeIslandBounds,
      sendIslandTestAlert,
    };

    await act(async () => {
      root.render(<DynamicIsland />);
    });

    expect(container.textContent).toMatch(/Ready|监听中/);
    const pillBtn = container.querySelector("button.island-compact-btn") as HTMLButtonElement | null;
    expect(pillBtn).toBeTruthy();
    await act(async () => pillBtn!.click());
    const testBtn = [...container.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("测试提醒") || btn.textContent?.includes("Send test alert"),
    );
    expect(testBtn).toBeTruthy();
    await act(async () => testBtn!.click());
    expect(sendIslandTestAlert).toHaveBeenCalledWith("completed");
  });

  it("expands window immediately on drawer open and delays shrinking until the collapse spring finishes", async () => {
    vi.useFakeTimers();
    const resizeIslandBounds = vi.fn(async () => undefined);
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
      setIslandInteractive: vi.fn(async () => undefined),
      resizeIslandBounds,
    };

    try {
      await act(async () => {
        root.render(<DynamicIsland />);
      });
      expect(resizeIslandBounds).toHaveBeenLastCalledWith(204, 70);

      const pillBtn = container.querySelector("button.island-compact-btn") as HTMLButtonElement;
      await act(async () => pillBtn.click());
      expect(resizeIslandBounds).toHaveBeenLastCalledWith(460, 156);

      const closeBtn = container.querySelector('button[aria-label="Collapse"], button[aria-label="收起"]') as HTMLButtonElement;
      await act(async () => closeBtn.click());
      // Window stays large while the collapse spring runs, then trims cleanly after 380ms.
      expect(resizeIslandBounds).toHaveBeenLastCalledWith(460, 156);
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(resizeIslandBounds).toHaveBeenLastCalledWith(204, 70);
    } finally {
      vi.useRealTimers();
    }
  });
});
