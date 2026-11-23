// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "./primitives";

describe("Segmented", () => {
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
  });

  it("shows an optional count beside a tab label and reports the chosen tab", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(createElement(Segmented<"channels" | "agents">, {
      label: "Runtime views",
      value: "channels",
      onChange,
      options: [{ value: "channels", label: "Execution configs", count: 4 }, { value: "agents", label: "Agent", count: 0 }],
    })));
    const tabs = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([["Execution configs4", "true"], ["Agent0", "false"]]);
    expect(tabs[0]!.querySelector("[data-slot=segmented-count]")?.textContent).toBe("4");
    await act(async () => tabs[1]!.click());
    expect(onChange).toHaveBeenCalledWith("agents");
  });
});
