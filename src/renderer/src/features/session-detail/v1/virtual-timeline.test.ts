import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INITIAL_TIMELINE_ITEMS,
  DEFAULT_OLDER_PAGE_SIZE,
  VirtualTimeline,
  calculateVirtualWindow,
} from "./VirtualTimeline";

describe("calculateVirtualWindow", () => {
  const keys = Array.from({ length: 100 }, (_, index) => `message-${index}`);

  it("returns only rows intersecting the viewport", () => {
    const window = calculateVirtualWindow({
      estimatedItemHeight: 100,
      itemKeys: keys,
      scrollOffset: 8_000,
      viewportHeight: 500,
    });

    expect(window.startIndex).toBe(80);
    expect(window.endIndex).toBe(85);
    expect(window.totalSize).toBe(10_000);
    expect(window.items.map((item) => item.index)).toEqual([80, 81, 82, 83, 84]);
  });

  it("uses dynamic measurements when calculating offsets and total height", () => {
    const measuredHeights = new Map([
      ["message-0", 240],
      ["message-1", 20],
    ]);
    const window = calculateVirtualWindow({
      estimatedItemHeight: 100,
      itemKeys: keys.slice(0, 4),
      measuredHeights,
      scrollOffset: 230,
      viewportHeight: 50,
    });

    expect(window.totalSize).toBe(460);
    expect(window.startIndex).toBe(0);
    expect(window.endIndex).toBe(3);
    expect(window.items).toEqual([
      { index: 0, offset: 0, size: 240 },
      { index: 1, offset: 240, size: 20 },
      { index: 2, offset: 260, size: 100 },
    ]);
  });

  it("applies pixel overscan without exceeding the collection", () => {
    const window = calculateVirtualWindow({
      estimatedItemHeight: 100,
      itemKeys: keys.slice(0, 10),
      overscan: 150,
      scrollOffset: 800,
      viewportHeight: 200,
    });

    expect(window.startIndex).toBe(6);
    expect(window.endIndex).toBe(10);
    expect(window.items.at(-1)?.index).toBe(9);
  });
});

describe("VirtualTimeline", () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: `message-${index}`,
    text: `content-${index}`,
  }));

  it("server-renders the most recent initial window rather than all messages", () => {
    const html = renderToStaticMarkup(
      createElement(VirtualTimeline<(typeof items)[number]>, {
        getItemKey: (item) => item.id,
        items,
        renderItem: (item) => item.text,
      }),
    );

    expect(html).toContain(`data-virtual-start="${items.length - DEFAULT_INITIAL_TIMELINE_ITEMS}"`);
    expect(html).toContain("content-80");
    expect(html).toContain("content-99");
    expect(html).not.toContain("content-79");
  });

  it("exposes the 80-message pagination contract to the controlled parent", () => {
    const onLoadOlder = vi.fn();
    const html = renderToStaticMarkup(
      createElement(VirtualTimeline<(typeof items)[number]>, {
        getItemKey: (item) => item.id,
        hasOlder: true,
        items,
        onLoadOlder,
        renderItem: (item) => item.text,
      }),
    );

    expect(html).toContain(`data-page-size="${DEFAULT_OLDER_PAGE_SIZE}"`);
    expect(html).toContain("Load older messages");
    expect(html).toContain('role="feed"');
    expect(onLoadOlder).not.toHaveBeenCalled();
  });
});
