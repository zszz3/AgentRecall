import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MetadataStore } from "./metadata";
import { migrateSessionStore } from "./schema";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

describe("MetadataStore", () => {
  it("keeps one local session binding for each remote session", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new MetadataStore(db);
      store.upsertSessionSyncBinding({
        localSessionKey: "local:old",
        remoteSessionId: "remote-1",
        lastLocalRevision: "local-a",
        lastRemoteRevision: "remote-a",
        lastSyncedAt: 1,
        direction: "upload",
      });
      store.upsertSessionSyncBinding({
        localSessionKey: "local:new",
        remoteSessionId: "remote-1",
        lastLocalRevision: "local-b",
        lastRemoteRevision: "remote-b",
        lastSyncedAt: 2,
        direction: "restore",
      });

      expect(store.getSessionSyncBindingForLocalKey("local:old")).toBeNull();
      expect(store.getSessionSyncBindingForRemoteId("remote-1")).toEqual({
        localSessionKey: "local:new",
        remoteSessionId: "remote-1",
        lastLocalRevision: "local-b",
        lastRemoteRevision: "remote-b",
        lastSyncedAt: 2,
        direction: "restore",
      });
    } finally {
      db.close();
    }
  });

  it("stores provider secrets separately and returns migration history newest first", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new MetadataStore(db);
      store.setApiProviderKey("codex", " deepseek ", " secret-key ");
      expect(store.getApiProviderKey("codex", "deepseek")).toBe("secret-key");

      store.recordSessionMigration({
        id: "migration-a",
        sourceSessionKey: "codex:session-1",
        sourceAgent: "codex",
        targetAgent: "claude",
        targetSessionId: "claude-a",
        targetFilePath: "/tmp/a.jsonl",
        strategy: "complete",
        createdAt: 1,
      });
      store.recordSessionMigration({
        id: "migration-b",
        sourceSessionKey: "codex:session-1",
        sourceAgent: "codex",
        targetAgent: "tcodex",
        targetSessionId: "tcodex-b",
        targetFilePath: "/tmp/b.jsonl",
        strategy: "ai-compressed",
        createdAt: 2,
      });

      expect(store.listSessionMigrations("codex:session-1").map((migration) => migration.id)).toEqual([
        "migration-b",
        "migration-a",
      ]);
    } finally {
      db.close();
    }
  });
});
