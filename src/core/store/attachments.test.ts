import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../session-store";
import type { IndexedSession, SessionMessage } from "../types";

describe("stored session attachments", () => {
  it("persists safe metadata while keeping the managed path out of renderer messages", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-recall-attachment-store-"));
    const sessionPath = path.join(directory, "session.jsonl");
    writeFileSync(sessionPath, "{}\n", "utf8");
    const store = new SessionStore(path.join(directory, "sessions.sqlite"));
    try {
      const session: IndexedSession = {
        sessionKey: "codex:test",
        rawId: "test",
        source: "codex-cli",
        projectPath: directory,
        filePath: sessionPath,
        originalTitle: "Attachment",
        firstQuestion: "See image",
        timestamp: 1,
        fileMtimeMs: 1,
        fileSize: 3,
        prUrl: null,
        prNumber: null,
      };
      const messages: SessionMessage[] = [{
        index: 0,
        role: "user",
        content: "See image",
        timestamp: "2026-07-23T00:00:00.000Z",
        attachments: [{
          id: "image-1",
          fileName: "shot.png",
          mimeType: "image/png",
          previewKind: "image",
          status: "available",
          source: { kind: "inline", value: Buffer.from("image").toString("base64") },
        }],
      }];
      store.upsertIndexedSession(session, messages);

      const stored = store.getMessages(session.sessionKey);
      expect(stored[0].attachments).toEqual([
        expect.objectContaining({ id: "0-0-image-1", fileName: "shot.png", status: "available" }),
      ]);
      expect(stored[0].attachments?.[0]).not.toHaveProperty("source");
      const file = store.getAttachmentFile(session.sessionKey, "0-0-image-1");
      expect(readFileSync(file!.cachePath, "utf8")).toBe("image");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
