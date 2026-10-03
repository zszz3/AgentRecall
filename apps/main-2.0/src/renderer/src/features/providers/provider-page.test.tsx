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
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text);
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
};
beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  apply.mockReset().mockResolvedValue(); save.mockClear(); setSettings.mockClear();
  Object.defineProperty(window, "sessionSearch", { configurable: true, value: {
    listSavedProviders: vi.fn(async () => [saved]),
    readSavedProvider: vi.fn(async () => ({ ...saved, config: { ...saved.config, customApiKey: "synthetic" } })),
    saveProvider: save,
    getCodexConfig: vi.fn(async () => ({ exists: false, activeProviderId: "openai", providers: [] })),
    getClaudeConfig: vi.fn(async () => ({ exists: false, route: {} })),
  } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(ProviderPage, { settings: structuredClone(defaultSettings), language: "en", feedback: null,
    onSettingsChange: setSettings, onApplyToCodex: apply, onApplyToClaude: vi.fn(async () => {}) })));
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
