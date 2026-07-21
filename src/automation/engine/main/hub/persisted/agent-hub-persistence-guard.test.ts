import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { AgentHub } from "../agent-hub";
import { SqliteAppStore } from "./sqlite-store";

function incompatiblePayload() {
  return {
    version: 5,
    activeChatId: "historic-chat",
    workDir: "C:/historic",
    sessions: [{ id: "historic-chat", title: "Historic chat", configuredAgentId: "default-agent", modelId: "default", messages: [], createdAt: 1, updatedAt: 2 }],
    messages: [], events: [], tasks: [], taskMessages: [], taskEvents: [], teams: [], teamRuns: [], workflowStore: { workflows: [], runs: [] },
  };
}

describe("AgentHub persistence recovery guard", () => {
  test("does not overwrite an incompatible database with default in-memory state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-persistence-guard-"));
    const dbPath = path.join(dir, "app.db");
    const seed = new SqliteAppStore(dbPath);
    await seed.save(incompatiblePayload());
    seed.close();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.prepare("update app_settings set value_text = '4' where key = 'payload_version'").run();
    db.close();

    const hub = new AgentHub();
    await hub.loadPersistedState(dbPath);
    hub.createChat();
    await hub.flushPersistence();

    const verify = new SqliteAppStore(dbPath);
    const persisted = await verify.load() as any;
    verify.close();
    expect(persisted.version).toBe(4);
    expect(persisted.sessions).toEqual([expect.objectContaining({ id: "historic-chat", title: "Historic chat" })]);
  });
});
