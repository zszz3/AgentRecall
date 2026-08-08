// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../../../core/platform";
import { ProviderPage } from "./provider-page";

describe("ProviderPage summary settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: {
        getCodexConfig: vi.fn(async () => ({
          exists: false,
          configPath: "C:\\tmp\\codex\\config.toml",
          activeProviderId: "openai",
          activeModel: "",
          availableModels: [],
          providers: [],
        })),
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("keeps a saved summary API key when Codex also uses a custom provider", async () => {
    const onSettingsChange = vi.fn();
    const settings = {
      ...defaultSettings,
      summarySource: "custom" as const,
      apiConfig: {
        ...defaultSettings.apiConfig,
        activeProvider: "custom" as const,
        customProviderId: "custom" as const,
        customBaseUrl: "https://codex.example/v1",
        customApiKey: "codex-key",
        customModel: "codex-model",
      },
      summaryApiConfig: {
        ...defaultSettings.summaryApiConfig,
        activeProvider: "custom" as const,
        customProviderId: "custom" as const,
        customBaseUrl: "https://summary.example/v1",
        customApiKey: "summary-key",
        customModel: "summary-model",
      },
    };

    await act(async () => root.render(
      <ProviderPage
        settings={settings}
        language="en"
        feedback={null}
        onSettingsChange={onSettingsChange}
        onApplyToCodex={vi.fn()}
        onApplyToClaude={vi.fn()}
      />,
    ));
    const summaryTab = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("AI Summary & Search"));
    expect(summaryTab).toBeDefined();
    await act(async () => summaryTab!.click());

    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(keyInput?.value).toBe("summary-key");
    expect(container.querySelector<HTMLInputElement>('input[placeholder="https://api.deepseek.com"]')?.value)
      .toBe("https://summary.example/v1");
    expect(container.querySelector<HTMLInputElement>('input[placeholder="deepseek-v4-flash"]')?.value)
      .toBe("summary-model");

    const formatSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Summary API format"]');
    expect(formatSelect?.value).toBe("openai_responses");
    await act(async () => {
      formatSelect!.value = "openai_chat";
      formatSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const saveButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Save summary settings"));
    expect(saveButton).toBeDefined();
    await act(async () => saveButton!.click());
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      summaryApiConfig: expect.objectContaining({ customApiFormat: "openai_chat" }),
    }));
  });
});
