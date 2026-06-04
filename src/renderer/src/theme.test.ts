import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readStoredLanguage } from "./language";
import { readStoredTheme } from "./theme";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("theme storage", () => {
  it("defaults to light when no theme is stored", () => {
    expect(readStoredTheme(null)).toBe("light");
  });

  it("keeps dark only when dark is explicitly stored", () => {
    expect(readStoredTheme("dark")).toBe("dark");
    expect(readStoredTheme("light")).toBe("light");
    expect(readStoredTheme("system")).toBe("light");
  });
});

describe("language storage", () => {
  it("defaults to English and keeps explicit Chinese", () => {
    expect(readStoredLanguage(null)).toBe("en");
    expect(readStoredLanguage("en")).toBe("en");
    expect(readStoredLanguage("zh")).toBe("zh");
    expect(readStoredLanguage("system")).toBe("en");
  });
});

describe("theme controls", () => {
  it("keeps light and dark mode selection inside settings", () => {
    const toolbar = appSource.slice(
      appSource.indexOf('<header className="toolbar">'),
      appSource.indexOf('<div className="result-count">'),
    );
    const settingsDialog = appSource.slice(appSource.indexOf("function SettingsDialog"), appSource.indexOf("function DeleteTagDialog"));

    expect(toolbar).not.toContain("setTheme");
    expect(settingsDialog).toContain("theme-setting-toggle");
    expect(settingsDialog).toContain("onThemeChange");
    expect(settingsDialog).toMatch(/Appearance/);
  });

  it("keeps language selection inside settings", () => {
    const settingsDialog = appSource.slice(appSource.indexOf("function SettingsDialog"), appSource.indexOf("function DeleteTagDialog"));

    expect(settingsDialog).toContain("language-setting-toggle");
    expect(settingsDialog).toContain("onLanguageChange");
    expect(settingsDialog).toMatch(/Language/);
  });

  it("keeps API configuration beside Skills instead of inside settings", () => {
    const toolbarActions = appSource.slice(appSource.indexOf('<div className="top-actions">'), appSource.indexOf("</header>"));
    const apiDialog = appSource.slice(appSource.indexOf("function ApiConfigDialog"), appSource.indexOf("function SettingsDialog"));
    const settingsDialog = appSource.slice(appSource.indexOf("function SettingsDialog"), appSource.indexOf("function DeleteTagDialog"));

    expect(toolbarActions).toContain("setApiConfigOpen(true)");
    expect(toolbarActions).toContain("PackageSearch");
    expect(toolbarActions).toContain("KeyRound");
    expect(settingsDialog).not.toContain("api-settings-form");
    expect(settingsDialog).not.toContain('activeSection === "api"');
    expect(apiDialog).toContain("api-settings-form");
    expect(apiDialog).toContain("apiConfig");
    expect(apiDialog).toContain("claudeApiConfig");
    expect(apiDialog).toMatch(/Codex Official/);
    expect(apiDialog).toMatch(/Claude Official/);
    expect(apiDialog).toMatch(/Claude Code providers/);
    expect(apiDialog).toMatch(/Custom/);
    expect(apiDialog).toMatch(/CodexZH/);
    expect(apiDialog).toMatch(/DeepSeek/);
    expect(apiDialog).toMatch(/GLM/);
    expect(apiDialog).toMatch(/LongCat/);
    expect(apiDialog).toMatch(/Kimi/);
    expect(apiDialog).toMatch(/MiMo/);
    expect(apiDialog).toMatch(/API configuration/);
    expect(apiDialog).toMatch(/Base URL/);
    expect(apiDialog).toMatch(/API Key/);
    expect(apiDialog).toMatch(/Model/);
  });

  it("edits API configuration as a local draft before saving", () => {
    const apiDialog = appSource.slice(appSource.indexOf("function ApiConfigDialog"), appSource.indexOf("function SettingsDialog"));

    expect(apiDialog).toContain("draftApiConfig");
    expect(apiDialog).toContain("setDraftApiConfig");
    expect(apiDialog).toContain("draftClaudeApiConfig");
    expect(apiDialog).toContain("setDraftClaudeApiConfig");
    expect(apiDialog).toContain("selectApiPreset");
    expect(apiDialog).toContain("selectClaudeApiPreset");
    expect(apiDialog).toContain("onSettingsChange({ apiConfig: draftApiConfig })");
    expect(apiDialog).toContain("onSettingsChange({ claudeApiConfig: draftClaudeApiConfig })");
    expect(apiDialog).toContain("onApplyToCodex(draftApiConfig)");
    expect(apiDialog).toContain("onApplyToClaude(draftClaudeApiConfig)");
    expect(apiDialog).toMatch(/Apply to Codex/);
    expect(apiDialog).toMatch(/Apply to Claude Code/);
    expect(apiDialog).toMatch(/Save/);
  });

  it("lets API keys be revealed without changing the saved value", () => {
    const apiDialog = appSource.slice(appSource.indexOf("function ApiConfigDialog"), appSource.indexOf("function SettingsDialog"));

    expect(apiDialog).toContain("showCodexApiKey");
    expect(apiDialog).toContain("showClaudeApiKey");
    expect(apiDialog).toContain('type={showCodexApiKey ? "text" : "password"}');
    expect(apiDialog).toContain('type={showClaudeApiKey ? "text" : "password"}');
    expect(apiDialog).toContain("setShowCodexApiKey");
    expect(apiDialog).toContain("setShowClaudeApiKey");
  });

  it("loads saved API keys when switching provider presets", () => {
    const apiDialog = appSource.slice(appSource.indexOf("function ApiConfigDialog"), appSource.indexOf("function SettingsDialog"));
    const selectApiPreset = apiDialog.slice(apiDialog.indexOf("const selectApiPreset"), apiDialog.indexOf("const selectClaudeApiPreset"));
    const selectClaudeApiPreset = apiDialog.slice(apiDialog.indexOf("const selectClaudeApiPreset"), apiDialog.indexOf("useEffect"));

    expect(selectApiPreset).toContain('getApiProviderKey("codex", preset.id)');
    expect(selectApiPreset).toContain("customApiKey: apiKey");
    expect(selectClaudeApiPreset).toContain('getApiProviderKey("claude", preset.id)');
    expect(selectClaudeApiPreset).toContain("customApiKey: apiKey");
  });

  it("opens settings with the standard preferences shortcut", () => {
    expect(appSource).toContain('event.key === ","');
    expect(appSource).toContain("setSettingsOpen(true)");
  });
});
