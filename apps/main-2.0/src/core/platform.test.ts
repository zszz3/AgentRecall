import { describe, expect, it } from "vitest";
import { defaultSettings, mergeAppSettings } from "./platform";

describe("app settings", () => {
  it("keeps WorkBuddy indexing opt-in while accepting an explicit enable", () => {
    expect(defaultSettings.includeWorkBuddy).toBe(false);
    expect(mergeAppSettings(defaultSettings, { includeWorkBuddy: true }).includeWorkBuddy).toBe(true);
  });

  it("keeps DeepSeek Harness indexing opt-in while accepting an explicit enable", () => {
    expect(defaultSettings.includeDeepSeekHarness).toBe(false);
    expect(mergeAppSettings(defaultSettings, { includeDeepSeekHarness: true }).includeDeepSeekHarness).toBe(true);
  });

  it("starts every summary source on the machine's own config directory", () => {
    expect(defaultSettings.summarySource).toBe("codex");
    expect(defaultSettings.summaryCodexConfigDir).toBe("");
    expect(defaultSettings.summaryClaudeConfigDir).toBe("");
    expect(defaultSettings.summaryCodexModel).toBe("");
    expect(defaultSettings.summaryClaudeModel).toBe("");
  });

  it("keeps the Codex and Claude summary directories independent of each other", () => {
    const merged = mergeAppSettings(defaultSettings, { summaryClaudeConfigDir: "~/alt-claude" });
    expect(merged.summaryClaudeConfigDir).toBe("~/alt-claude");
    // Pointing the Claude source somewhere must not drag the Codex source along with it, or the
    // two sources stop being independent the moment the user switches between them.
    expect(merged.summaryCodexConfigDir).toBe("");
    expect(merged.apiConfig.customConfigDir).toBe(defaultSettings.apiConfig.customConfigDir);
    expect(merged.claudeApiConfig.customConfigDir).toBe(defaultSettings.claudeApiConfig.customConfigDir);
  });

  it("keeps an unrecognized reasoning effort out of the summary request", () => {
    expect(mergeAppSettings(defaultSettings, { summaryReasoningEffort: "high" }).summaryReasoningEffort)
      .toBe("high");
    // "" is the real "let the model decide" choice, so anything unknown has to land there rather
    // than on an arbitrary level the upstream may reject.
    expect(mergeAppSettings(defaultSettings, { summaryReasoningEffort: "" }).summaryReasoningEffort).toBe("");
    expect(
      mergeAppSettings(defaultSettings, { summaryReasoningEffort: "turbo" as never }).summaryReasoningEffort,
    ).toBe("");
  });

  it("adopts the OpenViking effort once so an existing install keeps the level it had", () => {
    const legacy = { ...defaultSettings, openVikingExtractionReasoningEffort: "ultra" as const };
    delete (legacy as Partial<typeof legacy>).summaryReasoningEffort;

    const merged = mergeAppSettings(legacy as typeof defaultSettings, {});

    expect(merged.summaryReasoningEffort).toBe("ultra");
    // Seeding is one-way: the two settings are separate features and must not track each other
    // afterwards, or changing the memory-extraction effort would silently rewrite summaries.
    expect(
      mergeAppSettings(merged, { openVikingExtractionReasoningEffort: "low" }).summaryReasoningEffort,
    ).toBe("ultra");
  });

  it("trims the summary directories so a stray space is not read as a custom path", () => {
    const merged = mergeAppSettings(defaultSettings, {
      summaryCodexConfigDir: "  ",
      summaryClaudeModel: "  claude-opus-4-8  ",
    });
    expect(merged.summaryCodexConfigDir).toBe("");
    expect(merged.summaryClaudeModel).toBe("claude-opus-4-8");
  });
});
