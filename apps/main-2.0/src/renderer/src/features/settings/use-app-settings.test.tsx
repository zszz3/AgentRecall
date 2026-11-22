// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApiConfig, defaultClaudeApiConfig, type ApiConfig, type ClaudeApiConfig } from "../../../../core/api-config";
import type { ApplyClaudeProfileResult } from "../../../../core/claude-profile";
import type { ApplyCodexProfileResult } from "../../../../core/codex-profile";
import type { IndexStatus } from "../../../../core/indexer";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { SessionEnvironment } from "../../../../core/types";
import type { V1ImportResult } from "../../../../core/v1-import";
import { useAppSettings, type AppSettingsController } from "./use-app-settings";

const initialSettings = {
  includeHermes: false,
  includeOpenCode: false,
  hideCodexQuota: false,
  hideClaudeQuota: false,
  evalEnabled: false,
  remoteSyncEnabled: false,
  remoteSyncSupabaseUrl: "",
  remoteSyncSupabaseAnonKey: "",
} as AppSettings;

const indexed: IndexStatus = { running: false, indexed: 1, skipped: 0, total: 1, lastIndexedAt: 1, error: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("useAppSettings", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: AppSettingsController;
  let stored: AppSettings;
  const reloadSessions = vi.fn(async (): Promise<void> => undefined);
  const setEnvironments = vi.fn();
  const invalidateRemoteSessions = vi.fn();
  const refreshSessionHookStatus = vi.fn();
  const loadQuotas = vi.fn(async (): Promise<void> => undefined);
  const api = {
    getSettings: vi.fn(async () => stored),
    setSettings: vi.fn(async (update: AppSettingsUpdate) => {
      stored = { ...stored, ...update } as AppSettings;
      return stored;
    }),
    refreshIndex: vi.fn(async () => indexed),
    importV1Data: vi.fn<() => Promise<V1ImportResult>>(),
    listEnvironments: vi.fn(async (): Promise<SessionEnvironment[]> => []),
    applyCodexProfile: vi.fn<(apiConfig: ApiConfig) => Promise<ApplyCodexProfileResult>>(),
    applyClaudeProfile: vi.fn<(apiConfig: ClaudeApiConfig) => Promise<ApplyClaudeProfileResult>>(),
  };

  function Harness() {
    controller = useAppSettings({
      api,
      reloadSessions,
      setEnvironments,
      invalidateRemoteSessions,
      refreshSessionHookStatus,
      loadQuotas,
      t: (en) => en,
    });
    return null;
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  function filterValues(): Array<string | undefined> {
    return controller.visibleSourceFilters.map((filter) => filter.value);
  }

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.clearAllMocks();
    stored = initialSettings;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
    await advance(0);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("loads the saved settings on mount", () => {
    expect(api.getSettings).toHaveBeenCalledOnce();
    expect(controller.settings).toEqual(initialSettings);
  });

  it("waits for an earlier save, even a failed one, before saving the next update", async () => {
    const firstSave = deferred<AppSettings>();
    api.setSettings.mockReturnValueOnce(firstSave.promise);
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = controller.update({ hideCodexQuota: true });
      second = controller.update({ evalEnabled: true });
    });
    expect(api.setSettings).toHaveBeenCalledOnce();
    expect(controller.feedback).toEqual({ kind: "running", message: "Saving settings..." });

    await act(async () => {
      firstSave.reject(new Error("Settings file is read-only."));
      await Promise.all([first, second]);
    });
    expect(api.setSettings).toHaveBeenLastCalledWith({ evalEnabled: true });
    expect(controller.settings).toMatchObject({ hideCodexQuota: false, evalEnabled: true });
    expect(loadQuotas).not.toHaveBeenCalled();
    expect(controller.feedback).toEqual({ kind: "success", message: "Settings saved." });

    await advance(1600);
    expect(controller.feedback).toBeNull();
  });

  it("reports a failed save without changing the settings", async () => {
    api.setSettings.mockRejectedValueOnce(new Error("Settings file is read-only."));

    await act(async () => controller.update({ hideCodexQuota: true }));

    expect(controller.feedback).toEqual({ kind: "error", message: "Settings file is read-only." });
    expect(controller.settings).toEqual(initialSettings);
    expect(loadQuotas).not.toHaveBeenCalled();
  });

  it("reloads quotas and remote sync state when their settings change", async () => {
    await act(async () => controller.update({ hideClaudeQuota: true, remoteSyncEnabled: true }));

    expect(loadQuotas).toHaveBeenCalledOnce();
    expect(invalidateRemoteSessions).toHaveBeenCalledOnce();
    expect(refreshSessionHookStatus).toHaveBeenCalledOnce();
  });

  it("indexes a turned-on source in the background before showing its filter", async () => {
    const reload = deferred<void>();
    reloadSessions.mockReturnValueOnce(reload.promise);

    await act(async () => controller.update({ includeHermes: true }));
    expect(controller.settings?.includeHermes).toBe(true);
    expect(filterValues()).not.toContain("hermes");
    expect(controller.feedback).toEqual({ kind: "success", message: "Loading sessions in the background..." });
    expect(api.refreshIndex).not.toHaveBeenCalled();

    await advance(120);
    expect(api.refreshIndex).toHaveBeenCalledOnce();
    expect(reloadSessions).toHaveBeenCalledOnce();
    expect(api.refreshIndex.mock.invocationCallOrder[0]).toBeLessThan(reloadSessions.mock.invocationCallOrder[0]);
    expect(filterValues()).not.toContain("hermes");

    await act(async () => reload.resolve());
    expect(filterValues()).toContain("hermes");
    expect(controller.feedback).toEqual({ kind: "success", message: "Sources ready." });

    await advance(1600);
    expect(controller.feedback).toBeNull();
  });

  it("reloads Sessions without reindexing when a source is turned off", async () => {
    await act(async () => controller.update({ includeHermes: true }));
    await advance(120);
    vi.clearAllMocks();

    await act(async () => controller.update({ includeHermes: false }));
    await advance(120);

    expect(api.refreshIndex).not.toHaveBeenCalled();
    expect(reloadSessions).toHaveBeenCalledOnce();
    expect(filterValues()).not.toContain("hermes");
    expect(controller.feedback).toEqual({ kind: "success", message: "Sources ready." });
  });

  it("ignores an older background load once another source changed", async () => {
    const firstReload = deferred<void>();
    reloadSessions.mockReturnValueOnce(firstReload.promise);
    await act(async () => controller.update({ includeHermes: true }));
    await advance(120);
    expect(reloadSessions).toHaveBeenCalledOnce();

    await act(async () => controller.update({ includeOpenCode: true }));
    await act(async () => firstReload.resolve());
    expect(filterValues()).not.toContain("hermes");
    expect(controller.feedback).toEqual({ kind: "success", message: "Loading sessions in the background..." });

    await advance(120);
    expect(api.refreshIndex).toHaveBeenCalledTimes(2);
    expect(reloadSessions).toHaveBeenCalledTimes(2);
    expect(filterValues()).toEqual(expect.arrayContaining(["hermes", "opencode-cli"]));
    expect(controller.feedback).toEqual({ kind: "success", message: "Sources ready." });
  });

  it("reports a failed background index refresh and stops waiting for the source", async () => {
    api.refreshIndex.mockResolvedValueOnce({ ...indexed, error: "Index database is locked." });

    await act(async () => controller.update({ includeHermes: true }));
    await advance(120);

    expect(reloadSessions).not.toHaveBeenCalled();
    expect(filterValues()).toContain("hermes");
    expect(controller.feedback).toEqual({ kind: "error", message: "Index database is locked." });
  });

  it("applies imported settings and environments before returning the V1 import result", async () => {
    const result: V1ImportResult = {
      sourcePath: "v1",
      importedSessions: 2,
      skippedSessions: 0,
      failedSessions: 0,
      importedEnvironments: 1,
      importedSyncBindings: 0,
      importedSettings: 3,
    };
    const environments = [{ id: "ssh:box", kind: "ssh", label: "box" } as SessionEnvironment];
    api.importV1Data.mockResolvedValueOnce(result);
    api.getSettings.mockResolvedValueOnce({ ...initialSettings, evalEnabled: true });
    api.listEnvironments.mockResolvedValueOnce(environments);

    let returned: V1ImportResult | undefined;
    await act(async () => {
      returned = await controller.importV1Data();
    });

    expect(returned).toBe(result);
    expect(controller.settings?.evalEnabled).toBe(true);
    expect(setEnvironments).toHaveBeenCalledWith(environments);
    expect(reloadSessions).toHaveBeenCalledOnce();
    expect(invalidateRemoteSessions).toHaveBeenCalledOnce();
    expect(refreshSessionHookStatus).toHaveBeenCalledOnce();
  });

  it("reports and rethrows when a written Codex profile cannot be saved in the app settings", async () => {
    api.applyCodexProfile.mockResolvedValueOnce({ profile: "custom", configTarget: "config.toml" } as ApplyCodexProfileResult);
    api.setSettings.mockRejectedValueOnce(new Error("Settings file is read-only."));
    const message = "Client configuration was written, but saving app settings failed: Settings file is read-only.";

    await act(async () => {
      await expect(controller.applyCodexProfile(defaultApiConfig)).rejects.toThrow(message);
    });

    expect(controller.feedback).toEqual({ kind: "error", message });
  });

  it("confirms an applied Claude profile and saves it in the app settings", async () => {
    api.applyClaudeProfile.mockResolvedValueOnce({ profile: "custom", settingsPath: "settings.json" } as ApplyClaudeProfileResult);

    await act(async () => controller.applyClaudeProfile(defaultClaudeApiConfig));

    expect(api.setSettings).toHaveBeenCalledWith({ claudeApiConfig: defaultClaudeApiConfig });
    expect(controller.settings?.claudeApiConfig).toEqual(defaultClaudeApiConfig);
    expect(controller.feedback).toEqual({ kind: "success", message: "Applied and verified Custom Claude at settings.json." });
    await advance(2200);
    expect(controller.feedback).toBeNull();
  });
});
