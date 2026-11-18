// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LegacyMemoryDataSettings } from "./legacy-memory-data-settings";

describe("LegacyMemoryDataSettings", () => {
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
  });

  function install(api: Record<string, unknown>): void {
    Object.defineProperty(window, "sessionSearch", { configurable: true, value: api });
  }

  function deleteButton(): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("删除"));
  }

  it("stays hidden when there is no legacy data", async () => {
    install({ getLegacyMemoryDataStatus: vi.fn(async () => ({ present: false, sizeBytes: 0 })) });

    await act(async () => root.render(createElement(LegacyMemoryDataSettings, { language: "zh" })));

    expect(container.textContent).toBe("");
  });

  it("deletes only after confirmation, keeps a failure retryable and hides once removed", async () => {
    let failRemoval!: (error: Error) => void;
    const removeLegacyMemoryData = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failRemoval = reject; }))
      .mockResolvedValueOnce({ present: false, sizeBytes: 0 });
    install({
      getLegacyMemoryDataStatus: vi.fn(async () => ({ present: true, sizeBytes: 3 * 1024 ** 3 })),
      removeLegacyMemoryData,
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);

    await act(async () => root.render(createElement(LegacyMemoryDataSettings, { language: "zh" })));
    expect(container.textContent).toContain("旧记忆数据");
    expect(container.textContent).toContain("3.0 GB");

    await act(async () => deleteButton()?.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(removeLegacyMemoryData).not.toHaveBeenCalled();

    await act(async () => deleteButton()?.click());
    expect(removeLegacyMemoryData).toHaveBeenCalledOnce();
    expect(deleteButton()?.disabled).toBe(true);
    await act(async () => deleteButton()?.click());
    expect(removeLegacyMemoryData).toHaveBeenCalledOnce();

    await act(async () => failRemoval(new Error("EBUSY: resource busy")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("EBUSY");
    expect(deleteButton()?.disabled).toBe(false);

    await act(async () => deleteButton()?.click());
    expect(removeLegacyMemoryData).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("");
  });
});
