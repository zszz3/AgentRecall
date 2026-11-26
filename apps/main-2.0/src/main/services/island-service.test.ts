import * as os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { IslandService, type IslandOverlayWindowPort } from "./island-service";

function createFakeWindow(): IslandOverlayWindowPort & {
  visible: boolean;
  snapshots: unknown[];
} {
  return {
    visible: false,
    snapshots: [],
    ensureCreated: vi.fn(),
    showInactive() { this.visible = true; },
    hide() { this.visible = false; },
    destroy: vi.fn(),
    setInteractive: vi.fn(),
    sendSnapshot(snapshot) { this.snapshots.push(snapshot); },
  };
}

describe("IslandService", () => {
  it("suppresses popup & sound when DSH Desktop is already frontmost, and pops when user is in another app", async () => {
    const window = createFakeWindow();
    const playSound = vi.fn(async () => undefined);
    let frontmost = { name: "DeepSeek Harness", bundleId: "com.deepseek.harness" };

    const service = new IslandService({
      homeDir: os.tmpdir(),
      getConfig: () => ({
        enabled: true,
        soundEnabled: true,
        suppressWhenFocused: true,
        autoCollapseSeconds: 6,
      }),
      window,
      broadcastSnapshot: vi.fn(),
      findSessionByRawId: vi.fn(async () => null),
      loadLiveSessions: vi.fn(async () => ({ generatedAt: new Date().toISOString(), sessions: [] })),
      openSessionInMain: vi.fn(),
      shareSessionToTeamInMain: vi.fn(),
      openSessionsPageInMain: vi.fn(),
      getFrontmostApp: async () => frontmost,
      playSound,
    });

    const silent = await service.ingestEvent({
      source: "deepseek-cli",
      sessionId: "dsh-1",
      status: "completed",
      signalSource: "log",
      summary: "静默完成",
    });
    expect(silent.highlightedTaskId).toBeNull();
    expect(playSound).not.toHaveBeenCalled();

    frontmost = { name: "Google Chrome", bundleId: "com.google.Chrome" };
    const alerted = await service.ingestEvent({
      source: "deepseek-cli",
      sessionId: "dsh-2",
      status: "completed",
      signalSource: "log",
      summary: "切出后的新回复",
    });
    expect(alerted.highlightedTaskId).toBe("deepseek-cli:dsh-2");
    expect(window.visible).toBe(true);
    expect(playSound).toHaveBeenCalledWith("completed");
    service.stop();
  });

  it("activates DSH Desktop on focusTask, resolves sessionKey for openTrajectory, and dismisses each clicked task", async () => {
    const window = createFakeWindow();
    const activateDesktopApp = vi.fn(async () => ({ activated: true, targetLabel: "DeepSeek Harness" }));
    const openSessionInMain = vi.fn();

    const service = new IslandService({
      homeDir: os.tmpdir(),
      getConfig: () => ({
        enabled: true,
        soundEnabled: false,
        suppressWhenFocused: false,
        autoCollapseSeconds: 6,
      }),
      window,
      broadcastSnapshot: vi.fn(),
      findSessionByRawId: vi.fn(async (rawId) => rawId === "dsh-9" || rawId === "dsh-10" ? ({
        sessionKey: `local:deepseek:${rawId}`,
        rawId,
        source: "deepseek-cli",
        environmentKind: "local",
      } as never) : null),
      loadLiveSessions: vi.fn(async () => ({ generatedAt: new Date().toISOString(), sessions: [] })),
      openSessionInMain,
      shareSessionToTeamInMain: vi.fn(),
      openSessionsPageInMain: vi.fn(),
      activateDesktopApp,
    });

    await service.ingestEvent({
      source: "deepseek-cli",
      sessionId: "dsh-9",
      status: "completed",
      signalSource: "log",
      summary: "完成了重构",
    });
    await service.ingestEvent({
      source: "deepseek-cli",
      sessionId: "dsh-10",
      status: "completed",
      signalSource: "log",
      summary: "完成了单测",
    });

    const focus = await service.focusTask("deepseek-cli:dsh-9");
    expect(focus).toEqual({ focused: true, targetLabel: "DeepSeek Harness" });
    expect(activateDesktopApp).toHaveBeenCalledWith("deepseek-cli");
    expect(service.getSnapshot().tasks.map((task) => task.id)).toEqual(["deepseek-cli:dsh-10"]);

    await service.openTrajectory("deepseek-cli:dsh-10");
    expect(openSessionInMain).toHaveBeenCalledWith("local:deepseek:dsh-10");
    expect(service.getSnapshot().tasks).toEqual([]);
    service.stop();
  });

  it("refreshes the index when opening trajectory for a brand-new unindexed session and pauses collapse on hover", async () => {
    vi.useFakeTimers();
    try {
      const window = createFakeWindow();
      const openSessionInMain = vi.fn();
      let indexed = false;
      const refreshIndex = vi.fn(async () => { indexed = true; });
      const findSessionByRawId = vi.fn(async (rawId: string) => indexed && rawId === "dsh-new" ? ({
        sessionKey: "local:deepseek:dsh-new",
        rawId: "dsh-new",
        source: "deepseek-cli",
        environmentKind: "local",
        lastActivityAt: Date.now(),
      } as never) : null);

      const service = new IslandService({
        homeDir: os.tmpdir(),
        getConfig: () => ({
          enabled: true,
          soundEnabled: false,
          suppressWhenFocused: false,
          autoCollapseSeconds: 3,
        }),
        window,
        broadcastSnapshot: vi.fn(),
        findSessionByRawId,
        refreshIndex,
        loadLiveSessions: vi.fn(async () => ({ generatedAt: new Date().toISOString(), sessions: [] })),
        openSessionInMain,
        shareSessionToTeamInMain: vi.fn(),
        openSessionsPageInMain: vi.fn(),
      });

      await service.ingestEvent({
        source: "deepseek-cli",
        sessionId: "dsh-new",
        status: "completed",
        signalSource: "log",
        summary: "刚刚完成",
      });
      // Mouse enters the Island -> pause auto-collapse even past 3s.
      service.setInteractive(true);
      vi.advanceTimersByTime(5000);
      expect(service.getSnapshot().highlightedTaskId).toBe("deepseek-cli:dsh-new");

      // Mouse leaves -> collapses after short grace period.
      service.setInteractive(false);
      vi.advanceTimersByTime(3000);
      expect(service.getSnapshot().highlightedTaskId).toBeNull();

      // Clicking openTrajectory triggers incremental refresh, opens the exact session, and dismisses the item.
      await service.openTrajectory("deepseek-cli:dsh-new");
      expect(refreshIndex).toHaveBeenCalledTimes(1);
      expect(openSessionInMain).toHaveBeenCalledWith("local:deepseek:dsh-new");
      expect(service.getSnapshot().tasks).toEqual([]);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the overlay, disables monitoring, and invokes onDisable when closed from inside the island", async () => {
    const window = createFakeWindow();
    const broadcastSnapshot = vi.fn();
    const onDisable = vi.fn(async () => undefined);
    const service = new IslandService({
      homeDir: os.tmpdir(),
      getConfig: () => ({
        enabled: true,
        soundEnabled: false,
        suppressWhenFocused: false,
        autoCollapseSeconds: 6,
      }),
      window,
      broadcastSnapshot,
      findSessionByRawId: vi.fn(async () => null),
      loadLiveSessions: vi.fn(async () => ({ generatedAt: new Date().toISOString(), sessions: [] })),
      openSessionInMain: vi.fn(),
      shareSessionToTeamInMain: vi.fn(),
      openSessionsPageInMain: vi.fn(),
      onDisable,
    });

    service.start();
    expect(window.visible).toBe(true);

    const closed = await service.close();
    expect(closed.enabled).toBe(false);
    expect(window.visible).toBe(false);
    expect(onDisable).toHaveBeenCalledTimes(1);
    expect(broadcastSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    service.stop();
  });
});
