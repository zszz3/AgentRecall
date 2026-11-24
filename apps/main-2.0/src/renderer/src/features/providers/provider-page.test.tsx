// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../../core/platform";
import { ProviderPage } from "./provider-page";

let root: Root;
let host: HTMLDivElement;
const setSettings = vi.fn();
const saveModelKey = vi.fn(async () => undefined);
const testModel = vi.fn(async () => ({ model: "deepseek-v4-pro", reply: "OK" }));
const pageProps = { settings: structuredClone(defaultSettings), language: "en" as const, feedback: null, onSettingsChange: setSettings };

/** Selects the catalog entry with this title. */
const select = async (title: string) => {
  const item = [...host.querySelectorAll<HTMLButtonElement>("button.catalog-item")]
    .find((button) => button.querySelector(".catalog-item-title")?.textContent === title);
  expect(item, title).toBeTruthy();
  await act(async () => item!.click());
};
const click = async (text: string) => {
  const button = [...host.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === text || item.textContent === text);
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
};
const change = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
  const isSelect = element instanceof HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(isSelect ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(isSelect ? "change" : "input", { bubbles: true }));
  });
};
/** The select or input of the form field with this title. */
const field = <T extends HTMLInputElement | HTMLSelectElement>(title: string): T => {
  const label = [...host.querySelectorAll('[data-page="agent-model"] label.settings-field')]
    .find((item) => item.querySelector(".settings-field-title")?.textContent === title);
  expect(label, title).toBeTruthy();
  return label!.querySelector<T>("select, input")!;
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
  setSettings.mockClear(); saveModelKey.mockClear(); testModel.mockClear();
  Object.defineProperty(window, "sessionSearch", { configurable: true, value: {
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
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(createElement(ProviderPage, pageProps)));
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("lists only Local Gateway and AgentRecall's own routes, and opens unified Gateway setup first", async () => {
  expect([...host.querySelectorAll(".catalog-group h3 span")].map((item) => item.textContent)).toEqual(["Local Gateway", "Used by AgentRecall"]);
  expect([...host.querySelectorAll(".catalog-item-title")].map((item) => item.textContent)).toEqual(["Gateway setup", "Request log", "AgentRecall model", "AI summary & search"]);
  expect(host.textContent).toContain("Local Model Gateway");
  expect(host.textContent).toContain("Model services");
  expect(host.textContent).toContain("Connect local agents");
  expect(host.querySelector('[role="tab"]')).toBeNull();
});

it("opens AI summary as its own entry", async () => {
  await select("AI summary & search");
  expect(host.textContent).toContain("Save summary settings");
});

it("requires an API key for a listed provider, saves it before the choice and tests with the saved key", async () => {
  await select("AgentRecall model");
  await change(field<HTMLSelectElement>("Provider"), "deepseek");
  expect(field("Model").value).toBe("deepseek-v4-pro");

  for (const action of ["Test", "Save"]) {
    await click(action);
    expect(host.textContent).toContain("Enter the API key for this provider.");
  }
  expect(testModel).not.toHaveBeenCalled(); expect(saveModelKey).not.toHaveBeenCalled(); expect(setSettings).not.toHaveBeenCalled();

  await change(field<HTMLInputElement>("API Key"), " sk-synthetic ");
  await click("Save");
  const agentModel = deepseek("deepseek-v4-pro");
  expect(saveModelKey).toHaveBeenCalledWith(agentModel, { apiKey: "sk-synthetic" });
  expect(setSettings).toHaveBeenCalledWith({ agentModel });
  expect(field("API Key").value).toBe("");

  await click("Test");
  expect(testModel).toHaveBeenCalledWith(agentModel, null);
  expect(host.textContent).toContain("Connected. deepseek-v4-pro replied: OK");
});

it("fills in a service another agent uses and copies its key only on save", async () => {
  await select("AgentRecall model");
  expect(host.textContent).toContain("Codex: Codex auth.json is not valid JSON.");
  expect(host.querySelector("optgroup")?.getAttribute("label")).toBe("DeepSeek · api.deepseek.com — ZCode / DeepSeek Harness");

  await change(field<HTMLSelectElement>("Import from an agent"), "a1b2:0");
  expect(field("Provider").value).toBe("deepseek");
  expect(field("Model").value).toBe("deepseek-flash");
  expect(host.textContent).toContain('Uses the key of "DeepSeek" saved in ZCode / DeepSeek Harness. Saving copies it to AgentRecall.');
  await click("Test");
  expect(testModel).toHaveBeenCalledWith(deepseek("deepseek-flash"), { importId: "a1b2" });

  // Another model of the same service keeps using the imported key.
  await change(field<HTMLSelectElement>("Model"), "deepseek-v4-pro");
  await click("Save");
  expect(saveModelKey).toHaveBeenCalledWith(deepseek("deepseek-v4-pro"), { importId: "a1b2" });
  expect(setSettings).toHaveBeenCalledWith({ agentModel: deepseek("deepseek-v4-pro") });
  expect(field("Import from an agent").value).toBe("");
  expect(host.textContent).toContain("Saved. Leave empty to keep using the saved key.");

  // Choosing a provider by hand stops using the imported key.
  await change(field<HTMLSelectElement>("Import from an agent"), "a1b2:1");
  await change(field<HTMLSelectElement>("Provider"), "deepseek");
  expect(host.textContent).not.toContain("Uses the key of");
});

it("opens the entry another page asks for", async () => {
  const consumed = vi.fn();
  await act(async () => root.render(createElement(ProviderPage, { ...pageProps, requestedView: "summary", onRequestedViewConsumed: consumed })));
  expect(consumed).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Save summary settings");
  await select("AgentRecall model");
  expect(host.querySelector('[data-page="agent-model"]')).not.toBeNull();
});
