// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSearchResult } from "../../../core/types";
import { BulkDeleteDialog, DeleteSessionDialog } from "./session-dialogs";

const session = {
  sessionKey: "claude:parent",
  rawId: "parent",
  source: "claude-cli",
  displayTitle: "Parent",
  filePath: "/synthetic/parent.jsonl",
  sourceAvailable: true,
} as SessionSearchResult;

describe("session delete dialogs", () => {
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

  it("warns about cascaded subagents and reports empty orphan scans", async () => {
    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session,
      cascadeCount: 3,
      blockedMessage: "关联会话正在运行，请先停止后再删除整棵会话树。",
      language: "zh",
      deleting: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })));
    expect(container.textContent).toContain("2 个关联 Subagent 会话也会被永久删除");
    expect(container.textContent).toContain("关联会话正在运行");
    const confirmationInput = container.querySelector(".delete-confirmation-field input") as HTMLInputElement;
    await act(async () => {
      const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setNativeValue?.call(confirmationInput, "确认删除");
      confirmationInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "确认删除" }));
    });
    expect([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("永久删除"))?.hasAttribute("disabled")).toBe(true);

    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session,
      cascadeCount: null,
      blockedMessage: null,
      language: "zh",
      deleting: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })));
    expect([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("永久删除"))?.hasAttribute("disabled")).toBe(true);

    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session,
      cascadeCount: 1,
      blockedMessage: null,
      language: "zh",
      deleting: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })));
    expect([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("永久删除"))?.hasAttribute("disabled")).toBe(false);

    await act(async () => root.render(createElement(BulkDeleteDialog, {
      mode: "orphans",
      preview: { requestedCount: 0, matchedCount: 0, expandedCount: 0, deletableCount: 0, sourceCounts: [], skipped: [] },
      dateValue: "",
      favoriteCount: 0,
      busy: false,
      language: "zh",
      onDateChange: vi.fn(),
      onPreview: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })));
    expect(container.textContent).toContain("未发现可清理的孤儿 Subagent 会话");
  });
});
