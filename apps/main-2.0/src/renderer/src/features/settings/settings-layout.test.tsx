// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../../../core/platform";
import { EvalSettings } from "./eval-settings";
import { OpenVikingMemorySettings } from "./openviking-memory-settings";

describe("settings control layout", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("refreshes model progress while downloading and restores controls on completion", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const install = new Promise<void>((resolve) => { finish = resolve; });
    const initial = {
      runtime: { state: "stopped", version: "0.4.11-r6" },
      model: { model: "BAAI/bge-small-zh-v1.5", installed: false }, workspaces: [],
    };
    const getSnapshot = vi.fn().mockResolvedValue(initial);
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { getOpenVikingMemorySnapshot: getSnapshot, installOpenVikingModel: vi.fn(() => install) },
    });
    await act(async () => root.render(createElement(OpenVikingMemorySettings, {
      language: "zh", settings: { ...defaultSettings, openVikingMemoryEnabled: true },
      saving: false, onSettingsChange: vi.fn(),
    })));
    const download = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("下载 47.9 MB"));
    await act(async () => download?.click());
    getSnapshot.mockResolvedValue({ ...initial, model: {
      ...initial.model, downloading: true, downloadedBytes: 24_000_000, totalBytes: 48_000_000,
    } });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("24.0 / 48.0 MB");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("50%");
    expect(download?.disabled).toBe(true);
    getSnapshot.mockResolvedValue({ ...initial, model: { ...initial.model, installed: true } });
    await act(async () => { finish(); await install; });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain("已下载");
    const calls = getSnapshot.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(getSnapshot).toHaveBeenCalledTimes(calls);
  });

  it("renders the Eval hook installer as a standard settings action", async () => {
    const getSkillUsageHookStatus = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const installSkillUsageHook = vi.fn(async () => undefined);
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: {
        getSkillUsageHookStatus,
        installSkillUsageHook,
      },
    });

    await act(async () => root.render(createElement(EvalSettings, {
      language: "en",
      settings: { ...defaultSettings, evalEnabled: true },
      saving: false,
      onSettingsChange: vi.fn(),
    })));

    const installButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Install hook"));
    expect(installButton).toBeDefined();
    expect(installButton?.classList.contains("settings-action-button")).toBe(true);
    expect(installButton?.disabled).toBe(false);

    await act(async () => installButton?.click());

    expect(installSkillUsageHook).toHaveBeenCalledOnce();
    expect(getSkillUsageHookStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Install hook");
  });

  it("keeps the automatic recall copy readable beside a bounded number control", async () => {
    const onSettingsChange = vi.fn();
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: {
        getOpenVikingMemorySnapshot: vi.fn(async () => ({
          runtime: { state: "running", version: "0.4.11-r4" },
          model: { model: "BAAI/bge-small-zh-v1.5", installed: true },
          workspaces: [],
        })),
      },
    });

    await act(async () => root.render(createElement(OpenVikingMemorySettings, {
      language: "en",
      settings: { ...defaultSettings, openVikingMemoryEnabled: true },
      saving: false,
      onSettingsChange,
    })));

    const field = container.querySelector(".openviking-recall-budget-field");
    const description = field?.querySelector(".settings-field-sub");
    const input = field?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(field?.querySelector(".settings-field-title")?.textContent)
      .toBe("Automatic recall budget");
    expect(description?.textContent)
      .toBe("Limits injected memory by estimated model Tokens instead of characters.");
    expect(field?.querySelector(".settings-field-description")).toBeNull();
    expect(input?.classList.contains("settings-number")).toBe(true);
    expect(input?.value).toBe("1200");
    expect(input?.min).toBe("256");
    expect(input?.max).toBe("8192");
    expect(input?.step).toBe("128");
    expect(input?.disabled).toBe(false);

    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, "2048");
    await act(async () => {
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onSettingsChange).toHaveBeenCalledWith({ openVikingRecallTokenBudget: 2048 });
  });
});
