// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderPage } from "./provider-page";

let root: Root;
let host: HTMLDivElement;

/** Selects the catalog entry with this title. */
const select = async (title: string) => {
  const item = [...host.querySelectorAll<HTMLButtonElement>("button.catalog-item")]
    .find((button) => button.querySelector(".catalog-item-title")?.textContent === title);
  expect(item, title).toBeTruthy();
  await act(async () => item!.click());
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  Object.defineProperty(window, "sessionSearch", { configurable: true, value: {
    listAgentModelImports: vi.fn(async () => ({ imports: [], problems: [] })),
    getGatewaySnapshot: vi.fn(async () => ({
      config: { enabled: false, port: 4325, primary: null, fallbacks: [], agentRecallModel: null, agentModels: {}, providers: [] },
      status: { running: false, host: "127.0.0.1", port: 4325, baseUrl: "http://127.0.0.1:4325", localToken: "ar-gw-test", error: null, startedAt: null, totalRequests: 0, activeRequests: 0 },
      agents: [],
      requests: [],
    })),
    onGatewaySnapshot: vi.fn(() => () => undefined),
    setGatewayAgentRecallModel: vi.fn(async () => undefined),
  } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(createElement(ProviderPage, { language: "en" })));
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("shows only Local Gateway entries and opens unified Gateway setup first", async () => {
  expect([...host.querySelectorAll(".catalog-group h3 span")].map((item) => item.textContent)).toEqual(["Local Gateway"]);
  expect([...host.querySelectorAll(".catalog-item-title")].map((item) => item.textContent)).toEqual(["Gateway setup", "Request log"]);
  expect(host.textContent).toContain("Local Model Gateway");
  expect(host.textContent).toContain("Model services");
  expect(host.textContent).toContain("AgentRecall Built-in AI");
  expect(host.querySelector('[role="tab"]')).toBeNull();
});

it("switches to request log and respects requestedView", async () => {
  const consumed = vi.fn();
  await act(async () => root.render(createElement(ProviderPage, {
    language: "en",
    requestedView: "gateway-requests",
    onRequestedViewConsumed: consumed,
  })));
  expect(consumed).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Gateway Request Log");

  await select("Gateway setup");
  expect(host.textContent).toContain("Local Model Gateway");
});
