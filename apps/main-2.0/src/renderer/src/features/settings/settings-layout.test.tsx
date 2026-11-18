// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../../../core/platform";
import { EvalSettings } from "./eval-settings";

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
});
