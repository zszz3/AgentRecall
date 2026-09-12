// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageActions, MessageToolsProvider, MessageToolsToolbar } from "./message-tools";
import { ExportReviewDialog } from "./export-review-dialog";
import { findRedactions, type MessageBookmark } from "../../../../core/message-tools";
import type { MessageToolsApi } from "../../../../shared/ipc/message-tools";

let container: HTMLDivElement;
let root: Root;
let bookmarks: MessageBookmark[];
let api: MessageToolsApi;
const bookmark = { sessionKey: "codex:test", messageIndex: 0, resolvedMessageIndex: 0, fingerprint: "a".repeat(64), title: "Test", excerpt: "Important solution", createdAt: 1 };
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  bookmarks = [];
  api = {
    list: vi.fn(async () => [...bookmarks]),
    set: vi.fn(async () => { bookmarks = [bookmark]; }),
    remove: vi.fn(async () => { bookmarks = []; }),
    copyLink: vi.fn(async () => {}), open: vi.fn(async () => {}),
    resolve: vi.fn(), takePending: vi.fn(async () => null), onOpen: vi.fn(() => () => {}),
    prepare: vi.fn(async () => ({ id: "review", text: "email a@example.com", findings: findRedactions("email a@example.com"), format: "markdown" as const })),
    addCustom: vi.fn(), save: vi.fn(async () => true), release: vi.fn(async () => {}),
  };
  Object.defineProperty(window, "sessionSearch", { configurable: true, value: { messageTools: api } });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(label));
  expect(button).toBeTruthy(); await act(async () => button!.click());
}

describe("important messages", () => {
  it("saves a message, opens its exact location, copies a link and removes the bookmark", async () => {
    await act(async () => root.render(<MessageToolsProvider sessionKey="codex:test" language="en" enabled>
      <MessageToolsToolbar /><MessageActions index={0} />
    </MessageToolsProvider>));
    await click("Bookmark");
    expect(api.set).toHaveBeenCalledWith("codex:test", 0, true);
    expect(container.querySelector('[aria-pressed="true"]')).toBeTruthy();
    await click("Important messages"); await click("Important solution");
    expect(api.open).toHaveBeenCalledWith(bookmark);
    await click("Copy message link"); expect(api.copyLink).toHaveBeenCalledWith("codex:test", 0);
    await click("Bookmarked"); expect(api.remove).toHaveBeenCalledWith(bookmark);
    expect(bookmarks).toEqual([]);
  });
  it("reports a failed save without marking the message as saved", async () => {
    vi.mocked(api.set).mockRejectedValue(new Error("Database unavailable"));
    await act(async () => root.render(<MessageToolsProvider sessionKey="codex:test" language="en" enabled><MessageActions index={0} /></MessageToolsProvider>));
    await click("Bookmark");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Database unavailable");
    expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
  });
});

describe("export review", () => {
  it("shows redacted output, highlights original matches and saves selected replacements", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<ExportReviewDialog sessionKey="codex:test" language="en" onClose={onClose} />));
    expect(container.querySelector("pre")?.textContent).toBe("email [EMAIL]");
    const original = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).at(-1)!;
    await act(async () => original.click());
    expect(container.querySelector("pre mark")?.textContent).toBe("a@example.com");
    const checkbox = container.querySelector<HTMLInputElement>('.export-review-finding input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    await click("Save reviewed export");
    expect(api.save).toHaveBeenCalledWith("review", []);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("keeps the preview available after a cancelled native save dialog", async () => {
    vi.mocked(api.save).mockResolvedValue(false);
    const onClose = vi.fn();
    await act(async () => root.render(<ExportReviewDialog sessionKey="codex:test" language="en" onClose={onClose} />));
    await click("Save reviewed export");
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector("pre")?.textContent).toBe("email [EMAIL]");
  });
});
