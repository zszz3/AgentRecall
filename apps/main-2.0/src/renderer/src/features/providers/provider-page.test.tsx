// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderPage } from "./provider-page";

let root: Root;
let host: HTMLDivElement;

/** Selects the header tab with this title. */
const selectTab = async (title: string) => {
  const tab = [...host.querySelectorAll<HTMLButtonElement>('button[role="tab"]')]
    .find((button) => button.textContent?.trim() === title);
  expect(tab, title).toBeTruthy();
  await act(async () => tab!.click());
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

it("renders header tabs without a redundant sidebar and opens the 3-step Gateway setup first", async () => {
  expect(host.querySelector(".catalog-list")).toBeNull();
  expect([...host.querySelectorAll('button[role="tab"]')].map((item) => item.textContent?.trim())).toEqual(["Gateway setup", "Request log"]);
  expect(host.textContent).toContain("Local Model Gateway");
  expect(host.textContent).toContain("Model services");
  expect(host.textContent).toContain("Default routing & built-in AI");
  expect(host.textContent).toContain("AgentRecall Built-in AI");
  expect(host.textContent).toContain("Connect local agents");
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

  await selectTab("Gateway setup");
  expect(host.textContent).toContain("Local Model Gateway");
});
