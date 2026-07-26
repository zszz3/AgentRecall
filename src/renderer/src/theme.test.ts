import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readStoredLanguage } from "./language";
import { readStoredTheme } from "./theme";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const apiConfigDialogSource = readFileSync(new URL("./features/providers/api-config-dialog.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./features/settings/settings-dialog.tsx", import.meta.url), "utf8");

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
  it("defaults to Chinese and keeps an explicit language choice", () => {
    expect(readStoredLanguage(null)).toBe("zh");
    expect(readStoredLanguage("en")).toBe("en");
    expect(readStoredLanguage("zh")).toBe("zh");
    expect(readStoredLanguage("system")).toBe("zh");
  });
});

describe("theme controls", () => {
  it("keeps light and dark mode selection inside settings", () => {
    const toolbar = appSource.slice(
      appSource.indexOf('<header className="toolbar">'),
      appSource.indexOf('<div className="result-count">'),
    );
    const settingsDialog = settingsSource;

    expect(toolbar).not.toContain("setTheme");
    expect(settingsDialog).toContain("theme-setting-toggle");
    expect(settingsDialog).toContain("onThemeChange");
    expect(settingsDialog).toMatch(/Appearance/);
  });

  it("keeps language selection inside settings", () => {
    const settingsDialog = settingsSource;

    expect(settingsDialog).toContain("language-setting-toggle");
    expect(settingsDialog).toContain("onLanguageChange");
    expect(settingsDialog).toMatch(/Language/);
  });

  it("keeps advanced provider and Skills controls out of the 1.0 toolbar", () => {
    const toolbarStart = appSource.indexOf('<div className="top-actions">');
    const toolbarActions = appSource.slice(toolbarStart, appSource.indexOf("</header>", toolbarStart));
    expect(toolbarActions).toContain('setInfoSection("settings")');
    expect(toolbarActions).toContain('setInfoSection("about")');
    expect(toolbarActions).toContain('setInfoSection("diagnostics")');
    expect(toolbarActions).not.toContain("PackageSearch");
    expect(toolbarActions).not.toContain("KeyRound");
    expect(appSource).not.toContain("ApiConfigDialog");
    expect(appSource).not.toContain("SkillsDialog");
  });

  it("edits API configuration as a local draft before saving", () => {
    const apiDialog = apiConfigDialogSource;

    expect(apiDialog).toContain("draftApiConfig");
    expect(apiDialog).toContain("setDraftApiConfig");
    expect(apiDialog).toContain("draftClaudeApiConfig");
    expect(apiDialog).toContain("setDraftClaudeApiConfig");
    expect(apiDialog).toContain("draftSummarySource");
    expect(apiDialog).toContain("selectApiPreset");
    expect(apiDialog).toContain("selectClaudeApiPreset");
    expect(apiDialog).toContain("selectSummaryPreset");
    expect(apiDialog).toContain("onSettingsChange({ apiConfig: next })");
    expect(apiDialog).toContain("onSettingsChange({ claudeApiConfig: draftClaudeApiConfig })");
    expect(apiDialog).toContain("onSettingsChange({ summarySource: draftSummarySource, summaryApiConfig: draftSummaryApiConfig })");
    expect(apiDialog).toContain("onApplyToCodex(next)");
    expect(apiDialog).toContain("onApplyToClaude(draftClaudeApiConfig)");
    expect(apiDialog).toMatch(/Write to Codex config/);
    expect(apiDialog).toMatch(/Write to Claude Code settings/);
    expect(apiDialog).toMatch(/Save in app only/);
    expect(apiDialog).toMatch(/Save summary settings/);
  });

  it("omits CodexZH from direct AI summary API providers", () => {
    const summarySection = apiConfigDialogSource.slice(apiConfigDialogSource.indexOf("AI summary & search source"));

    expect(apiConfigDialogSource).toContain('preset.id !== "codexzh"');
    expect(apiConfigDialogSource).not.toContain('preset.id !== "custom" && preset.id !== "codexzh"');
    expect(summarySection).toContain("SUMMARY_API_PROVIDER_PRESETS.map");
    expect(summarySection).toContain("summary-provider-switch");
    expect(summarySection).toContain('activeSummarySource === "custom"');
    expect(summarySection).not.toMatch(/CodexZH/);
  });

  it("lets API keys be revealed without changing the saved value", () => {
    const apiDialog = apiConfigDialogSource;

    expect(apiDialog).toContain("showCodexApiKey");
    expect(apiDialog).toContain("showClaudeApiKey");
    expect(apiDialog).toContain('type={showCodexApiKey ? "text" : "password"}');
    expect(apiDialog).toContain('type={showClaudeApiKey ? "text" : "password"}');
    expect(apiDialog).toContain("setShowCodexApiKey");
    expect(apiDialog).toContain("setShowClaudeApiKey");
  });

  it("loads saved API keys when switching provider presets", () => {
    const apiDialog = apiConfigDialogSource;
    const selectApiPreset = apiDialog.slice(apiDialog.indexOf("const selectApiPreset"), apiDialog.indexOf("const selectClaudeApiPreset"));
    const selectClaudeApiPresetStart = apiDialog.indexOf("const selectClaudeApiPreset");
    const selectClaudeApiPreset = apiDialog.slice(selectClaudeApiPresetStart, apiDialog.indexOf("  useEffect", selectClaudeApiPresetStart));
    const selectSummaryPresetStart = apiDialog.indexOf("const selectSummaryPreset");
    const selectSummaryPreset = apiDialog.slice(selectSummaryPresetStart, apiDialog.indexOf("  useEffect", selectSummaryPresetStart));

    expect(selectApiPreset).toContain('getApiProviderKey("codex", preset.id)');
    expect(selectApiPreset).toContain("customApiKey: apiKey");
    expect(selectClaudeApiPreset).toContain('getApiProviderKey("claude", preset.id)');
    expect(selectClaudeApiPreset).toContain("customApiKey: apiKey");
    expect(selectSummaryPreset).toContain('getApiProviderKey("summary", preset.id)');
    expect(selectSummaryPreset).not.toContain("onSettingsChange({ summarySource: \"custom\", summaryApiConfig: next })");
  });

  it("keeps unknown Codex providers as Custom instead of forcing CodexZH", () => {
    const apiConfigSource = readFileSync(new URL("../../core/api-config.ts", import.meta.url), "utf8");

    expect(apiConfigSource).toContain('return API_PROVIDER_PRESETS.some((preset) => preset.id === value) ? (value as ApiProviderPresetId) : "custom";');
    expect(apiConfigSource).not.toContain('return API_PROVIDER_PRESETS.some((preset) => preset.id === value) ? (value as ApiProviderPresetId) : "codexzh";');
  });

  it("opens settings with the standard preferences shortcut", () => {
    expect(appSource).toContain('event.key === ","');
    expect(appSource).toContain('setInfoSection("settings")');
  });
});
