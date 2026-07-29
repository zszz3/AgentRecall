// @vitest-environment happy-dom

import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useMainSearchShortcut } from "./use-main-search-shortcut";

function ShortcutHarness({ enabled = true }: { enabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useMainSearchShortcut(enabled, () => {
    inputRef.current?.focus();
    inputRef.current?.select();
  });

  return createElement(
    "div",
    null,
    createElement("input", { ref: inputRef, defaultValue: "needle", "aria-label": "Session search" }),
    createElement("button", { type: "button" }, "Outside"),
  );
}

describe("main search shortcut", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderHarness(enabled = true): Promise<{ input: HTMLInputElement; outside: HTMLButtonElement }> {
    await act(async () => root.render(createElement(ShortcutHarness, { enabled })));
    const input = container.querySelector<HTMLInputElement>("input");
    const outside = container.querySelector<HTMLButtonElement>("button");
    expect(input).not.toBeNull();
    expect(outside).not.toBeNull();
    outside!.focus();
    return { input: input!, outside: outside! };
  }

  it("focuses and selects the main search input with Cmd/Ctrl+F", async () => {
    const { input } = await renderHarness();
    const event = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    await act(async () => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("does not use Cmd/Ctrl+K for main search", async () => {
    const { outside } = await renderHarness();
    const event = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    await act(async () => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it("does not steal Cmd/Ctrl+F while a detail or dialog owns the shortcut", async () => {
    const { outside } = await renderHarness(false);
    const event = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    await act(async () => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outside);
  });
});
