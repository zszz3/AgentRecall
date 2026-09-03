// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchOptions, SessionSearchResult } from "../../../../core/types";
import { useSessionCatalog } from "./use-session-catalog";

const emptyLiveSessions = { generatedAt: "2026-08-05T00:00:00.000Z", sessions: [] };

describe("useSessionCatalog pagination", () => {
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

  it("returns to the last valid page when the result set shrinks", async () => {
    let shrinking = false;
    const searchSessionPage = vi.fn(async (options: SearchOptions) => {
      const offset = options.offset ?? 0;
      if (offset === 60) {
        return shrinking
          ? { sessions: [], totalCount: 60, hasMore: false }
          : { sessions: [session("codex:last")], totalCount: 61, hasMore: false };
      }
      if (offset === 30) return { sessions: [session("codex:page-two")], totalCount: 60, hasMore: false };
      return { sessions: [session("codex:first")], totalCount: 61, hasMore: true };
    });
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { searchSessionPage },
    });

    let catalog!: ReturnType<typeof useSessionCatalog>;
    function Harness() {
      catalog = useSessionCatalog({
        active: true,
        liveSessions: emptyLiveSessions,
        projects: [],
        environments: [],
        tags: [],
      });
      return null;
    }

    await act(async () => root.render(createElement(Harness)));
    await vi.waitFor(() => expect(searchSessionPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, origin: "ordinary" })));

    await act(async () => catalog.goToPage(3));
    await vi.waitFor(() => expect(searchSessionPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 60 })));
    expect(catalog.currentPage).toBe(3);

    shrinking = true;
    await act(async () => { await catalog.load(); });
    await vi.waitFor(() => expect(searchSessionPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 30 })));
    expect(catalog.currentPage).toBe(2);
  });

  it("reloads the catalog with the selected sort order", async () => {
    const searchSessionPage = vi.fn(async () => ({
      sessions: [session("codex:sorted")],
      totalCount: 100,
      hasMore: true,
    }));
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { searchSessionPage },
    });

    let catalog!: ReturnType<typeof useSessionCatalog>;
    function Harness() {
      catalog = useSessionCatalog({
        active: true,
        liveSessions: emptyLiveSessions,
        projects: [],
        environments: [],
        tags: [],
      });
      return null;
    }

    await act(async () => root.render(createElement(Harness)));
    await vi.waitFor(() => expect(searchSessionPage).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: "smart" }),
    ));

    await act(async () => catalog.goToPage(3));
    await vi.waitFor(() => expect(searchSessionPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "smart", offset: 60 }),
    ));
    expect(catalog.currentPage).toBe(3);

    await act(async () => catalog.setSortBy("activity"));
    await vi.waitFor(() => expect(searchSessionPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "activity", offset: 0 }),
    ));
    expect(catalog.sortBy).toBe("activity");
    expect(catalog.currentPage).toBe(1);

    await act(async () => catalog.setSortBy("smart"));
    await vi.waitFor(() => expect(searchSessionPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "smart", offset: 0 }),
    ));
    expect(catalog.currentPage).toBe(1);
  });
});

function session(sessionKey: string): SessionSearchResult {
  return { sessionKey, rawId: sessionKey, source: "codex-cli" } as SessionSearchResult;
}
