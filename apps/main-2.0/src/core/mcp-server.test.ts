import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteDatabase, toSqliteConnectionUrl } from "./sqlite/database";
import { SQLITE_MIGRATIONS } from "./sqlite/schema";
import { SessionStore } from "./session-store";

// The V2 MCP binary is intentionally standalone and has no TypeScript declarations.
import {
  cleanUserMessageContent,
  getLatestSessions,
  getSession,
  openSqliteMcpDatabase,
  searchSessions,
  setVisibility,
  tagSession,
  toggleFavorite,
// @ts-expect-error -- untyped .mjs binary
} from "../../bin/agent-recall-mcp.mjs";

describe("V2 MCP user-message cleanup", () => {
  it("removes injected notifications while retaining genuine input", () => {
    expect(cleanUserMessageContent(
      "<subagent_notification source=\"worker\">done</subagent_notification>\n真实输入",
    )).toBe("真实输入");
    expect(cleanUserMessageContent(
      "Perform any necessary follow-up actions in response to the subagent completion above. If no follow-up work is needed, no further action is required.",
    )).toBe("");
    expect(cleanUserMessageContent(
      "<timestamp>Friday</timestamp>\n<system_notification><task>done</task></system_notification>\n<user_query>真实输入</user_query>",
    )).toBe("真实输入");
  });

  it("keeps paging totals aligned when cached rows still contain notifications", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-mcp-notif-"));
    const dbPath = path.join(dir, "agent-recall.sqlite");
    const sqlite = SqliteDatabase.open(dbPath, { migrations: SQLITE_MIGRATIONS });
    await sqlite.initialize();
    const store = new SessionStore(sqlite);
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    await store.upsertIndexedSession(
      {
        sessionKey: "codex:test",
        rawId: "test",
        source: "codex-cli",
        environmentId: "local",
        storageEnvironmentId: "local",
        projectPath: "/repo",
        filePath: "/repo/session.jsonl",
        originalTitle: "Test",
        firstQuestion: "Question",
        timestamp: now,
        fileMtimeMs: now + 1,
        fileSize: 128,
        prUrl: null,
        prNumber: null,
      },
      [
        { role: "user", content: "<subagent_notification>done</subagent_notification>", timestamp: new Date(now).toISOString(), index: 0 },
        { role: "user", content: "<task-notification>done</task-notification>\n真实输入", timestamp: new Date(now + 1).toISOString(), index: 1 },
        { role: "assistant", content: "done", timestamp: new Date(now + 2).toISOString(), index: 2 },
      ],
    );
    await store.close();

    const mcpDb = await openSqliteMcpDatabase(toSqliteConnectionUrl(dbPath));
    try {
      await expect(getSession(mcpDb, { sessionKey: "codex:test", maxMessages: 40 }))
        .resolves.toMatchObject({
          totalMessages: 2,
          returned: 2,
          nextOffset: null,
          messages: [
            { role: "user", content: "真实输入" },
            { role: "assistant", content: "done" },
          ],
        });
    } finally {
      await mcpDb.end();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports search, read, latest, tags, favorites, and visibility on a SQLite database", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-mcp-sqlite-"));
    const dbPath = path.join(dir, "agent-recall.sqlite");
    const sqlite = SqliteDatabase.open(dbPath, { migrations: SQLITE_MIGRATIONS });
    await sqlite.initialize();
    const store = new SessionStore(sqlite);
    const now = new Date("2026-10-15T08:00:00.000Z").getTime();
    await store.upsertIndexedSession(
      {
        sessionKey: "codex:sqlite-mcp-1",
        rawId: "sqlite-mcp-1",
        source: "codex-cli",
        environmentId: "local",
        storageEnvironmentId: "local",
        projectPath: "/repo/mcp-demo",
        filePath: "/repo/mcp-demo/session.jsonl",
        originalTitle: "SQLite MCP Session",
        firstQuestion: "检查网关认证失败",
        timestamp: now,
        fileMtimeMs: now + 500,
        fileSize: 512,
        prUrl: null,
        prNumber: null,
      },
      [
        { role: "user", content: "检查网关认证失败原因", timestamp: new Date(now).toISOString(), index: 0 },
        { role: "assistant", content: "发现 token_expiry 配置缺失。", timestamp: new Date(now + 100).toISOString(), index: 1 },
      ],
    );
    await store.close();

    const mcpDb = await openSqliteMcpDatabase(toSqliteConnectionUrl(dbPath));
    try {
      const hits = await searchSessions(mcpDb, { query: "token_expiry", source: "codex-cli" });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ sessionKey: "codex:sqlite-mcp-1", project: "/repo/mcp-demo" });

      const shortHits = await searchSessions(mcpDb, { query: "认证" });
      expect(shortHits).toHaveLength(1);

      const latest = await getLatestSessions(mcpDb, { projectPath: "mcp-demo", limit: 5 });
      expect(latest.map((item: { sessionKey: string }) => item.sessionKey)).toEqual(["codex:sqlite-mcp-1"]);

      const loaded = await getSession(mcpDb, { sessionKey: "codex:sqlite-mcp-1", maxMessages: 10 });
      expect(loaded).toMatchObject({ totalMessages: 2, returned: 2, nextOffset: null });

      expect(await tagSession(mcpDb, { sessionKey: "codex:sqlite-mcp-1", action: "add", tag: "pinned-note" }))
        .toMatchObject({ ok: true, tags: ["pinned-note"] });
      expect(await tagSession(mcpDb, { sessionKey: "codex:sqlite-mcp-1", action: "remove", tag: "pinned-note" }))
        .toMatchObject({ ok: true, tags: [] });
      expect(await toggleFavorite(mcpDb, { sessionKey: "codex:sqlite-mcp-1", favorited: true }))
        .toMatchObject({ ok: true, favorited: true });
      expect(await setVisibility(mcpDb, { sessionKey: "codex:sqlite-mcp-1", visibility: "hidden" }))
        .toMatchObject({ ok: true, favorited: true, hidden: true });
      expect(await setVisibility(mcpDb, { sessionKey: "codex:sqlite-mcp-1", visibility: "default" }))
        .toMatchObject({ ok: true, favorited: true, hidden: false });
    } finally {
      await mcpDb.end();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
