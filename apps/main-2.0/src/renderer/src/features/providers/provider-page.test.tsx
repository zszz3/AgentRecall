// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../../core/platform";
import { ProviderPage } from "./provider-page";

/**
 * The eight rows the AI-summary pane promises, in order. Every source must render all eight in
 * exactly this sequence — that is the machine-checkable form of "the three sources look the same".
 */
const SUMMARY_ROWS = [
  "route-config",
  "config-dir",
  "base-url",
  "model",
  "api-key",
  "api-format",
  "reasoning-effort",
  "status",
];

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

describe("ProviderPage", () => {
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
        getApiProviderKey: vi.fn(async () => ""),
        getCodexConfig: vi.fn(async () => codexSnapshot()),
        getClaudeConfig: vi.fn(async () => claudeSnapshot()),
        pickConfigDirectory: vi.fn(async () => ""),
        probeCodexModels: vi.fn(async () => ({ models: [], endpoint: "", endpoints: [], credentialSource: "" })),
        probeClaudeModels: vi.fn(async () => ({ models: [], endpoint: "", endpoints: [], credentialSource: "" })),
        testSummaryProviderConnection: vi.fn(async () => ({ elapsedMs: 1, credentialSource: "" })),
        testProviderConnection,
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function mountProviderPage(settings = structuredClone(defaultSettings)): Promise<void> {
    await act(async () => root.render(createElement(ProviderPage, {
      settings,
      language: "en" as const,
      feedback: null,
      onSettingsChange: vi.fn(),
      onApplyToCodex: vi.fn(),
      onApplyToClaude: vi.fn(),
    })));
  }

  it("exposes the entire configuration path when its summary is truncated", async () => {
    const configPath = "/tmp/" + "long-config-directory/".repeat(20) + "config.toml";
    const snapshot = codexSnapshot();
    vi.mocked(window.sessionSearch.getCodexConfig).mockResolvedValue({ ...snapshot, configPath,
      activeProvider: { ...snapshot.activeProvider, envKey: "", requiresOpenaiAuth: true,
        hasApiKey: false, credentialSource: "" },
    });
    await mountProviderPage();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    const value = container.querySelector(".codex-config-visualizer strong[title]");
    expect(value?.textContent).toBe(configPath);
    expect(value?.getAttribute("title")).toBe(configPath);
    const claudeTab = [...container.querySelectorAll<HTMLButtonElement>('.api-target-tabs button')]
      .find(button => button.textContent === 'Claude Code')!;
    await act(async () => claudeTab.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(container.querySelector('.codex-config-visualizer strong[title]')?.getAttribute('title'))
      .toBe('/tmp/claude/settings.json');
  });

  async function mountSummaryPane(): Promise<void> {
    await mountProviderPage();
    const summaryTab = [...container.querySelectorAll<HTMLButtonElement>(".api-target-tabs button")]
      .find((button) => button.textContent?.includes("AI Summary"));
    if (!summaryTab) throw new Error("AI summary tab not rendered");
    await act(async () => summaryTab.click());
  }

  it("keeps a complete long model-probe error in its own field after loading", async () => {
    const message = "Probe failed: " + "long-unbroken-diagnostic-".repeat(30);
    let rejectProbe!: (error: Error) => void;
    vi.mocked(window.sessionSearch.probeCodexModels).mockImplementation(() => new Promise((_resolve, reject) => { rejectProbe = reject; }));
    const settings = structuredClone(defaultSettings);
    settings.apiConfig = { ...settings.apiConfig, activeProvider: "custom", customProviderId: "custom",
      customProviderName: "Custom Codex", customBaseUrl: "https://example.invalid/v1", customApiKey: "synthetic", customModel: "test" };
    await mountProviderPage(settings);
    const button = container.querySelector<HTMLButtonElement>(".codex-model-detect-button")!;
    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    await act(async () => rejectProbe(new Error(message)));
    expect(button.disabled).toBe(false);
    const error = button.closest(".settings-field")?.querySelector(".api-config-status.error");
    expect(error?.textContent).toBe(message);
  });

  async function selectSource(label: string): Promise<void> {
    const button = [...container.querySelectorAll<HTMLButtonElement>(".summary-provider-switch button")]
      .find((candidate) => candidate.querySelector("strong")?.textContent === label);
    if (!button) throw new Error(`summary source "${label}" not rendered`);
    await act(async () => button.click());
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

  function renderedRows(): string[] {
    return [...container.querySelectorAll("[data-summary-row]")]
      .map((element) => element.getAttribute("data-summary-row") ?? "");
  }

  it("tests the current Codex draft and reports progress and success", async () => {
    let resolveConnection: ((result: { elapsedMs: number; credentialSource: string }) => void) | undefined;
    testProviderConnection.mockImplementationOnce(() => new Promise((resolve) => {
      resolveConnection = resolve;
    }));
    const settings = structuredClone(defaultSettings);
    await mountProviderPage(settings);
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
    await mountProviderPage(settings);
    const claudeTab = [...container.querySelectorAll<HTMLButtonElement>(".api-target-tabs button")]
      .find((button) => button.textContent?.includes("Claude Code"));
    await act(async () => claudeTab?.click());
    const button = container.querySelector<HTMLButtonElement>('[data-provider-connection-test="claude"]');

    expect(button?.textContent).toContain("Test connection");
    await act(async () => button?.click());

    expect(testProviderConnection).toHaveBeenCalledWith({
      target: "claude",
      apiConfig: settings.claudeApiConfig,
    });
    expect(container.textContent).toContain("Claude runtime rejected the credential");

    const baseUrlRow = [...container.querySelectorAll<HTMLElement>(".settings-field")]
      .find((row) => row.querySelector(".settings-field-title")?.textContent === "Base URL");
    const baseUrlInput = baseUrlRow?.querySelector<HTMLInputElement>("input");
    await typeInto(baseUrlInput!, "https://changed.example/anthropic");

    expect(container.textContent).not.toContain("Claude runtime rejected the credential");
    expect(button?.disabled).toBe(false);
  });

  it("clears hydrated Codex and Claude keys when their manual Base URLs change", async () => {
    const settings = structuredClone(defaultSettings);
    settings.apiConfig = {
      ...settings.apiConfig,
      activeProvider: "custom",
      customProviderId: "custom",
      customProviderName: "Custom Codex",
      customBaseUrl: "https://old-codex.example/v1",
      customApiKey: "hydrated-codex-key",
      customModel: "gpt-test",
    };
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "custom",
      customProviderName: "Custom Claude",
      customBaseUrl: "https://old-claude.example/anthropic",
      customApiKey: "hydrated-claude-key",
      customModel: "claude-test",
    };
    await mountProviderPage(settings);

    const codexFields = [...container.querySelectorAll<HTMLElement>(".settings-field")];
    const codexBaseUrl = codexFields
      .find((row) => row.querySelector(".settings-field-title")?.textContent === "Base URL")
      ?.querySelector<HTMLInputElement>("input");
    const codexKey = codexFields
      .find((row) => row.querySelector(".settings-field-title")?.textContent === "API Key")
      ?.querySelector<HTMLInputElement>("input");
    expect(codexKey?.value).toBe("hydrated-codex-key");

    await typeInto(codexBaseUrl!, "https://new-codex.example/v1");

    expect(codexKey?.value).toBe("");
    const codexDetect = container.querySelector<HTMLButtonElement>(".codex-model-detect-button");
    await act(async () => codexDetect?.click());
    expect(window.sessionSearch.probeCodexModels).toHaveBeenLastCalledWith(expect.objectContaining({
      baseUrl: "https://new-codex.example/v1",
      apiKey: "",
      providerId: "custom",
    }));
    const codexTest = container.querySelector<HTMLButtonElement>('[data-provider-connection-test="codex"]');
    await act(async () => codexTest?.click());
    expect(testProviderConnection).toHaveBeenLastCalledWith({
      target: "codex",
      apiConfig: expect.objectContaining({
        customBaseUrl: "https://new-codex.example/v1",
        customApiKey: "",
      }),
    });

    const claudeTab = [...container.querySelectorAll<HTMLButtonElement>(".api-target-tabs button")]
      .find((button) => button.textContent?.includes("Claude Code"));
    await act(async () => claudeTab?.click());
    const claudeFields = [...container.querySelectorAll<HTMLElement>(".settings-field")];
    const claudeBaseUrl = claudeFields
      .find((row) => row.querySelector(".settings-field-title")?.textContent === "Base URL")
      ?.querySelector<HTMLInputElement>("input");
    const claudeKey = claudeFields
      .find((row) => row.querySelector(".settings-field-title")?.textContent === "API Key")
      ?.querySelector<HTMLInputElement>("input");
    expect(claudeKey?.value).toBe("hydrated-claude-key");

    await typeInto(claudeBaseUrl!, "https://new-claude.example/anthropic");

    expect(claudeKey?.value).toBe("");
    const claudeDetect = container.querySelector<HTMLButtonElement>(".codex-model-detect-button");
    await act(async () => claudeDetect?.click());
    expect(window.sessionSearch.probeClaudeModels).toHaveBeenLastCalledWith(expect.objectContaining({
      baseUrl: "https://new-claude.example/anthropic",
      apiKey: "",
      providerId: "custom",
    }));
    const claudeTest = container.querySelector<HTMLButtonElement>('[data-provider-connection-test="claude"]');
    await act(async () => claudeTest?.click());
    expect(testProviderConnection).toHaveBeenLastCalledWith({
      target: "claude",
      apiConfig: expect.objectContaining({
        customBaseUrl: "https://new-claude.example/anthropic",
        customApiKey: "",
      }),
    });
  });

  it("renders the same eight rows in the same order for every source", async () => {
    await mountSummaryPane();

    for (const source of ["Codex", "Claude Code", "Custom"]) {
      await selectSource(source);
      expect(renderedRows(), `source ${source}`).toEqual(SUMMARY_ROWS);
    }
  });

  it("keeps the Claude source's reasoning control in place but inert", async () => {
    await mountSummaryPane();
    await selectSource("Claude Code");

    const row = container.querySelector('[data-summary-row="reasoning-effort"]');
    const control = row?.querySelector("select");
    // Claude Code exposes no reasoning switch, so the control stays for alignment and is disabled
    // rather than pretending to change anything.
    expect(control?.disabled).toBe(true);
  });

  it("gives each source its own model box instead of sharing one value", async () => {
    await mountSummaryPane();

    await selectSource("Codex");
    const codexModel = container.querySelector<HTMLInputElement>('[data-summary-row="model"] input');
    await typeInto(codexModel!, "codex-only-model");

    await selectSource("Claude Code");
    const claudeModel = container.querySelector<HTMLInputElement>('[data-summary-row="model"] input');
    expect(claudeModel?.value).not.toBe("codex-only-model");

    await selectSource("Codex");
    expect(container.querySelector<HTMLInputElement>('[data-summary-row="model"] input')?.value)
      .toBe("codex-only-model");
  });
});
