// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../../../core/platform";
import type { V1ImportResult } from "../../../../core/v1-import";
import { SettingsDialog } from "./settings-dialog";

describe("SettingsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { onSummaryProgress: () => () => undefined },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps a running V1 import disabled after switching sections and shows its result on return", async () => {
    let finishImport: (result: V1ImportResult) => void = () => undefined;
    const onImportV1 = vi.fn(() => new Promise<V1ImportResult>((resolve) => { finishImport = resolve; }));
    await act(async () => root.render(createElement(SettingsDialog, {
      platform: "darwin",
      initialSection: "about",
      settings: defaultSettings,
      appUpdateStatus: null,
      appUpdateProgress: null,
      appUpdateBusy: false,
      appUpdateError: null,
      environments: [],
      environmentHealthReports: {},
      diagnosingEnvironmentId: null,
      theme: "light",
      language: "en",
      messageFontSize: "medium",
      feedback: null,
      onSettingsChange: async () => undefined,
      onCheckAppUpdate: vi.fn(),
      onInstallAppUpdate: vi.fn(),
      onSkipAppUpdate: vi.fn(),
      onThemeChange: vi.fn(),
      onLanguageChange: vi.fn(),
      onMessageFontSizeChange: vi.fn(),
      sessionHookStatus: null,
      sessionHookBusy: false,
      onSessionHookChange: vi.fn(),
      onRefreshEnvironment: vi.fn(),
      onDiagnoseEnvironment: vi.fn(),
      onDeleteEnvironment: vi.fn(),
      onAddSsh: vi.fn(),
      onImportV1,
      onOpenApiConfig: vi.fn(),
      onOpenAgentModel: vi.fn(),
      onOpenRemoteSessions: vi.fn(),
      onClose: vi.fn(),
    })));
    const navigate = async (label: string) => {
      const button = [...container.querySelectorAll<HTMLButtonElement>(".settings-sidebar button")]
        .find((element) => element.textContent === label);
      await act(async () => button?.click());
    };
    const importButton = () => container.querySelector<HTMLButtonElement>(".v1-import-button");

    await act(async () => importButton()?.click());
    await navigate("Default terminal");
    await navigate("About");

    expect(importButton()?.disabled).toBe(true);
    expect(importButton()?.textContent).toBe("Importing...");

    await act(async () => finishImport({
      sourcePath: "/v1",
      importedSessions: 2,
      skippedSessions: 1,
      failedSessions: 0,
      importedEnvironments: 0,
      importedSyncBindings: 0,
      importedSettings: 1,
    }));

    expect(onImportV1).toHaveBeenCalledTimes(1);
    expect(importButton()?.disabled).toBe(false);
    expect(container.querySelector(".v1-import-result.success")?.textContent)
      .toContain("Imported 2 cached sessions; kept 1 existing V2 sessions.");
  });

  it("shows Dynamic Island disabled by default in Appearance settings and lets the user enable it", async () => {
    const onSettingsChange = vi.fn(async () => undefined);
    await act(async () => root.render(createElement(SettingsDialog, {
      platform: "darwin",
      initialSection: "appearance",
      settings: defaultSettings,
      appUpdateStatus: null,
      appUpdateProgress: null,
      appUpdateBusy: false,
      appUpdateError: null,
      environments: [],
      environmentHealthReports: {},
      diagnosingEnvironmentId: null,
      theme: "light",
      language: "zh",
      messageFontSize: "medium",
      feedback: null,
      onSettingsChange,
      onCheckAppUpdate: vi.fn(),
      onInstallAppUpdate: vi.fn(),
      onSkipAppUpdate: vi.fn(),
      onThemeChange: vi.fn(),
      onLanguageChange: vi.fn(),
      onMessageFontSizeChange: vi.fn(),
      sessionHookStatus: null,
      sessionHookBusy: false,
      onSessionHookChange: vi.fn(),
      onRefreshEnvironment: vi.fn(),
      onDiagnoseEnvironment: vi.fn(),
      onDeleteEnvironment: vi.fn(),
      onAddSsh: vi.fn(),
      onImportV1: vi.fn(),
      onOpenApiConfig: vi.fn(),
      onOpenAgentModel: vi.fn(),
      onOpenRemoteSessions: vi.fn(),
      onClose: vi.fn(),
    })));

    const toggles = [...container.querySelectorAll<HTMLInputElement>(".settings-toggle input.switch")];
    const islandToggle = toggles.find((input) => input.closest(".settings-toggle")?.textContent?.includes("灵动岛任务提醒"));
    const soundToggle = toggles.find((input) => input.closest(".settings-toggle")?.textContent?.includes("完成提示音"));
    expect(islandToggle?.checked).toBe(false);
    expect(soundToggle?.disabled).toBe(true);

    await act(async () => islandToggle?.click());
    expect(onSettingsChange).toHaveBeenCalledWith({ islandEnabled: true });
  });
});
