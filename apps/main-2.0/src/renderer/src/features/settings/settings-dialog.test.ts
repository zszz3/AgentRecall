import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsDialog } from "./settings-dialog";

const noop = () => undefined;

function renderShortcuts(): string {
  return renderToStaticMarkup(createElement(SettingsDialog, {
    platform: "darwin",
    initialSection: "shortcut",
    settings: null,
    runtimeChannels: [],
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

describe("SettingsDialog shortcut reference", () => {
  it("shows Command+F as the main search focus shortcut", () => {
    const html = renderShortcuts();
    const focusSearchRow = html.match(/<div class="shortcut-reference-row"><dt>聚焦搜索<\/dt><dd>.*?<\/dd><\/div>/)?.[0];

    expect(focusSearchRow).toContain("<kbd>⌘</kbd>");
    expect(focusSearchRow).toContain("<kbd>F</kbd>");
    expect(focusSearchRow).not.toContain("<kbd>K</kbd>");
  });
});
