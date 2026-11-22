// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../../core/platform";
import { CodexProviderForm } from "./codex-provider-form";

function codexSnapshot() {
  return {
    codexHome: "/tmp/codex",
    configPath: "/tmp/codex/config.toml",
    exists: true,
    activeProviderId: "openai",
    activeModel: "gpt-5.6-sol",
    activeProvider: { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", wireApi: "responses" },
    providers: [],
    credentialSource: "auth.json",
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

async function chooseOption(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value;
  await act(async () => {
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** The select or input of the form field with this title. */
function fieldControl<T extends HTMLInputElement | HTMLSelectElement>(container: HTMLElement, title: string): T {
  const field = [...container.querySelectorAll<HTMLElement>(".settings-field")]
    .find((row) => row.querySelector(".settings-field-title")?.textContent === title);
  return field!.querySelector<T>("select, input")!;
}

function customRouteSettings(customApiKey: string) {
  const settings = structuredClone(defaultSettings);
  settings.apiConfig = { ...settings.apiConfig, activeProvider: "custom", customProviderId: "custom",
    customProviderName: "Custom Codex", customBaseUrl: "https://old-codex.example/v1", customApiKey, customModel: "gpt-test" };
  return settings;
}

describe("CodexProviderForm", () => {
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
        getCodexConfig: vi.fn(async () => codexSnapshot()),
        pickConfigDirectory: vi.fn(async () => ""),
        probeCodexModels: vi.fn(async () => ({ models: [], endpoint: "", endpoints: [], credentialSource: "" })),
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
    await act(async () => root.render(createElement(CodexProviderForm, {
      settings,
      language: "en" as const,
      feedback: null,
      onSettingsChange: vi.fn(),
    })));
  }

  it("selects and tests official models without custom route credentials", async () => {
    await mountForm(customRouteSettings("synthetic"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    await chooseOption(fieldControl<HTMLSelectElement>(container, "Preset"), "official");
    const model = container.querySelector<HTMLInputElement>(".codex-model-combo input")!;
    expect(model.value).toBe("gpt-5.6-sol");
    await typeInto(model, "gpt-6.1-sol");
    const detect = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Detect models")!;
    await act(async () => detect.click());
    expect(window.sessionSearch.probeCodexModels).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "", apiKey: "", providerId: "openai" }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-provider-connection-test="codex"]')!.click());
    expect(testProviderConnection).toHaveBeenCalledWith(expect.objectContaining({ target: "codex", apiConfig: expect.objectContaining({ activeProvider: "official", customModel: "gpt-6.1-sol" }) }));
  });

  it("exposes the entire configuration path when its summary is truncated", async () => {
    const configPath = "/tmp/" + "long-config-directory/".repeat(20) + "config.toml";
    const snapshot = codexSnapshot();
    vi.mocked(window.sessionSearch.getCodexConfig).mockResolvedValue({ ...snapshot, configPath,
      activeProvider: { ...snapshot.activeProvider, envKey: "", requiresOpenaiAuth: true,
        hasApiKey: false, credentialSource: "" },
    });
    await mountForm();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    const value = container.querySelector(".codex-config-visualizer strong[title]");
    expect(value?.textContent).toBe(configPath);
    expect(value?.getAttribute("title")).toBe(configPath);
  });

  it("keeps a complete long model-probe error in its own field after loading", async () => {
    const message = "Probe failed: " + "long-unbroken-diagnostic-".repeat(30);
    let rejectProbe!: (error: Error) => void;
    vi.mocked(window.sessionSearch.probeCodexModels).mockImplementation(() => new Promise((_resolve, reject) => { rejectProbe = reject; }));
    await mountForm(customRouteSettings("synthetic"));
    const button = container.querySelector<HTMLButtonElement>(".codex-model-detect-button")!;
    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    await act(async () => rejectProbe(new Error(message)));
    expect(button.disabled).toBe(false);
    const error = button.closest(".settings-field")?.querySelector(".api-config-status.error");
    expect(error?.textContent).toBe(message);
  });

  it("tests the current Codex draft and reports progress and success", async () => {
    let resolveConnection: ((result: { elapsedMs: number; credentialSource: string }) => void) | undefined;
    testProviderConnection.mockImplementationOnce(() => new Promise((resolve) => {
      resolveConnection = resolve;
    }));
    const settings = structuredClone(defaultSettings);
    await mountForm(settings);
    const button = container.querySelector<HTMLButtonElement>('[data-provider-connection-test="codex"]');

    expect(button?.textContent).toContain("Test connection");
    await act(async () => button?.click());

    expect(testProviderConnection).toHaveBeenCalledWith({
      target: "codex",
      apiConfig: settings.apiConfig,
    });
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain("Testing Codex connection...");

    await act(async () => resolveConnection?.({ elapsedMs: 42, credentialSource: "Codex auth.json" }));

    expect(button?.disabled).toBe(false);
    expect(container.textContent).toContain("Codex connection succeeded in 42 ms using Codex auth.json.");
  });

  it("clears the saved key when the manual Base URL changes and requires a new one", async () => {
    await mountForm(customRouteSettings("saved-codex-key"));
    const key = fieldControl<HTMLInputElement>(container, "API Key");
    expect(key.value).toBe("saved-codex-key");

    await typeInto(fieldControl<HTMLInputElement>(container, "Base URL"), "https://new-codex.example/v1");

    expect(key.value).toBe("");
    const detect = container.querySelector<HTMLButtonElement>(".codex-model-detect-button")!;
    await act(async () => detect.click());
    expect(window.sessionSearch.probeCodexModels).not.toHaveBeenCalled();
    expect(detect.closest(".settings-field")?.querySelector(".api-config-status.error")?.textContent)
      .toBe("Enter this provider's API key before detecting models.");
    const test = container.querySelector<HTMLButtonElement>('[data-provider-connection-test="codex"]')!;
    await act(async () => test.click());
    expect(testProviderConnection).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter this provider's API key before testing.");

    await typeInto(key, "new-codex-key");
    await act(async () => detect.click());
    expect(window.sessionSearch.probeCodexModels).toHaveBeenLastCalledWith(expect.objectContaining({
      baseUrl: "https://new-codex.example/v1",
      apiKey: "new-codex-key",
      providerId: "custom",
    }));
    await act(async () => test.click());
    expect(testProviderConnection).toHaveBeenLastCalledWith({
      target: "codex",
      apiConfig: expect.objectContaining({
        customBaseUrl: "https://new-codex.example/v1",
        customApiKey: "new-codex-key",
      }),
    });
  });
});
