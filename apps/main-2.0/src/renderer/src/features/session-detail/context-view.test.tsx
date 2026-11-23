// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionContextSample } from "../../../../core/types";
import { ContextView } from "./context-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function sample(turn: number, occurredAt: string, cached: number): SessionContextSample {
  return { turnId: `turn-${turn}`, turnIndex: turn, occurredAt, inputTokens: 100, cachedInputTokens: cached, cacheCreationInputTokens: 0, outputTokens: 20 };
}

async function render(samples: SessionContextSample[] | Error, onOpenTurn = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const loadContext = vi.fn(async () => {
    if (samples instanceof Error) throw samples;
    return samples;
  });
  await act(async () => {
    root!.render(
      <ContextView sessionKey="deepseek:s1" version="1" language="en" matchedTurnId={null} onOpenTurn={onOpenTurn} loadContext={loadContext} />,
    );
  });
  return { loadContext, onOpenTurn };
}

describe("ContextView", () => {
  it("draws one point per model call in a chart that scrolls sideways and opens the Turn of a clicked call", async () => {
    const { loadContext, onOpenTurn } = await render([
      sample(0, "2026-11-23T08:00:00.000Z", 1_000),
      sample(0, "2026-11-23T08:00:05.000Z", 120_000),
      sample(1, "2026-11-23T08:01:00.000Z", 20_000),
    ]);

    expect(loadContext).toHaveBeenCalledWith("deepseek:s1");
    const stats = [...host!.querySelectorAll(".context-stats div")].map((item) => item.textContent);
    expect(stats).toEqual(["Model calls3", "Largest context120K", "Latest context20K", "Read from cache100%", "Compactions1", "Output60"]);
    const svg = host!.querySelector<SVGSVGElement>(".context-scroll svg")!;
    expect(svg.getAttribute("width")).toBe("18");
    expect(host!.querySelectorAll(".context-compaction")).toHaveLength(1);
    expect([...host!.querySelectorAll(".context-turn-label")].map((label) => label.textContent)).toEqual(["Turn 1"]);

    svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 18, bottom: 322, width: 18, height: 322, x: 0, y: 0, toJSON: () => ({}) });
    act(() => {
      svg.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 13 }));
    });
    expect(host!.querySelector(".context-tip")?.textContent).toContain("Turn 2");
    expect(host!.querySelector(".context-tip")?.textContent).toContain("after a compaction");
    act(() => {
      svg.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 13 }));
    });
    expect(onOpenTurn).toHaveBeenCalledWith("turn-1");
  });

  it("explains a Session without per-call usage and reports a failed load", async () => {
    await render([]);
    expect(host!.textContent).toContain("no usage recorded per model call");
    act(() => root?.unmount());
    host?.remove();

    await render(new Error("Error invoking remote method 'session:context': Error: database offline"));
    expect(host!.querySelector("[role=alert]")?.textContent).toBe("Could not load the context: database offline");
  });

  it("fits the Session into the visible width and zooms in and back from there", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
    await render([
      sample(0, "2026-11-23T08:00:00.000Z", 1_000),
      sample(1, "2026-11-23T08:00:05.000Z", 2_000),
      sample(2, "2026-11-23T08:01:00.000Z", 3_000),
    ]);
    const width = () => Number(host!.querySelector(".context-scroll svg")!.getAttribute("width"));
    const button = (label: string) => [...host!.querySelectorAll<HTMLButtonElement>(".context-zoom button")]
      .find((item) => item.getAttribute("aria-label") === label || item.textContent === label)!;

    expect(width()).toBe(900);
    expect(button("About 100 Turns").disabled).toBe(true);
    act(() => button("Show fewer Turns").click());
    expect(width()).toBe(1_350);
    act(() => button("About 100 Turns").click());
    expect(width()).toBe(900);
    vi.restoreAllMocks();
  });
});
