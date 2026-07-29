import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AppUpdateProgress, AppUpdateStatus } from "../../../../core/app-update-types";
import { SettingsDialog } from "./settings-dialog";

const noop = () => undefined;

function updateStatus(): AppUpdateStatus {
  return {
    currentVersion: "0.34.1",
    developmentBuild: false,
    checkedAt: Date.now(),
    fromCache: false,
    updateAvailable: true,
    manifest: {
      schemaVersion: 1,
      version: "0.34.2",
      tag: "v0.34.2",
      title: "v0.34.2",
      publishedAt: "2026-07-28T00:00:00.000Z",
      releaseUrl: "https://example.com/release",
      notes: { features: [], fixes: ["Stops failed updates."] },
      package: {
        name: "agent-recall.tgz",
        url: "https://example.com/agent-recall.tgz",
        sha256: "a".repeat(64),
        checksumUrl: "https://example.com/checksums.txt",
      },
    },
    error: null,
  };
}

function renderUpdate(progress: AppUpdateProgress): string {
  return renderToStaticMarkup(createElement(SettingsDialog, {
    platform: "darwin",
    initialSection: "about",
    settings: null,
    appUpdateStatus: updateStatus(),
    appUpdateProgress: progress,
    appUpdateBusy: progress.phase !== "error" && progress.phase !== "completed",
    appUpdateError: progress.error ?? null,
    environments: [],
    environmentHealthReports: {},
    diagnosingEnvironmentId: null,
    theme: "light",
    language: "zh",
    feedback: null,
    onSettingsChange: noop,
    onCheckAppUpdate: noop,
    onInstallAppUpdate: noop,
    onSkipAppUpdate: noop,
    onThemeChange: noop,
    onLanguageChange: noop,
    onDefaultTerminalChange: noop,
    onGlobalShortcutChange: noop,
    skillHookInstalled: null,
    skillHookBusy: false,
    onSkillHookChange: noop,
    sessionHookStatus: null,
    sessionHookBusy: false,
    onSessionHookChange: noop,
    onRefreshEnvironment: noop,
    onDiagnoseEnvironment: noop,
    onDeleteEnvironment: noop,
    onAddSsh: noop,
    onOpenApiConfig: noop,
    onOpenRemoteSessions: noop,
    onClose: noop,
  }));
}

function renderShortcuts(): string {
  return renderToStaticMarkup(createElement(SettingsDialog, {
    platform: "darwin",
    initialSection: "shortcut",
    settings: null,
    appUpdateStatus: null,
    appUpdateProgress: null,
    appUpdateBusy: false,
    appUpdateError: null,
    environments: [],
    environmentHealthReports: {},
    diagnosingEnvironmentId: null,
    theme: "light",
    language: "zh",
    feedback: null,
    onSettingsChange: noop,
    onCheckAppUpdate: noop,
    onInstallAppUpdate: noop,
    onSkipAppUpdate: noop,
    onThemeChange: noop,
    onLanguageChange: noop,
    onDefaultTerminalChange: noop,
    onGlobalShortcutChange: noop,
    skillHookInstalled: null,
    skillHookBusy: false,
    onSkillHookChange: noop,
    sessionHookStatus: null,
    sessionHookBusy: false,
    onSessionHookChange: noop,
    onRefreshEnvironment: noop,
    onDiagnoseEnvironment: noop,
    onDeleteEnvironment: noop,
    onAddSsh: noop,
    onOpenApiConfig: noop,
    onOpenRemoteSessions: noop,
    onClose: noop,
  }));
}

describe("SettingsDialog app update state", () => {
  it("stops the progress animation and shows a terminal command after an update failure", () => {
    const html = renderUpdate({
      phase: "error",
      version: "0.34.2",
      error: "spawnSync npm ENOENT",
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain("自动更新已停止。请打开终端运行：");
    expect(html).toContain("<code>agent-recall --update</code>");
    expect(html).toContain("失败的更新不会在后台继续运行。");
    expect(html).toContain("spawnSync npm ENOENT");
    expect(html).not.toContain("update-progress-track");
  });

  it("keeps indeterminate progress while an update is still active", () => {
    const html = renderUpdate({
      phase: "staging",
      version: "0.34.2",
      message: "正在安装到临时目录…",
    });

    expect(html).toContain('role="status"');
    expect(html).toContain("update-progress-track indeterminate");
    expect(html).not.toContain("agent-recall --update");
  });

  it("does not restart the animation after the update reaches a completed state", () => {
    const html = renderUpdate({
      phase: "completed",
      version: "0.34.2",
    });

    expect(html).toContain("更新完成");
    expect(html).not.toContain("update-progress-track");
  });
});

describe("SettingsDialog shortcut reference", () => {
  it("shows Command+F as the main search focus shortcut", () => {
    const html = renderShortcuts();
    const focusSearchRow = html.match(/<div class="shortcut-reference-row"><dt>聚焦搜索<\/dt><dd>.*?<\/dd><\/div>/)?.[0];

    expect(focusSearchRow).toContain("<kbd>⌘</kbd>");
    expect(focusSearchRow).toContain("<kbd>F</kbd>");
    expect(focusSearchRow).not.toContain("<kbd>K</kbd>");
  });
});
