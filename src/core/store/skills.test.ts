import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSessionStore } from "./schema";
import { SkillStore } from "./skills";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

describe("SkillStore", () => {
  it("tracks source freshness and aggregates usage events", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new SkillStore(db);
      const source = {
        agent: "codex" as const,
        kind: "codex-session" as const,
        path: "/tmp/session.jsonl",
        mtimeMs: 10,
        fileSize: 20,
      };

      expect(store.isSkillUsageSourceFresh(source)).toBe(false);
      store.upsertSkillUsageSource(source, [
        { agent: "codex", skill: "review", timestamp: 100 },
        { agent: "codex", skill: "review", timestamp: 200 },
      ]);

      expect(store.isSkillUsageSourceFresh(source)).toBe(true);
      expect(store.getSkillUsageSnapshot()).toMatchObject({
        exists: true,
        totalEvents: 2,
        stats: [{ skill: "review", count: 2, lastUsedAt: 200 }],
      });

      store.pruneSkillUsageSources([]);
      expect(store.getSkillUsageSnapshot()).toMatchObject({ exists: false, totalEvents: 0, stats: [] });
    } finally {
      db.close();
    }
  });

  it("moves a remote binding to the latest local path without violating uniqueness", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new SkillStore(db);
      store.upsertSkillSyncBinding({
        localSkillPath: "/skills/old/SKILL.md",
        portableIdentity: "codex-user/review",
        remoteSkillId: "remote-1",
        remoteUpdatedAt: "2026-07-16T00:00:00.000Z",
        remoteVersion: 1,
        lastContentHash: "old-hash",
        lastSyncedAt: 1,
        direction: "upload",
      });
      store.upsertSkillSyncBinding({
        localSkillPath: "/skills/new/SKILL.md",
        portableIdentity: "codex-user/review",
        remoteSkillId: "remote-1",
        remoteUpdatedAt: "2026-07-17T00:00:00.000Z",
        remoteVersion: 2,
        lastContentHash: "new-hash",
        lastSyncedAt: 2,
        direction: "download",
      });

      expect(store.getSkillSyncBindingForLocalPath("/skills/old/SKILL.md")).toBeNull();
      expect(store.getSkillSyncBindingForRemoteId("remote-1")).toMatchObject({
        localSkillPath: "/skills/new/SKILL.md",
        portableIdentity: "codex-user/review",
        remoteVersion: 2,
        lastContentHash: "new-hash",
        direction: "download",
      });
    } finally {
      db.close();
    }
  });
});
