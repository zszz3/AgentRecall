import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryStore } from "../../core/session-store";
import type { IndexedSession, SessionMessage } from "../../core/types";
import { MessageToolsService } from "./message-tools-service";

const stores: ReturnType<typeof createInMemoryStore>[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(stores.splice(0).map((store) => store.close())); });
const session: IndexedSession = {
  sessionKey: "codex:synthetic-bookmarks", rawId: "synthetic-bookmarks", source: "codex-cli",
  projectPath: "C:\\Users\\Test\\project", filePath: "C:\\fixtures\\rollout.jsonl",
  originalTitle: "mail user@example.com", firstQuestion: "hello", timestamp: 1000,
  fileMtimeMs: 1000, fileSize: 100, prUrl: null, prNumber: null,
};
const messages: SessionMessage[] = [
  { index: 0, role: "user", content: "hello", timestamp: "2026-09-01T10:00:00.000Z" },
  { index: 1, role: "assistant", content: "password=secret-value user@example.com", timestamp: "2026-09-01T10:00:01.000Z" },
];
async function setup() {
  const store = createInMemoryStore(); stores.push(store);
  await store.upsertIndexedSession(session, messages);
  const service = new MessageToolsService(store, async () => {});
  return { store, service };
}

describe("message tools persistence and export lifecycle", () => {
  it("persists bookmarks independently from session favorites and survives reindexing", async () => {
    const { store, service } = await setup();
    await service.setBookmark(session.sessionKey, 1, true);
    const saved = await store.listMessageBookmarks(session.sessionKey);
    expect(saved).toHaveLength(1);
    expect((await store.getSession(session.sessionKey))?.favorited).toBe(false);
    await store.upsertIndexedSession({ ...session, fileMtimeMs: 2000 }, messages);
    expect(await store.listMessageBookmarks(session.sessionKey)).toEqual(saved);
    const reopenedService = new MessageToolsService(store, async () => {});
    expect((await reopenedService.resolve(saved[0])).hit.messageIndex).toBe(1);
    await store.removeMessageBookmark(saved[0]);
    expect(await store.listMessageBookmarks(session.sessionKey)).toEqual([]);
  });

  it("relocates a uniquely matching message after reindexing shifts its index and rejects changed content", async () => {
    const { store, service } = await setup();
    const locator = await service.locate(session.sessionKey, 1);
    await store.upsertIndexedSession({ ...session, fileMtimeMs: 2000 }, [
      messages[0], { ...messages[0], index: 1, content: "inserted" }, { ...messages[1], index: 2 },
    ]);
    const resolved = await service.resolve(locator);
    expect(resolved.hit.messageIndex).toBe(2);

    await store.upsertIndexedSession({ ...session, fileMtimeMs: 3000 }, [messages[0], { ...messages[1], content: "replacement" }]);
    await expect(service.resolve(locator)).rejects.toThrow("changed or was removed");
  });

  it("keeps identical messages at different indices as separate bookmarks", async () => {
    const { store, service } = await setup();
    await store.upsertIndexedSession({ ...session, fileMtimeMs: 2000 }, [messages[0], { ...messages[0], index: 1 }]);
    await service.setBookmark(session.sessionKey, 0, true);
    await service.setBookmark(session.sessionKey, 1, true);
    const saved = await store.listMessageBookmarks(session.sessionKey);
    expect(saved).toHaveLength(2);
    await store.removeMessageBookmark(saved[0]);
    expect(await store.listMessageBookmarks(session.sessionKey)).toHaveLength(1);
  });

  it("saves the exact reviewed snapshot, enforces ownership and expires previews", async () => {
    const { store, service } = await setup();
    const review = await service.prepareExport(1, session.sessionKey, "markdown");
    const choices = review.findings.map((item) => ({ id: item.id, replacement: item.replacement }));
    const output = service.exportContent(1, review.id, choices);
    expect(output.text).not.toContain("user@example.com");
    expect(output.text).not.toContain("secret-value");
    expect(output.extension).toBe("md");
    expect((await store.getAllMessages(session.sessionKey))[1].content).toBe(messages[1].content);
    expect(() => service.exportContent(2, review.id, choices)).toThrow();
    await store.upsertIndexedSession({ ...session, fileMtimeMs: 2000 }, [{ ...messages[0], content: "new content" }]);
    expect(service.exportContent(1, review.id, choices)).toEqual(output);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(() => service.exportContent(1, review.id, choices)).toThrow("expired");
  });

  it("does not retain a pending preview after its owner closes", async () => {
    const { store } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new MessageToolsService(store, () => gate);
    const pending = service.prepareExport(3, session.sessionKey, "text");
    service.release(3);
    release();
    await expect(pending).rejects.toThrow("closed or replaced");
  });

  it("allows adding manual matches and invalidates the old preview when a new one opens", async () => {
    const { service } = await setup();
    const first = await service.prepareExport(1, session.sessionKey, "markdown");
    const next = service.addCustom(1, first.id, "hello");
    expect(next.findings.some((item) => item.kind === "custom")).toBe(true);
    await service.prepareExport(1, session.sessionKey, "text");
    expect(() => service.exportContent(1, first.id, [])).toThrow();
  });
});
