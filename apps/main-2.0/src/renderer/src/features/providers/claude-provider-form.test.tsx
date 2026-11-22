// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../../core/platform";
import { ClaudeProviderForm } from "./claude-provider-form";

function claudeSnapshot() {
  return {
    claudeHome: "/tmp/claude",
    settingsPath: "/tmp/claude/settings.json",
    exists: true,
    route: { customBaseUrl: "https://api.anthropic.com", customApiFormat: "anthropic" as const },
    credentialSource: "settings.json",
    hasApiKey: true,
  };
}

/**
 * React installs its own `value` setter to track changes, so assigning `input.value` directly
 * makes it treat the following event as a no-op. Going through the prototype setter is what
 * makes the typed value reach the component.
 */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The input of the form field with this title. */
function fieldInput(container: HTMLElement, title: string): HTMLInputElement {
  const field = [...container.querySelectorAll<HTMLElement>(".settings-field")]
    .find((row) => row.querySelector(".settings-field-title")?.textContent === title);
  return field!.querySelector<HTMLInputElement>("input")!;
}

describe("ClaudeProviderForm", () => {
  let container: HTMLDivElement;
  let root: Root;
  let testProviderConnection: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    testProviderConnection = vi.fn(async () => ({ elapsedMs: 1, credentialSource: "test credential" }));
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: {
        getClaudeConfig: vi.fn(async () => claudeSnapshot()),
        pickConfigDirectory: vi.fn(async () => ""),
        probeClaudeModels: vi.fn(async () => ({ models: [], endpoint: "", endpoints: [], credentialSource: "" })),
        testProviderConnection,
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function mountForm(settings = structuredClone(defaultSettings)): Promise<void> {
    await act(async () => root.render(createElement(ClaudeProviderForm, {
      settings,
      language: "en" as const,
      feedback: null,
      onSettingsChange: vi.fn(),
    })));
  }

  it("exposes the entire configuration path in its title", async () => {
    await mountForm();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(container.querySelector('.codex-config-visualizer strong[title]')?.getAttribute('title'))
      .toBe('/tmp/claude/settings.json');
  });

  it("tests the full Claude draft, reports errors, and clears stale results after edits", async () => {
    const settings = structuredClone(defaultSettings);
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "deepseek",
      customProviderName: "DeepSeek",
      customBaseUrl: "https://claude.example/anthropic",
      customApiKey: "typed-key",
      customModel: "claude-test-model",
      customApiFormat: "anthropic",
      customApiKeyField: "ANTHROPIC_AUTH_TOKEN",
    };
    testProviderConnection.mockRejectedValueOnce(new Error("Claude runtime rejected the credential"));
    await mountForm(settings);
    const button = container.querySelector<HTMLButtonElement>('[data-provider-connection-test="claude"]');

    expect(button?.textContent).toContain("Test connection");
    await act(async () => button?.click());

    expect(testProviderConnection).toHaveBeenCalledWith({
      target: "claude",
      apiConfig: settings.claudeApiConfig,
    });
    expect(container.textContent).toContain("Claude runtime rejected the credential");

    await typeInto(fieldInput(container, "Base URL"), "https://changed.example/anthropic");

    expect(container.textContent).not.toContain("Claude runtime rejected the credential");
    expect(button?.disabled).toBe(false);
  });

  it("clears the saved key when the manual Base URL changes and requires a new one", async () => {
    const settings = structuredClone(defaultSettings);
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "custom",
      customProviderName: "Custom Claude",
      customBaseUrl: "https://old-claude.example/anthropic",
      customApiKey: "saved-claude-key",
      customModel: "claude-test",
    };
    await mountForm(settings);
    const key = fieldInput(container, "API Key");
    expect(key.value).toBe("saved-claude-key");

    await typeInto(fieldInput(container, "Base URL"), "https://new-claude.example/anthropic");

    expect(key.value).toBe("");
    const detect = container.querySelector<HTMLButtonElement>(".codex-model-detect-button")!;
    await act(async () => detect.click());
    expect(window.sessionSearch.probeClaudeModels).not.toHaveBeenCalled();
    expect(detect.closest(".settings-field")?.querySelector(".api-config-status.error")?.textContent)
      .toBe("Enter this provider's API key before detecting models.");
    const test = container.querySelector<HTMLButtonElement>('[data-provider-connection-test="claude"]')!;
    await act(async () => test.click());
    expect(testProviderConnection).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter this provider's API key before testing.");

    await typeInto(key, "new-claude-key");
    await act(async () => detect.click());
    expect(window.sessionSearch.probeClaudeModels).toHaveBeenLastCalledWith(expect.objectContaining({
      baseUrl: "https://new-claude.example/anthropic",
      apiKey: "new-claude-key",
      providerId: "custom",
    }));
    await act(async () => test.click());
    expect(testProviderConnection).toHaveBeenLastCalledWith({
      target: "claude",
      apiConfig: expect.objectContaining({
        customBaseUrl: "https://new-claude.example/anthropic",
        customApiKey: "new-claude-key",
      }),
    });
  });
});
