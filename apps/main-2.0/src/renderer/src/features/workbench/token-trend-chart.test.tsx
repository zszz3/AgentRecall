// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TokenTrendChart } from "./token-trend-chart";
import type { SessionDailyTokenUsage } from "../../../../core/types";

const points: SessionDailyTokenUsage[] = Array.from({ length: 180 }, (_, i) => ({
  dayStart: new Date(2026, 0, i + 1).getTime(),
  dayEndExclusive: new Date(2026, 0, i + 2).getTime(),
  inputTokens: i % 5 === 0 ? 0 : (i + 1) * 100,
  outputTokens: i % 5 === 0 ? 0 : 50,
  cachedInputTokens: i % 5 === 0 ? 0 : 25,
  reasoningOutputTokens: 0,
  totalTokens: i % 5 === 0 ? 0 : (i + 1) * 100 + 75,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders a GitHub-style fixed-tile heatmap with 5 intensity levels, legend, and day selection", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSelectDay = vi.fn();
  try {
    await act(async () => root.render(<TokenTrendChart points={points} language="zh" onSelectDay={onSelectDay} />));
    const cells = [...host.querySelectorAll<HTMLButtonElement>(".workbench-heatmap-cell")];
    expect(cells.length).toBeGreaterThanOrEqual(133);
    expect(cells.length).toBeLessThanOrEqual(147);
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
    expect(cells.at(-1)?.classList.contains("is-today")).toBe(true);

    // Zero-token days stay at level 0 while active days span levels 1..4.
    const levels = new Set(cells.map((cell) => cell.getAttribute("data-level")));
    expect(levels).toEqual(new Set(["0", "1", "2", "3", "4"]));
    expect(host.querySelectorAll(".workbench-heatmap-swatch")).toHaveLength(5);
    expect(host.querySelector(".workbench-heatmap-legend")?.textContent).toContain("少");
    expect(host.querySelector(".workbench-heatmap-legend")?.textContent).toContain("多");

    const firstStart = Number(cells[0]!.getAttribute("data-day-start"));
    const expectedFirst = points.find((point) => point.dayStart === firstStart);
    await act(async () => cells[0]!.click());
    expect(onSelectDay).toHaveBeenLastCalledWith(expectedFirst);

    await act(async () => cells.at(-1)!.click());
    expect(onSelectDay).toHaveBeenLastCalledWith(points.at(-1));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("supports 2D keyboard navigation across days and weeks with a single Tab stop and linked tooltip", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
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
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".workbench-heatmap-cell")];
    const last = buttons.length - 1;
    expect(host.querySelector('[role="toolbar"]')?.getAttribute("aria-description")).toContain("Enter or Space");

    const assertCurrent = (index: number) => {
      expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([buttons[index]]);
      expect(document.activeElement).toBe(buttons[index]);
      expect(host.querySelector('[role="tooltip"]')?.id).toBe(buttons[index]!.getAttribute("aria-describedby"));
    };

    await act(async () => buttons[last]!.focus());
    assertCurrent(last);
    await key("ArrowDown");
    assertCurrent(last);
    await key("ArrowUp");
    assertCurrent(last - 1);
    await key("ArrowLeft");
    assertCurrent(last - 8);
    await key("ArrowRight");
    assertCurrent(last - 1);
    await key("Home");
    assertCurrent(0);
    await key("ArrowUp");
    assertCurrent(0);
    expect(onSelectDay).not.toHaveBeenCalled();

    const firstStart = Number(buttons[0]!.getAttribute("data-day-start"));
    await act(async () => buttons[0]!.click());
    expect(onSelectDay).toHaveBeenCalledExactlyOnceWith(points.find((point) => point.dayStart === firstStart));
    await key("End");
    assertCurrent(last);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("preserves the chosen date across data refreshes and handles empty history cleanly", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSelectDay = vi.fn();
  try {
    await act(async () => root.render(<TokenTrendChart points={points} language="en" onSelectDay={onSelectDay} />));
    const first = host.querySelector<HTMLButtonElement>(".workbench-heatmap-cell")!;
    await act(async () => first.focus());
    const refreshed = points.map((point) => ({ ...point, totalTokens: 123_456 }));
    await act(async () => root.render(<TokenTrendChart points={refreshed} language="en" onSelectDay={onSelectDay} />));
    expect(host.querySelector('[tabindex="0"]')).toBe(first);
    expect(first.getAttribute("aria-label")).toContain("123,456 Token");

    // When the selected day leaves the window, the latest remaining day becomes the Tab stop.
    await act(async () => root.render(<TokenTrendChart points={refreshed.slice(-1)} language="en" onSelectDay={onSelectDay} />));
    expect(host.querySelectorAll('.workbench-heatmap-cell[tabindex="0"]')).toHaveLength(1);
    expect(host.querySelector('.workbench-heatmap-cell[tabindex="0"]')?.getAttribute("data-day-start")).toBe(String(points.at(-1)!.dayStart));

    // Clicking Today opens today's sessions; empty history shows empty notice without a button.
    const todayBtn = host.querySelector<HTMLButtonElement>(".workbench-token-trend-foot button");
    expect(todayBtn?.getAttribute("aria-label")).toContain("View today");
    await act(async () => todayBtn!.click());
    expect(onSelectDay).toHaveBeenLastCalledWith(refreshed.at(-1));

    await act(async () => root.render(<TokenTrendChart points={[]} language="en" onSelectDay={onSelectDay} />));
    expect(host.querySelectorAll(".workbench-heatmap-cell")).toHaveLength(0);
    expect(host.querySelector(".workbench-token-trend-foot button")).toBeNull();
    expect(host.querySelector(".workbench-token-trend-empty")?.textContent).toContain("No Token activity");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
