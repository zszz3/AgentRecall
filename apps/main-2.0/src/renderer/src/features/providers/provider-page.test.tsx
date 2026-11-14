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
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text);
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
beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  apply.mockReset().mockResolvedValue(); save.mockClear(); setSettings.mockClear(); saveModelKey.mockClear(); testModel.mockClear();
  Object.defineProperty(window, "sessionSearch", { configurable: true, value: {
    listSavedProviders: vi.fn(async () => [saved]),
    readSavedProvider: vi.fn(async () => ({ ...saved, config: { ...saved.config, customApiKey: "synthetic" } })),
    saveProvider: save,
    getCodexConfig: vi.fn(async () => ({ exists: false, activeProviderId: "openai", providers: [] })),
    getClaudeConfig: vi.fn(async () => ({ exists: false, route: {} })),
    listAgentModelProviders: vi.fn(async () => [{ id: "deepseek", name: "DeepSeek", keyLabel: "DeepSeek API key",
      models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }, { id: "deepseek-flash", name: "DeepSeek Flash" }] }]),
    hasAgentModelKey: vi.fn(async () => false),
    saveAgentModelKey: saveModelKey,
    testAgentModel: testModel,
  } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(ProviderPage, pageProps)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("starts with a compact list and editing saves without applying or changing active settings", async () => {
  expect(host.querySelector('input')).toBeNull();
  expect(host.textContent).toContain('Work');
  await click('Edit');
  expect(host.querySelector<HTMLInputElement>('.provider-editor-heading input')?.value).toBe('Work');
  expect(host.querySelector('input[type="password"]')?.getAttribute('value')).toBe('synthetic');
  await click('Save provider');
  expect(save).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled(); expect(setSettings).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Provider saved.');
});

it("waits for applying and preserves a retryable failure without claiming success", async () => {
  let reject!: (error: Error) => void;
  apply.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  await click('Enable');
  expect([...host.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
  expect(host.textContent).not.toContain('Applied');
  await act(async () => reject(new Error('Write failed')));
  expect(host.textContent).toContain('Write failed');
  expect(host.textContent).not.toContain('Client configuration updated');
  apply.mockResolvedValue(); await click('Enable');
  expect(host.textContent).toContain('Applied');
});

it("opens AI summary separately from the client tabs", async () => {
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  await click('AI summary & search');
  expect(host.textContent).toContain('Reuse a saved API connection');
  expect(host.textContent).toContain('Save summary settings');
});

it("requires an API key for a listed provider, saves it before the choice and tests with the saved key", async () => {
  await click('AgentRecall model');
  const form = host.querySelector('[data-page="agent-model"]')!;
  await change(form.querySelector('select')!, "deepseek");
  expect(form.querySelectorAll('select')[1]?.value).toBe("deepseek-v4-pro");

  for (const action of ['Test', 'Save']) {
    await click(action);
    expect(host.textContent).toContain('Enter the API key for this provider.');
  }
  expect(testModel).not.toHaveBeenCalled(); expect(saveModelKey).not.toHaveBeenCalled(); expect(setSettings).not.toHaveBeenCalled();

  await change(form.querySelector<HTMLInputElement>('.secret-input input')!, " sk-synthetic ");
  await click('Save');
  const agentModel = { provider: "deepseek", model: "deepseek-v4-pro", baseUrl: "", api: "openai-completions" };
  expect(saveModelKey).toHaveBeenCalledWith("deepseek", "sk-synthetic");
  expect(setSettings).toHaveBeenCalledWith({ agentModel });
  expect(form.querySelector<HTMLInputElement>('.secret-input input')?.value).toBe("");

  await click('Test');
  expect(testModel).toHaveBeenCalledWith(agentModel, null);
  expect(host.textContent).toContain('Connected. deepseek-v4-pro replied: OK');
});

it("opens the AgentRecall model when another page asks for it", async () => {
  const consumed = vi.fn();
  await act(async () => root.render(createElement(ProviderPage, { ...pageProps, requestedView: "agent-model", onRequestedViewConsumed: consumed })));
  expect(consumed).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-page="agent-model"]')).not.toBeNull();
  await click('Back to providers');
  expect(host.querySelector('[data-page="agent-model"]')).toBeNull();
});
