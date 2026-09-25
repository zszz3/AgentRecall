// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { TokenTrendChart } from "./token-trend-chart";
import type { SessionDailyTokenUsage } from "../../../../core/types";

const points: SessionDailyTokenUsage[] = Array.from({ length: 90 }, (_, i) => ({
  dayStart: new Date(2026, 0, i + 1).getTime(), dayEndExclusive: new Date(2026, 0, i + 2).getTime(),
  inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1,
}));

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

it.each(["invalid", "365", "unavailable"])("defaults safely when the saved range is %s", async (stored) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.setItem("agent-recall.workbench-token-trend-period.v2", stored);
  if (stored === "unavailable") {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Storage unavailable", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage read-only", "QuotaExceededError"); });
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<TokenTrendChart points={[]} language="en" onSelectDay={vi.fn()} />));
    expect(host.querySelector("select")?.value).toBe("7");
    await act(async () => {
      const select = host.querySelector("select")!;
      select.value = "90";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector("select")?.value).toBe("90");
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  }
});

it("switches actual daily windows, totals, sparse dates and selected-day navigation", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSelectDay = vi.fn();
  try {
    await act(async () => root.render(<TokenTrendChart points={points} language="zh" onSelectDay={onSelectDay} />));
    for (const days of [7, 30, 90]) {
      await act(async () => {
        const select = host.querySelector("select")!;
        select.value = String(days);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(host.querySelector("section")?.getAttribute("aria-label")).toBe(`近 ${days} 天 Token 用量`);
      expect(host.querySelectorAll(".workbench-token-trend-point")).toHaveLength(days);
      expect(host.querySelectorAll('.workbench-token-trend-point[tabindex="0"]')).toHaveLength(1);
      expect(host.querySelector(".workbench-token-trend-head b")?.textContent).toBe(String(days));
      expect(host.querySelectorAll(".workbench-token-trend-labels span")).toHaveLength(days === 7 ? 7 : 5);
      await act(async () => host.querySelector<HTMLButtonElement>(".workbench-token-trend-point")!.click());
      expect(onSelectDay).toHaveBeenLastCalledWith(points[90 - days]);
      // Leaving Workbench unmounts the chart; returning must restore its range.
      await act(async () => root.render(null));
      await act(async () => root.render(<TokenTrendChart points={points} language="zh" onSelectDay={onSelectDay} />));
      expect(host.querySelector("select")?.value).toBe(String(days));
      expect(host.querySelectorAll(".workbench-token-trend-point")).toHaveLength(days);
      expect(host.querySelector(".workbench-token-trend-head b")?.textContent).toBe(String(days));
    }
    await act(async () => root.render(<TokenTrendChart points={[]} language="en" onSelectDay={onSelectDay} />));
    expect(host.querySelectorAll(".workbench-token-trend-point")).toHaveLength(0);
    expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
    expect(host.querySelector(".workbench-token-trend-head b")?.textContent).toBe("0");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it.each([7, 30, 90])("offers one chart Tab stop with bounded date navigation and activation over %i days", async (days) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.setItem("agent-recall.workbench-token-trend-period.v2", String(days));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSelectDay = vi.fn();
  const key = async (value: string) => {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
    await act(async () => document.activeElement!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  };
  try {
    await act(async () => root.render(<TokenTrendChart points={points} language="en" onSelectDay={onSelectDay} />));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".workbench-token-trend-point")];
    expect(host.querySelector('[role="toolbar"]')?.getAttribute("aria-description")).toContain("Enter or Space");
    const assertCurrent = (index: number) => {
      expect(buttons.filter(button => button.tabIndex === 0)).toEqual([buttons[index]]);
      expect(document.activeElement).toBe(buttons[index]);
      expect(buttons[index].getAttribute("aria-label")).toContain("1 Token. View sessions");
      expect(host.querySelector('[role="tooltip"]')?.id).toBe(buttons[index].getAttribute("aria-describedby"));
    };
    await act(async () => buttons[days - 1].focus());
    assertCurrent(days - 1);
    await key("ArrowRight");
    assertCurrent(days - 1);
    await key("ArrowLeft");
    assertCurrent(days - 2);
    await key("ArrowRight");
    assertCurrent(days - 1);
    await key("Home");
    assertCurrent(0);
    await key("ArrowLeft");
    assertCurrent(0);
    expect(onSelectDay).not.toHaveBeenCalled();
    // Browsers also dispatch this native button click for Enter and Space.
    // The real keyboard default action is covered by the Electron smoke.
    await act(async () => buttons[0].click());
    expect(onSelectDay).toHaveBeenCalledExactlyOnceWith(points[90 - days]);
    await key("End");
    assertCurrent(days - 1);
    await act(async () => buttons[days - 1].click());
    expect(onSelectDay).toHaveBeenLastCalledWith(points[89]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it.each([7, 30, 90])("selects the nearest daily date anywhere vertically on a %i-day plot", async (days) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.setItem("agent-recall.workbench-token-trend-period.v2", String(days));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSelectDay = vi.fn();
  try {
    await act(async () => root.render(<TokenTrendChart points={points} language="en" onSelectDay={onSelectDay} />));
    const canvas = host.querySelector<HTMLDivElement>(".workbench-token-trend-canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(50, 20, 560, 150));
    // Plot padding is 10 / 280 at each edge. Hit a fractional day halfway
    // down the canvas rather than the marker's exact x/y coordinates.
    for (const fraction of [-.1, .37, 1.1]) {
      const expectedIndex = Math.max(0, Math.min(days - 1, Math.round(fraction * (days - 1))));
      const clientX = 50 + (10 + fraction * 260) / 280 * 560;
      await act(async () => canvas.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY: 90, bubbles: true })));
      expect(host.querySelector(".workbench-token-trend-point.is-active")?.getAttribute("data-day-start"))
        .toBe(String(points[90 - days + expectedIndex].dayStart));
      await act(async () => canvas.dispatchEvent(new MouseEvent("click", { clientX, clientY: 90, bubbles: true })));
      expect(onSelectDay).toHaveBeenLastCalledWith(points[90 - days + expectedIndex]);
      expect(document.activeElement?.getAttribute("data-day-start")).toBe(String(points[90 - days + expectedIndex].dayStart));
      expect(host.querySelectorAll('.workbench-token-trend-point[tabindex="0"]')).toHaveLength(1);
    }
    expect(onSelectDay).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("preserves the chosen date across data refreshes and exposes exact daily totals", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSelectDay = vi.fn();
  try {
    await act(async () => root.render(<TokenTrendChart points={points} language="en" onSelectDay={onSelectDay} />));
    const first = host.querySelector<HTMLButtonElement>(".workbench-token-trend-point")!;
    await act(async () => first.focus());
    const refreshed = points.map(point => ({ ...point, totalTokens: 123_456 }));
    await act(async () => root.render(<TokenTrendChart points={refreshed} language="en" onSelectDay={onSelectDay} />));
    expect(host.querySelector('[tabindex="0"]')).toBe(first);
    expect(first.getAttribute("aria-label")).toContain("123,456 Token");
    await act(async () => first.click());
    expect(onSelectDay).toHaveBeenCalledExactlyOnceWith(refreshed[83]);
    // When the selected day leaves the window, the latest remaining day is
    // still reachable by Tab; an out-of-range index cannot strand the chart.
    await act(async () => root.render(<TokenTrendChart points={refreshed.slice(-1)} language="en" onSelectDay={onSelectDay} />));
    expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(host.querySelector('[tabindex="0"]')?.getAttribute("data-day-start")).toBe(String(points[89].dayStart));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
