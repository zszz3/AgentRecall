// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../../core/platform";
import { ApiConfigDialog } from "./api-config-dialog";

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

describe("AI summary source pane", () => {
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
        getApiProviderKey: vi.fn(async () => ""),
        getCodexConfig: vi.fn(async () => codexSnapshot()),
        getClaudeConfig: vi.fn(async () => claudeSnapshot()),
        pickConfigDirectory: vi.fn(async () => ""),
        probeCodexModels: vi.fn(async () => ({ models: [], endpoint: "", endpoints: [], credentialSource: "" })),
        probeClaudeModels: vi.fn(async () => ({ models: [], endpoint: "", endpoints: [], credentialSource: "" })),
        testSummaryProviderConnection: vi.fn(async () => ({ elapsedMs: 1, credentialSource: "" })),
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function mountSummaryPane(): Promise<void> {
    await act(async () => root.render(createElement(ApiConfigDialog, {
      settings: structuredClone(defaultSettings),
      language: "en" as const,
      feedback: null,
      onSettingsChange: vi.fn(),
      onApplyToCodex: vi.fn(),
      onApplyToClaude: vi.fn(),
      onClose: vi.fn(),
    })));
    const summaryTab = [...container.querySelectorAll<HTMLButtonElement>(".api-target-tabs button")]
      .find((button) => button.textContent?.includes("AI Summary"));
    if (!summaryTab) throw new Error("AI summary tab not rendered");
    await act(async () => summaryTab.click());
  }

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
