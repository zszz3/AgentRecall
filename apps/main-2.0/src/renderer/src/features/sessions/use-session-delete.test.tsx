// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
  type SessionBulkDeletePreview,
} from "../../../../core/session-bulk-delete";
import type { SessionSearchResult } from "../../../../core/types";
import type { ActionStatus } from "../../app-types";
import { useSessionDelete, type SessionDeleteController } from "./use-session-delete";

const session = { sessionKey: "codex:a", source: "codex-cli", sourceAvailable: true } as SessionSearchResult;

function preview(overrides: Partial<SessionBulkDeletePreview> = {}): SessionBulkDeletePreview {
  return {
    requestedCount: 1,
    matchedCount: 1,
    expandedCount: 1,
    deletableCount: 1,
    hasRelatedSessions: false,
    includesOpenSession: false,
    liveSessionCheckFailed: false,
    confirmationFingerprint: "fp-1",
    sourceCounts: [],
    skipped: [],
    ...overrides,
  };
}

describe("useSessionDelete", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: SessionDeleteController;
  let status: ActionStatus | null;
  const api = { previewBulkDelete: vi.fn(), deleteSession: vi.fn() };
  const onDeleted = vi.fn(async () => undefined);
  const onAlreadyDeleted = vi.fn(async () => undefined);

  function Harness({ openSessionKey }: { openSessionKey?: string }) {
    const [current, setStatus] = useState<ActionStatus | null>(null);
    status = current;
    controller = useSessionDelete({
      api,
      openSessionKey,
      checkLiveSessions: async () => ({ liveSessionKeys: [], liveSessionCheckFailed: false }),
      setStatus,
      onDeleted,
      onAlreadyDeleted,
      t: (en) => en,
    });
    return null;
  }

  async function render(openSessionKey?: string): Promise<void> {
    await act(async () => root.render(createElement(Harness, { openSessionKey })));
  }

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api.previewBulkDelete.mockReset();
    api.deleteSession.mockReset();
    onDeleted.mockClear();
    onAlreadyDeleted.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("previews the deletion and keeps only the latest request's preview", async () => {
    let resolveFirst!: (value: SessionBulkDeletePreview) => void;
    api.previewBulkDelete
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(preview({ expandedCount: 3, skipped: [{ sessionKey: "codex:b", reason: "live" }] as SessionBulkDeletePreview["skipped"] }));
    await render("codex:a");

    await act(async () => controller.requestDelete(session));
    await act(async () => controller.requestDelete(session));
    await act(async () => resolveFirst(preview({ expandedCount: 9 })));

    expect(api.previewBulkDelete).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionKeys: ["codex:a"],
      protectFavorites: false,
      openSessionKey: "codex:a",
    }));
    expect(controller.request).toMatchObject({ session, cascadeCount: 3, hasLiveSession: true, confirmationFingerprint: "fp-1" });
  });

  it("confirms a cascading deletion explicitly and reports the deleted file", async () => {
    api.previewBulkDelete.mockResolvedValue(preview({ expandedCount: 2, confirmationFingerprint: "fp-2" }));
    api.deleteSession.mockResolvedValue(true);
    await render();
    await act(async () => controller.requestDelete(session));

    await act(async () => controller.confirm());

    expect(api.deleteSession).toHaveBeenCalledWith("codex:a", {
      confirmed: true,
      allowLiveSessions: false,
      allowUnverifiedLiveSessions: false,
      confirmationFingerprint: "fp-2",
    });
    expect(onDeleted).toHaveBeenCalledWith(session);
    expect(controller.request).toBeNull();
    expect(controller.deleting).toBe(false);
    expect(status).toEqual({ kind: "success", message: "Session file deleted." });
  });

  it("asks again with a fresh preview when the session tree changed before deletion", async () => {
    api.previewBulkDelete.mockResolvedValue(preview());
    api.deleteSession.mockRejectedValue(new Error(SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE));
    await render();
    await act(async () => controller.requestDelete(session));

    await act(async () => controller.confirm());

    expect(api.previewBulkDelete).toHaveBeenCalledTimes(2);
    expect(controller.request?.session).toBe(session);
    expect(status).toEqual({
      kind: "error",
      message: "The session tree changed. Review the updated deletion warning and confirm again.",
    });
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("drops a pending preview when the request is cancelled", async () => {
    let resolvePreview!: (value: SessionBulkDeletePreview) => void;
    api.previewBulkDelete.mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
    await render();
    await act(async () => controller.requestDelete(session));

    await act(async () => controller.cancel());
    await act(async () => resolvePreview(preview()));

    expect(controller.request).toBeNull();
  });
});
