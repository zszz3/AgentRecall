// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSearchResult } from "../../../../core/types";
import type { ActionStatus } from "../../app-types";
import { useBulkSessionDelete, type BulkSessionDeleteController } from "./use-bulk-session-delete";

const sessions = [
  { sessionKey: "codex:a" },
  { sessionKey: "codex:b" },
] as SessionSearchResult[];

describe("useBulkSessionDelete", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: BulkSessionDeleteController;
  let status: ActionStatus | null;
  const api = { previewBulkDelete: vi.fn(), bulkDeleteSessions: vi.fn() };

  function Harness() {
    const [current, setStatus] = useState<ActionStatus | null>(null);
    status = current;
    controller = useBulkSessionDelete({
      api,
      openSessionKey: undefined,
      sessions,
      searchAllMatching: async () => sessions,
      checkLiveSessions: async () => ({ liveSessionKeys: [], liveSessionCheckFailed: false }),
      setStatus,
      onSelectionStarted: () => undefined,
      onDeleted: async () => undefined,
      t: (en) => en,
    });
    return null;
  }

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    api.previewBulkDelete.mockReset();
    api.bulkDeleteSessions.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("starts a selection from one Session and toggles every shown Session", async () => {
    await act(async () => controller.begin("codex:a"));
    expect(controller.selectionActive).toBe(true);
    expect([...controller.selectedKeys]).toEqual(["codex:a"]);

    await act(async () => controller.toggleShown());
    expect([...controller.selectedKeys].sort()).toEqual(["codex:a", "codex:b"]);
    await act(async () => controller.toggleShown());
    expect(controller.selectedKeys.size).toBe(0);

    await act(async () => controller.exit());
    expect(controller.selectionActive).toBe(false);
  });

  it("closes the orphan cleanup and reports why when its preview fails", async () => {
    api.previewBulkDelete.mockRejectedValueOnce(new Error("Index is busy"));

    await act(async () => controller.openOrphanCleanup());

    expect(api.previewBulkDelete).toHaveBeenCalledWith(expect.objectContaining({ sessionKeys: [], includeOrphanedSubagents: true }));
    expect(controller.dialog).toBeNull();
    expect(controller.busy).toBe(false);
    expect(status).toEqual({ kind: "error", message: "Index is busy" });
  });
});
