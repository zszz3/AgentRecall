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
    resizeTopCenter: vi.fn(),
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

  it("activates DSH Desktop on focusTask and resolves sessionKey for openTrajectory", async () => {
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
      findSessionByRawId: vi.fn(async (rawId) => rawId === "dsh-9" ? ({
        sessionKey: "local:deepseek:dsh-9",
        rawId: "dsh-9",
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

    const focus = await service.focusTask("deepseek-cli:dsh-9");
    expect(focus).toEqual({ focused: true, targetLabel: "DeepSeek Harness" });
    expect(activateDesktopApp).toHaveBeenCalledWith("deepseek-cli");

    await service.openTrajectory("deepseek-cli:dsh-9");
    expect(openSessionInMain).toHaveBeenCalledWith("local:deepseek:dsh-9");
    service.stop();
  });
});
