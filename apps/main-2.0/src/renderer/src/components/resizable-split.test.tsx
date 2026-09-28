// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResizableSplit } from "./resizable-split";

let root: Root;
let host: HTMLDivElement;
let available: number;
let resize: () => void;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value) });
  available = 1000;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => available);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = () => act(async () => root.render(
  <ResizableSplit className="test-split" label="Resize library" storageKey="test-pane" initialWidth={220}>
    <aside>Library</aside><main>Details</main>
  </ResizableSplit>,
));
const handle = () => host.querySelector<HTMLElement>('[role="separator"]')!;
const key = (value: string) => act(async () => { handle().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })); });

it("supports keyboard bounds, persisted preference and reset", async () => {
  localStorage.setItem("test-pane", "260");
  await mount();
  expect(handle().getAttribute("aria-valuenow")).toBe("260");
  await key("ArrowRight");
  expect(localStorage.getItem("test-pane")).toBe("276");
  await key("End");
  expect(handle().getAttribute("aria-valuenow")).toBe("400");
  await key("ArrowRight");
  expect(handle().getAttribute("aria-valuenow")).toBe("400");
  await key("Home");
  expect(handle().getAttribute("aria-valuenow")).toBe("180");
  await act(async () => { handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  expect(handle().getAttribute("aria-valuenow")).toBe("220");
});

it("clamps to available space and stacks without discarding the preferred width", async () => {
  await mount();
  await key("End");
  await act(async () => { available = 600; resize(); });
  expect(handle().getAttribute("aria-valuenow")).toBe("232");
  await act(async () => { available = 500; resize(); });
  expect(host.firstElementChild?.getAttribute("data-stacked")).toBe("true");
  expect(handle().tabIndex).toBe(-1);
  await act(async () => { available = 1000; resize(); });
  expect(handle().getAttribute("aria-valuenow")).toBe("400");
  expect(handle().tabIndex).toBe(0);
});

it.each(["pointerup", "pointercancel", "blur", "unmount"])("cleans up a pointer drag on %s", async ending => {
  await mount();
  document.body.style.cursor = "default";
  document.body.style.userSelect = "text";
  await act(async () => {
    handle().dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 220, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300 }));
  });
  expect(handle().getAttribute("aria-valuenow")).toBe("300");
  expect(document.body.style.userSelect).toBe("none");
  await act(async () => {
    if (ending === "unmount") root.render(null);
    else window.dispatchEvent(new Event(ending));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 400 }));
  });
  expect(document.body.style.cursor).toBe("default");
  expect(document.body.style.userSelect).toBe("text");
  expect(localStorage.getItem("test-pane")).toBe("300");
});
