import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readStoredLanguage } from "./language";
import { readStoredTheme } from "./theme";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const apiConfigDialogSource = readFileSync(new URL("./features/providers/provider-page.tsx", import.meta.url), "utf8");
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
  it("offers a persisted subagent visibility toggle in settings", () => {
    const settingsDialog = settingsSource;
    expect(settingsDialog).toContain("Hide subagent sessions");
    expect(settingsDialog).toContain("隐藏 Subagent 会话");
    expect(settingsDialog).toContain("checked={Boolean(settings?.hideSubagentSessions)}");
    expect(settingsDialog).toContain("onSettingsChange({ hideSubagentSessions: event.currentTarget.checked })");
  });

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

  it("uses the global navigation as the only Settings entry on the sessions page", () => {
    const toolbar = appSource.slice(
      appSource.indexOf('<header className="toolbar">'),
      appSource.indexOf('<div className="result-count">'),
    );

    expect(toolbar).not.toContain('<Settings size={15} />');
    expect(toolbar).not.toContain('t("Settings", "设置")');
  });

  it("keeps language selection inside settings", () => {
    const settingsDialog = settingsSource;

    expect(settingsDialog).toContain("language-setting-toggle");
    expect(settingsDialog).toContain("onLanguageChange");
    expect(settingsDialog).toMatch(/Language/);
  });

  it("keeps API configuration in the Provider page instead of the session tools or settings", () => {
    const toolbarStart = appSource.indexOf('<div className="top-actions">');
    const toolbarActions = appSource.slice(toolbarStart, appSource.indexOf("</header>", toolbarStart));
    const apiDialog = apiConfigDialogSource;
    const settingsDialog = settingsSource;

    expect(toolbarActions).not.toContain("setApiConfigOpen(true)");
    expect(toolbarActions).not.toContain("KeyRound");
    expect(appSource).toContain('data-page="providers"');
    expect(appSource).toContain("<ProviderPage");
    expect(appSource).toContain("PackageSearch");
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
    expect(apiDialog).toContain('className="provider-page"');
    expect(apiDialog).toMatch(/Base URL/);
    expect(apiDialog).toMatch(/API Key/);
    expect(apiDialog).toMatch(/Model/);
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
    // Saving a configured Custom Codex/Claude provider must also drive summary/search.
    expect(apiDialog).toContain("summaryFromCustomCodex(next, draftSummaryApiConfig)");
    expect(apiDialog).toContain("summaryFromCustomClaude(draftClaudeApiConfig, draftSummaryApiConfig)");
    expect(apiDialog).toContain("onApplyToCodex(next)");
    expect(apiDialog).toContain("onApplyToClaude(draftClaudeApiConfig)");
    expect(apiDialog).toMatch(/Write to Codex config/);
    expect(apiDialog).toMatch(/Write to Claude Code settings/);
    expect(apiDialog).toMatch(/Save in app only/);
    expect(apiDialog).toMatch(/Save summary settings/);
  });

  it("visualizes Codex config.toml and merges model detection into the model field", () => {
    const apiDialog = apiConfigDialogSource;

    expect(apiDialog).toContain("codex-config-visualizer");
    expect(apiDialog).toContain("getCodexConfig");
    expect(apiDialog).toContain("probeCodexModels");
    expect(apiDialog).toContain("Detect models");
    expect(apiDialog).toContain("codex-model-detect-button");
    expect(apiDialog).toContain("selectedCodexConfigProviderId");
    expect(apiDialog).toContain("hydrateDraftFromCodexConfig");
    expect(apiDialog).toContain("Config provider");
    expect(apiDialog).toContain('customProviderId: "custom"');
    expect(apiDialog).toContain('data-provider-labels="Codex Official CodexZH DeepSeek GLM LongCat Kimi MiMo Custom"');
    // The model input pairs a free-text field with a custom dropdown of detected models
    // that always shows every option regardless of the current input value.
    expect(apiDialog).toContain("codex-model-combo");
    expect(apiDialog).toContain("codex-model-menu");
    expect(apiDialog).toContain("codex-model-option");
    expect(apiDialog).toContain("codexModelOptions.map");
    expect(apiDialog).toContain("codexModelMenuOpen");
    expect(apiDialog).not.toContain('list="codex-model-options"');
    expect(apiDialog).not.toContain("<datalist");
    // The separate detected-model select and its conflict resolver were removed in the merge.
    expect(apiDialog).not.toContain("selectedDetectedCodexModel");
    expect(apiDialog).not.toContain("codexModelConflict");
    expect(apiDialog).not.toContain("codex-model-conflict");
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

  it("hydrates summary custom draft from local Codex first, then Claude", () => {
    const apiDialog = apiConfigDialogSource;

    expect(apiDialog).toContain("function buildSummaryDraftFromSettings");
    expect(apiDialog).toContain("function buildSummarySourceFromSettings");
    expect(apiDialog).toContain('summaryFromCustomCodex(settings?.apiConfig, base)');
    expect(apiDialog).toContain('summaryFromCustomClaude(settings?.claudeApiConfig, base)');
    expect(apiDialog).toContain('...codex');
    expect(apiDialog).toContain('customProviderId: "custom"');
    expect(apiDialog).toContain('setDraftSummaryApiConfig(buildSummaryDraftFromSettings(settings))');
    expect(apiDialog).toContain('setDraftSummarySource(buildSummarySourceFromSettings(settings))');
    expect(apiDialog).toContain("优先使用当前本机 Codex 配置");
    expect(apiDialog).toContain("回退到当前本机 Claude 配置");
    expect(apiDialog).toContain("api-provider-switch--compact");
  });

  it("keeps unknown Codex providers as Custom instead of forcing CodexZH", () => {
    const apiConfigSource = readFileSync(new URL("../../core/api-config.ts", import.meta.url), "utf8");

    expect(apiConfigSource).toContain('return API_PROVIDER_PRESETS.some((preset) => preset.id === value) ? (value as ApiProviderPresetId) : "custom";');
    expect(apiConfigSource).not.toContain('return API_PROVIDER_PRESETS.some((preset) => preset.id === value) ? (value as ApiProviderPresetId) : "codexzh";');
  });

  it("opens settings with the standard preferences shortcut", () => {
    expect(appSource).toContain('event.key === ","');
    expect(appSource).toContain("setSettingsOpen(true)");
  });
});
