// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../../core/platform";
import { ProviderPage } from "./provider-page";

let root: Root;
let host: HTMLDivElement;
const saved = { id: "11111111-1111-4111-8111-111111111111", name: "Work", target: "codex" as const,
  config: { ...defaultSettings.apiConfig, activeProvider: "custom" as const, customApiKey: "", customBaseUrl: "https://example.test/v1" } };
const apply = vi.fn<() => Promise<void>>();
const save = vi.fn(async () => [saved]);
const setSettings = vi.fn();
const saveModelKey = vi.fn(async () => undefined);
const testModel = vi.fn(async () => ({ model: "deepseek-v4-pro", reply: "OK" }));
const pageProps = { settings: structuredClone(defaultSettings), language: "en" as const, feedback: null,
  onSettingsChange: setSettings, onApplyToCodex: apply, onApplyToClaude: vi.fn(async () => {}) };
/** Selects the catalog entry with this title. */
const select = async (title: string) => {
  const item = [...host.querySelectorAll<HTMLButtonElement>('button.catalog-item')]
    .find((button) => button.querySelector('.catalog-item-title')?.textContent === title);
  expect(item, title).toBeTruthy();
  await act(async () => item!.click());
};
const remove = vi.fn(async () => []);
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === text || item.textContent === text);
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
};
const change = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
  const select = element instanceof HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(select ? "change" : "input", { bubbles: true }));
  });
};
/** The select or input of the form field with this title. */
const field = <T extends HTMLInputElement | HTMLSelectElement>(title: string): T => {
  const label = [...host.querySelectorAll('[data-page="agent-model"] label.settings-field')]
    .find((item) => item.querySelector('.settings-field-title')?.textContent === title);
  expect(label, title).toBeTruthy();
  return label!.querySelector<T>('select, input')!;
};
const deepseek = (model: string) => ({ provider: "deepseek", model, baseUrl: "", api: "openai-completions" });
const imports = {
  imports: [{ id: "a1b2", name: "DeepSeek", host: "api.deepseek.com", sources: ["zcode", "dsh"],
    choices: [{ config: deepseek("deepseek-flash"), label: "deepseek-flash" }, { config: deepseek("deepseek-v4-pro"), label: "deepseek-v4-pro" }] }],
  problems: [{ source: "codex", message: "Codex auth.json is not valid JSON." }],
};
beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  apply.mockReset().mockResolvedValue(); save.mockClear(); remove.mockClear(); setSettings.mockClear(); saveModelKey.mockClear(); testModel.mockClear();
  Object.defineProperty(window, "sessionSearch", { configurable: true, value: {
    listSavedProviders: vi.fn(async () => [saved]),
    readSavedProvider: vi.fn(async () => ({ ...saved, config: { ...saved.config, customApiKey: "synthetic" } })),
    saveProvider: save,
    removeSavedProvider: remove,
    getCodexConfig: vi.fn(async () => ({ exists: false, activeProviderId: "openai", providers: [] })),
    getClaudeConfig: vi.fn(async () => ({ exists: false, route: {} })),
    listAgentModelProviders: vi.fn(async () => [{ id: "deepseek", name: "DeepSeek", keyLabel: "DeepSeek API key",
      models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }, { id: "deepseek-flash", name: "DeepSeek Flash" }] }]),
    hasAgentModelKey: vi.fn(async () => false),
    listAgentModelImports: vi.fn(async () => imports),
    saveAgentModelKey: saveModelKey,
    testAgentModel: testModel,
    getGatewaySnapshot: vi.fn(async () => ({
      config: { enabled: false, port: 4325, primary: null, fallbacks: [], agentModels: {}, providers: [] },
      status: { running: false, host: "127.0.0.1", port: 4325, baseUrl: "http://127.0.0.1:4325", localToken: "ar-gw-test", error: null, startedAt: null, totalRequests: 0, activeRequests: 0 },
      agents: [],
      requests: [],
    })),
    onGatewaySnapshot: vi.fn(() => () => undefined),
  } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(ProviderPage, pageProps)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("lists Local Gateway, AgentRecall's own routes and each client's services, and opens unified Gateway setup first", async () => {
  expect([...host.querySelectorAll('.catalog-group h3 span')].map((item) => item.textContent)).toEqual(["Local Gateway", "Used by AgentRecall", "Codex", "Claude Code"]);
  expect([...host.querySelectorAll('.catalog-item-title')].map((item) => item.textContent)).toEqual(["Gateway setup", "Request log", "AgentRecall model", "AI summary & search", "Official account", "Work", "Official account"]);
  expect(host.textContent).toContain("Local Model Gateway");
  expect(host.textContent).toContain("Model services");
  expect(host.textContent).toContain("Connect local agents");
  expect(host.querySelector('[role="tab"]')).toBeNull();
});

it("edits a saved service in the detail pane and saves without applying or changing active settings", async () => {
  await select('Work');
  expect(host.querySelector<HTMLInputElement>('.provider-editor-heading input')?.value).toBe('Work');
  expect(host.querySelector('input[type="password"]')?.getAttribute('value')).toBe('synthetic');
  await click('Save provider');
  expect(save).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled(); expect(setSettings).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Provider saved.');
});

it("waits for applying and preserves a retryable failure without claiming success", async () => {
  await select('Work');
  let reject!: (error: Error) => void;
  apply.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  await click('Enable');
  expect([...host.querySelectorAll<HTMLButtonElement>('.catalog-detail-actions button')].every((button) => button.disabled)).toBe(true);
  expect(host.textContent).not.toContain('Applied');
  await act(async () => reject(new Error('Write failed')));
  expect(host.textContent).toContain('Write failed');
  expect(host.textContent).not.toContain('Client configuration updated');
  apply.mockResolvedValue(); await click('Enable');
  expect(host.textContent).toContain('Applied');
});

it("removes a saved service only after confirmation", async () => {
  await select('Work');
  await click('Remove');
  expect(remove).not.toHaveBeenCalled();
  await click('Confirm removal');
  expect(remove).toHaveBeenCalledWith(saved.id);
  expect(host.querySelector('[data-page="agent-model"]')).not.toBeNull();
});

it("opens AI summary as its own entry", async () => {
  await select('AI summary & search');
  expect(host.textContent).toContain('Reuse a saved API connection');
  expect(host.textContent).toContain('Save summary settings');
});

it("requires an API key for a listed provider, saves it before the choice and tests with the saved key", async () => {
  await select('AgentRecall model');
  await change(field<HTMLSelectElement>('Provider'), "deepseek");
  expect(field('Model').value).toBe("deepseek-v4-pro");

  for (const action of ['Test', 'Save']) {
    await click(action);
    expect(host.textContent).toContain('Enter the API key for this provider.');
  }
  expect(testModel).not.toHaveBeenCalled(); expect(saveModelKey).not.toHaveBeenCalled(); expect(setSettings).not.toHaveBeenCalled();

  await change(field<HTMLInputElement>('API Key'), " sk-synthetic ");
  await click('Save');
  const agentModel = deepseek("deepseek-v4-pro");
  expect(saveModelKey).toHaveBeenCalledWith(agentModel, { apiKey: "sk-synthetic" });
  expect(setSettings).toHaveBeenCalledWith({ agentModel });
  expect(field('API Key').value).toBe("");

  await click('Test');
  expect(testModel).toHaveBeenCalledWith(agentModel, null);
  expect(host.textContent).toContain('Connected. deepseek-v4-pro replied: OK');
});

it("fills in a service another agent uses and copies its key only on save", async () => {
  await select('AgentRecall model');
  expect(host.textContent).toContain('Codex: Codex auth.json is not valid JSON.');
  expect(host.querySelector('optgroup')?.getAttribute('label')).toBe('DeepSeek · api.deepseek.com — ZCode / DeepSeek Harness');

  await change(field<HTMLSelectElement>('Import from an agent'), "a1b2:0");
  expect(field('Provider').value).toBe("deepseek");
  expect(field('Model').value).toBe("deepseek-flash");
  expect(host.textContent).toContain('Uses the key of "DeepSeek" saved in ZCode / DeepSeek Harness. Saving copies it to AgentRecall.');
  await click('Test');
  expect(testModel).toHaveBeenCalledWith(deepseek("deepseek-flash"), { importId: "a1b2" });

  // Another model of the same service keeps using the imported key.
  await change(field<HTMLSelectElement>('Model'), "deepseek-v4-pro");
  await click('Save');
  expect(saveModelKey).toHaveBeenCalledWith(deepseek("deepseek-v4-pro"), { importId: "a1b2" });
  expect(setSettings).toHaveBeenCalledWith({ agentModel: deepseek("deepseek-v4-pro") });
  expect(field('Import from an agent').value).toBe("");
  expect(host.textContent).toContain('Saved. Leave empty to keep using the saved key.');

  // Choosing a provider by hand stops using the imported key.
  await change(field<HTMLSelectElement>('Import from an agent'), "a1b2:1");
  await change(field<HTMLSelectElement>('Provider'), "deepseek");
  expect(host.textContent).not.toContain('Uses the key of');
});

it("opens the entry another page asks for", async () => {
  const consumed = vi.fn();
  await act(async () => root.render(createElement(ProviderPage, { ...pageProps, requestedView: "summary", onRequestedViewConsumed: consumed })));
  expect(consumed).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Reuse a saved API connection');
  await select('AgentRecall model');
  expect(host.querySelector('[data-page="agent-model"]')).not.toBeNull();
});
