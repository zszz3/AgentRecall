import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSearchResult } from "../../core/types";
import { SessionCommandService, type SessionCommandServiceDependencies } from "./session-command-service";

const platform = vi.hoisted(() => ({
  probeDeepSeekWeb: vi.fn(async () => true),
  openDeepSeekWebInTerminal: vi.fn(async () => undefined),
  waitForDeepSeekWeb: vi.fn(async () => true),
}));

vi.mock("../../core/platform", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../core/platform")>(),
  ...platform,
}));

const session = {
  sessionKey: "deepseek:s1",
  rawId: "s1",
  source: "deepseek-cli",
  environmentKind: "local",
  environmentId: "local",
  projectPath: "/work",
  filePath: "/work/session.v4.jsonl.zstd",
} as SessionSearchResult;

function createService(desktopRunning: boolean) {
  const dependencies = {
    store: { getSession: vi.fn(async () => session), markResumed: vi.fn(async () => undefined) },
    remoteAccess: { requireSshArgs: vi.fn(async () => undefined) },
    getSettings: vi.fn(() => ({})),
    openDeepSeekWebSession: vi.fn(async () => undefined),
    activateRunningDeepSeekDesktop: vi.fn(async () => desktopRunning),
  };
  const service = new SessionCommandService(dependencies as unknown as SessionCommandServiceDependencies);
  return { service, dependencies };
}

describe("SessionCommandService DeepSeek Harness resume", () => {
  beforeEach(() => vi.clearAllMocks());

  it("brings a running Desktop forward instead of starting the terminal Web server", async () => {
    const { service, dependencies } = createService(true);

    await expect(service.resume("deepseek:s1")).resolves.toEqual({ route: "desktop-app" });

    expect(platform.probeDeepSeekWeb).not.toHaveBeenCalled();
    expect(platform.openDeepSeekWebInTerminal).not.toHaveBeenCalled();
    expect(dependencies.openDeepSeekWebSession).not.toHaveBeenCalled();
    expect(dependencies.store.markResumed).not.toHaveBeenCalled();
  });

  it("opens the session in the terminal Web UI when Desktop is not running", async () => {
    const { service, dependencies } = createService(false);
    platform.probeDeepSeekWeb.mockResolvedValueOnce(false);

    await expect(service.resume("deepseek:s1")).resolves.toEqual({ route: "resume" });

    expect(platform.openDeepSeekWebInTerminal).toHaveBeenCalledWith("/work", {});
    expect(dependencies.openDeepSeekWebSession).toHaveBeenCalledWith("s1");
  });
});
