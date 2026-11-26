// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionBulkDeletePreview } from "../../../core/session-bulk-delete";
import type { SessionSearchResult } from "../../../core/types";
import { BulkDeleteDialog, CommandDialog, DeleteSessionDialog } from "./session-dialogs";

function session(sessionKey: string, extra: Partial<SessionSearchResult> = {}): SessionSearchResult {
  return {
    sessionKey,
    source: "codex-cli",
    sourceAvailable: true,
    displayTitle: `Session ${sessionKey}`,
    filePath: `/fixtures/${sessionKey}.jsonl`,
    ...extra,
  } as SessionSearchResult;
}

function bulkPreview(overrides: Partial<SessionBulkDeletePreview> = {}): SessionBulkDeletePreview {
  return {
    requestedCount: 1,
    matchedCount: 1,
    expandedCount: 1,
    deletableCount: 1,
    hasRelatedSessions: false,
    includesOpenSession: false,
    liveSessionCheckFailed: false,
    confirmationFingerprint: "preview",
    sourceCounts: [{ source: "codex-cli", count: 1 }],
    skipped: [],
    ...overrides,
  };
}

async function typeInto(input: HTMLInputElement | null, value: string): Promise<void> {
  if (!input) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("session dialogs", () => {
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

  const renderDelete = (overrides: Partial<Parameters<typeof DeleteSessionDialog>[0]> = {}) =>
    act(async () => root.render(createElement(DeleteSessionDialog, {
      session: session("ordinary"),
      cascadeCount: 1,
      hasLiveSession: false,
      isOpen: false,
      blockedMessage: null,
      language: "zh",
      deleting: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      ...overrides,
    })));

  const renderBulk = (overrides: Partial<Parameters<typeof BulkDeleteDialog>[0]> = {}) =>
    act(async () => root.render(createElement(BulkDeleteDialog, {
      mode: "selection",
      preview: bulkPreview(),
      dateValue: "",
      favoriteCount: 0,
      busy: false,
      language: "zh",
      onDateChange: vi.fn(),
      onPreview: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      ...overrides,
    })));

  const dangerBtn = () => container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action");
  const confirmInput = () => container.querySelector<HTMLInputElement>(".delete-confirmation-field input");

  it("offers restoring the source title only for renamed Cursor sessions", async () => {
    const onRestoreDefault = vi.fn();
    const base = { tags: [], language: "zh" as const, onChange: vi.fn(), onRestoreDefault, onSubmit: vi.fn(), onCancel: vi.fn() };
    await act(async () => root.render(createElement(CommandDialog, {
      ...base,
      dialog: { kind: "rename", session: session("c1", { source: "cursor-agent", customTitle: "Custom", originalTitle: "Orig" }), value: "Custom", useDefaultTitle: false },
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".rename-default-button")?.click());
    expect(onRestoreDefault).toHaveBeenCalledOnce();

    await act(async () => root.render(createElement(CommandDialog, {
      ...base,
      dialog: { kind: "rename", session: session("c2", { customTitle: "Custom" }), value: "Custom", useDefaultTitle: false },
    })));
    expect(container.querySelector(".rename-default-button")).toBeNull();
  });

  it("enforces single-session deletion safeguards, blocks unknown errors, and resets typed confirmation on change", async () => {
    const onConfirm = vi.fn();
    await renderDelete({ onConfirm });
    expect(confirmInput()).toBeNull();
    await act(async () => dangerBtn()?.click());
    expect(onConfirm).toHaveBeenCalledOnce();

    await renderDelete({ blockedMessage: "Preview error" });
    expect(confirmInput()).toBeNull();
    expect(dangerBtn()?.disabled).toBe(true);

    const onForce = vi.fn();
    await renderDelete({ session: session("live"), hasLiveSession: true, onConfirm: onForce });
    expect(dangerBtn()?.disabled).toBe(true);
    await typeInto(confirmInput(), "确认删除");
    expect(dangerBtn()?.disabled).toBe(false);
    await act(async () => dangerBtn()?.click());
    expect(onForce).toHaveBeenCalledOnce();

    await renderDelete({ session: session("first"), isOpen: true, confirmationVersion: 1 });
    await typeInto(confirmInput(), "确认删除");
    await renderDelete({ session: session("second"), isOpen: true, confirmationVersion: 1 });
    expect(confirmInput()?.value).toBe("");

    await renderDelete({ session: session("same"), cascadeCount: 2, confirmationVersion: 1 });
    await typeInto(confirmInput(), "确认删除");
    await renderDelete({ session: session("same"), cascadeCount: 2, confirmationVersion: 2 });
    expect(confirmInput()?.value).toBe("");

    await renderDelete({ session: session("unverified"), liveSessionCheckFailed: true });
    expect(confirmInput()).not.toBeNull();
    expect(dangerBtn()?.disabled).toBe(true);
  });

  it("enforces bulk deletion thresholds (10+, related trees, open session) and clears confirmation on preview refresh", async () => {
    const onSimple = vi.fn();
    await renderBulk({ preview: bulkPreview({ requestedCount: 9, matchedCount: 9, expandedCount: 9, deletableCount: 9 }), favoriteCount: 1, onConfirm: onSimple });
    expect(confirmInput()).toBeNull();
    await act(async () => dangerBtn()?.click());
    expect(onSimple).toHaveBeenCalledWith(false);

    for (const preview of [
      bulkPreview({ deletableCount: 10 }),
      bulkPreview({ expandedCount: 2, deletableCount: 2, hasRelatedSessions: true }),
      bulkPreview({ includesOpenSession: true }),
    ]) {
      await renderBulk({ preview });
      expect(confirmInput()).not.toBeNull();
      expect(dangerBtn()?.disabled).toBe(true);
    }

    const onDangerous = vi.fn();
    await renderBulk({ preview: bulkPreview({ deletableCount: 10 }), onConfirm: onDangerous });
    await typeInto(confirmInput(), "确认删除");
    await act(async () => dangerBtn()?.click());
    expect(onDangerous).toHaveBeenCalledWith(true);

    await renderBulk({ preview: bulkPreview({ deletableCount: 10, liveSessionCheckFailed: true }) });
    expect(confirmInput()?.value).toBe("");
  });
});
