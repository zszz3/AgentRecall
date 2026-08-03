// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../../../core/platform";
import { OpenVikingMemorySettings } from "./openviking-memory-settings";

describe("OpenVikingMemorySettings", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSettingsChange = vi.fn();
  const getSnapshot = vi.fn();

  beforeEach(async () => {
    onSettingsChange.mockReset();
    getSnapshot.mockResolvedValue({
      runtime: { state: "not-installed" },
      model: { model: "BAAI/bge-small-zh-v1.5", installed: false },
      workspaces: [],
    });
    Reflect.set(window, "sessionSearch", {
      getOpenVikingMemorySnapshot: getSnapshot,
    });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(OpenVikingMemorySettings, {
        language: "zh",
        settings: { ...defaultSettings, openVikingMemoryEnabled: true },
        saving: false,
        onSettingsChange,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("expands absolute-path inputs from configuration buttons after download actions", async () => {
    const cards = [...container.querySelectorAll<HTMLElement>(".openviking-component-card")];
    expect(cards).toHaveLength(2);
    const runtimeButtons = [...cards[0]!.querySelectorAll<HTMLButtonElement>("button")];
    const modelButtons = [...cards[1]!.querySelectorAll<HTMLButtonElement>("button")];
    expect(runtimeButtons.map((button) => button.textContent?.trim())).toEqual(["下载", "配置"]);
    expect(modelButtons.map((button) => button.textContent?.trim())).toEqual(["下载 47.9 MB", "配置"]);

    await act(async () => runtimeButtons[1]!.click());
    await act(async () => modelButtons[1]!.click());

    const runtimeInput = cards[0]!.querySelector<HTMLInputElement>("input[type='text']");
    const modelInput = cards[1]!.querySelector<HTMLInputElement>("input[type='text']");
    expect(runtimeInput?.placeholder).toBe("请输入 OpenViking 运行时目录的绝对路径");
    expect(modelInput?.placeholder).toBe("请输入 GGUF 模型文件的绝对路径");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        runtimeInput,
        " C:\\OpenViking ",
      );
      runtimeInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onSettingsChange).not.toHaveBeenCalled();
    const runtimeSave = [...cards[0]!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "保存");
    expect(runtimeSave).toBeDefined();
    expect(runtimeSave?.disabled).toBe(false);
    await act(async () => runtimeSave!.click());
    expect(onSettingsChange).toHaveBeenCalledWith({ openVikingRuntimePath: "C:\\OpenViking" });
  });

  it("does not offer managed download while a configured model path is invalid", async () => {
    getSnapshot.mockResolvedValue({
      runtime: { state: "not-installed" },
      model: {
        model: "BAAI/bge-small-zh-v1.5",
        installed: false,
        error: "OpenViking model file was not found at the configured absolute path.",
      },
      workspaces: [],
    });
    await act(async () => {
      root.render(createElement(OpenVikingMemorySettings, {
        language: "zh",
        settings: {
          ...defaultSettings,
          openVikingMemoryEnabled: true,
          openVikingModelPath: "C:\\missing.gguf",
        },
        saving: false,
        onSettingsChange,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const modelCard = container.querySelectorAll<HTMLElement>(".openviking-component-card")[1]!;
    expect([...modelCard.querySelectorAll("button")].map((button) => button.textContent?.trim()))
      .toEqual(["配置"]);
  });

  it("disables path configuration while the runtime is starting", async () => {
    getSnapshot.mockResolvedValue({
      runtime: { state: "starting" },
      model: { model: "BAAI/bge-small-zh-v1.5", installed: true },
      workspaces: [],
    });
    await act(async () => {
      root.render(createElement(OpenVikingMemorySettings, {
        language: "zh",
        settings: { ...defaultSettings, openVikingMemoryEnabled: true, openVikingRuntimePath: "C:\\runtime" },
        saving: false,
        onSettingsChange,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const configureButtons = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .filter((button) => button.textContent?.trim() === "配置");
    expect(configureButtons).toHaveLength(2);
    expect(configureButtons.every((button) => button.disabled)).toBe(true);
  });

  it("blocks runtime start when the summary provider uses OpenAI Responses", async () => {
    getSnapshot.mockResolvedValue({
      runtime: { state: "stopped" },
      model: { model: "BAAI/bge-small-zh-v1.5", installed: true },
      workspaces: [],
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(OpenVikingMemorySettings, {
        language: "zh",
        settings: {
          ...defaultSettings,
          openVikingMemoryEnabled: true,
          summarySource: "custom",
          summaryApiConfig: { ...defaultSettings.summaryApiConfig, customApiFormat: "openai_responses" },
        },
        saving: false,
        onSettingsChange,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const startButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "启动");
    expect(startButton?.disabled).toBe(true);
    expect(container.textContent).toContain("OpenViking 要求摘要供应商使用 OpenAI Chat");
  });
});
