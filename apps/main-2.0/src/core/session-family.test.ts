import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IndexedSession, SessionMessage, SessionTraceEvent } from "./types";
import { findSqliteSessionFamily as findSessionFamily } from "./sqlite/session-family";
import { SqliteDatabase } from "./sqlite/database";
import { SqliteSessionRepository } from "./sqlite/session-repository";
import { SQLITE_MIGRATIONS } from "./sqlite/schema";

function session(overrides: Partial<IndexedSession>): IndexedSession {
  return {
    sessionKey: "codex:root",
    rawId: "root",
    source: "codex-cli",
    projectPath: "/repo",
    filePath: "/tmp/root.jsonl",
    originalTitle: "Root",
    firstQuestion: "Root",
    timestamp: Date.parse("2026-08-12T09:00:00.000Z"),
    fileMtimeMs: 1,
    fileSize: 1,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

describe("findSessionFamily", () => {
  let database: SqliteDatabase;
  let repository: SqliteSessionRepository;

  beforeEach(async () => {
    database = SqliteDatabase.open(":memory:", {
      migrations: SQLITE_MIGRATIONS,
    });
    await database.initialize();
    repository = new SqliteSessionRepository(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("reports the parent Turn that spawned each subagent", async () => {
    const messages: SessionMessage[] = [
      {
        index: 0,
        role: "user",
        content: "first",
        timestamp: "2026-08-12T09:00:00.000Z",
        sourceTurnId: "turn-1",
      },
      {
        index: 1,
        role: "user",
        content: "delegate",
        timestamp: "2026-08-12T09:05:00.000Z",
        sourceTurnId: "turn-2",
      },
    ];
    const traces: SessionTraceEvent[] = [
      {
        index: 0,
        kind: "event",
        source: "codex",
        title: "Session metadata",
        detail: "",
        timestamp: "2026-08-12T08:59:00.000Z",
        eventType: "codex.session.metadata",
        status: "completed",
      },
      {
        index: 1,
        kind: "event",
        source: "codex",
        title: "agent · spawn_agent",
        detail: "",
        timestamp: "2026-08-12T09:05:01.000Z",
        eventType: "codex.collaboration.tool",
        status: "completed",
        sourceTurnId: "turn-2",
        attributes: {
          codex: { rawType: "CollabAgentToolCall" },
          collaboration: { tool: "spawn_agent", receiverThreadIds: ["child"] },
        },
      },
    ];
    await repository.upsertIndexedSession(session({}), messages, [], traces);
    await repository.upsertIndexedSession(session({
      sessionKey: "codex:child",
      rawId: "child",
      filePath: "/tmp/child.jsonl",
      originalTitle: "Child",
      firstQuestion: "Child",
      isSubagent: true,
      parentSessionId: "root",
    }), [], [], []);

    const rootFamily = await findSessionFamily(database, "codex:root");
    expect(rootFamily.children[0].originTurnIndex).toBe(1);
    const childFamily = await findSessionFamily(database, "codex:child");
    expect(childFamily.parentOriginTurnIndex).toBe(1);
    expect(childFamily.parent?.originTurnIndex).toBeNull();
  });

  it("recognizes the persisted subagent started activity as the spawn origin", async () => {
    const messages: SessionMessage[] = [
      {
        index: 0,
        role: "user",
        content: "first",
        timestamp: "2026-08-12T09:00:00.000Z",
        sourceTurnId: "turn-1",
      },
      {
        index: 1,
        role: "user",
        content: "delegate",
        timestamp: "2026-08-12T09:05:00.000Z",
        sourceTurnId: "turn-2",
      },
    ];
    const traces: SessionTraceEvent[] = [{
      index: 0,
      kind: "event",
      source: "codex",
      title: "subagent · started",
      detail: "",
      timestamp: "2026-08-12T09:05:01.000Z",
      eventType: "codex.collaboration.activity",
      status: "completed",
      sourceTurnId: "turn-2",
      attributes: {
        codex: { rawType: "sub_agent_activity" },
        collaboration: { kind: "started", agentThreadId: "child" },
      },
    }];
    await repository.upsertIndexedSession(session({}), messages, [], traces);
    await repository.upsertIndexedSession(session({
      sessionKey: "codex:child",
      rawId: "child",
      filePath: "/tmp/child.jsonl",
      originalTitle: "Child",
      firstQuestion: "Child",
      isSubagent: true,
      parentSessionId: "root",
    }), [], [], []);

    expect((await findSessionFamily(database, "codex:root")).children[0].originTurnIndex).toBe(1);
    expect((await findSessionFamily(database, "codex:child")).parentOriginTurnIndex).toBe(1);
  });

  it("falls back to the nearest visible parent Turn when a spawn source Turn is unmatched", async () => {
    const messages: SessionMessage[] = [
      {
        index: 0,
        role: "user",
        content: "first",
        timestamp: "2026-08-12T09:00:00.000Z",
        sourceTurnId: "turn-1",
      },
      {
        index: 1,
        role: "user",
        content: "delegate",
        timestamp: "2026-08-12T09:05:00.000Z",
        sourceTurnId: "turn-2",
      },
    ];
    const traces: SessionTraceEvent[] = [{
      index: 0,
      kind: "event",
      source: "codex",
      title: "agent · spawn_agent",
      detail: "",
      timestamp: "2026-08-12T09:05:01.000Z",
      eventType: "codex.collaboration.tool",
      status: "completed",
      sourceTurnId: "unmatched-turn",
      attributes: {
        collaboration: { tool: "spawn_agent", receiverThreadIds: ["child"] },
      },
    }];
    await repository.upsertIndexedSession(session({}), messages, [], traces);
    await repository.upsertIndexedSession(session({
      sessionKey: "codex:child",
      rawId: "child",
      filePath: "/tmp/child.jsonl",
      originalTitle: "Child",
      firstQuestion: "Child",
      isSubagent: true,
      parentSessionId: "root",
    }), [], [], []);

    expect((await findSessionFamily(database, "codex:root")).children[0].originTurnIndex).toBe(1);
    expect((await findSessionFamily(database, "codex:child")).parentOriginTurnIndex).toBe(1);
  });

  it("recognizes spawn_agent newThreadId and singular receiverThreadId", async () => {
    const messages: SessionMessage[] = [
      {
        index: 0,
        role: "user",
        content: "first",
        timestamp: "2026-08-12T09:00:00.000Z",
        sourceTurnId: "turn-1",
      },
      {
        index: 1,
        role: "user",
        content: "delegate",
        timestamp: "2026-08-12T09:05:00.000Z",
        sourceTurnId: "turn-2",
      },
    ];
    await repository.upsertIndexedSession(session({}), messages, [], [{
      index: 0,
      kind: "event",
      source: "codex",
      title: "agent · spawn_agent",
      detail: "",
      timestamp: "2026-08-12T09:05:01.000Z",
      eventType: "codex.collaboration.tool",
      status: "completed",
      sourceTurnId: "turn-2",
      attributes: {
        collaboration: { tool: "spawn_agent", newThreadId: "child-new" },
      },
    }]);
    await repository.upsertIndexedSession(session({
      sessionKey: "codex:child-new",
      rawId: "child-new",
      filePath: "/tmp/child-new.jsonl",
      originalTitle: "Child new",
      firstQuestion: "Child new",
      isSubagent: true,
      parentSessionId: "root",
    }), [], [], []);
    expect((await findSessionFamily(database, "codex:root")).children[0].originTurnIndex).toBe(1);

    await repository.upsertIndexedSession(session({
      sessionKey: "codex:root-singular",
      rawId: "root-singular",
      filePath: "/tmp/root-singular.jsonl",
      originalTitle: "Root singular",
      firstQuestion: "Root singular",
    }), messages, [], [{
      index: 0,
      kind: "event",
      source: "codex",
      title: "collab spawn",
      detail: "",
      timestamp: "2026-08-12T09:05:01.000Z",
      eventType: "codex.collaboration.tool",
      status: "completed",
      sourceTurnId: "turn-2",
      attributes: {
        codex: { rawType: "collab_spawn_agent" },
        collaboration: { receiverThreadId: "child-singular" },
      },
    }]);
    await repository.upsertIndexedSession(session({
      sessionKey: "codex:child-singular",
      rawId: "child-singular",
      filePath: "/tmp/child-singular.jsonl",
      originalTitle: "Child singular",
      firstQuestion: "Child singular",
      isSubagent: true,
      parentSessionId: "root-singular",
    }), [], [], []);
    expect((await findSessionFamily(database, "codex:root-singular")).children[0].originTurnIndex).toBe(1);
    expect((await findSessionFamily(database, "codex:child-singular")).parentOriginTurnIndex).toBe(1);
  });

  it("does not cross source or environment boundaries when resolving origin", async () => {
    const now = Date.now();
    database.run(`
      INSERT INTO environments (
        id, kind, label, host_alias, host, user, port, auth_mode,
        identity_file, enabled, sync_state, last_synced_at, last_error,
        created_at, updated_at
      ) VALUES (
        'ssh-dev', 'ssh', 'SSH dev', null, null, null, null, 'none',
        null, 1, 'idle', null, null, ?, ?
      )
    `, now, now);
    const messages: SessionMessage[] = [
      {
        index: 0,
        role: "user",
        content: "first",
        timestamp: "2026-08-12T09:00:00.000Z",
        sourceTurnId: "turn-1",
      },
      {
        index: 1,
        role: "user",
        content: "delegate",
        timestamp: "2026-08-12T09:05:00.000Z",
        sourceTurnId: "turn-2",
      },
    ];
    const spawn = (childId: string): SessionTraceEvent => ({
      index: 0,
      kind: "event",
      source: "codex",
      title: "agent · spawn_agent",
      detail: "",
      timestamp: "2026-08-12T09:05:01.000Z",
      eventType: "codex.collaboration.tool",
      status: "completed",
      sourceTurnId: "turn-2",
      attributes: {
        collaboration: { tool: "spawn_agent", receiverThreadIds: [childId] },
      },
    });
    await repository.upsertIndexedSession(session({}), messages, [], [spawn("visible")]);
    await repository.upsertIndexedSession(session({
      sessionKey: "codex:visible",
      rawId: "visible",
      filePath: "/tmp/visible.jsonl",
      originalTitle: "Visible",
      firstQuestion: "Visible",
      isSubagent: true,
      parentSessionId: "root",
    }), [], [], []);
    await repository.upsertIndexedSession(session({
      sessionKey: "ssh:duplicate",
      rawId: "duplicate",
      filePath: "/tmp/ssh-duplicate.jsonl",
      originalTitle: "SSH duplicate",
      firstQuestion: "SSH duplicate",
      environmentId: "ssh-dev",
      isSubagent: true,
      parentSessionId: "root",
    }), [], [], []);
    await repository.upsertIndexedSession(session({
      sessionKey: "claude:duplicate",
      rawId: "duplicate",
      source: "claude-cli",
      filePath: "/tmp/claude-duplicate.jsonl",
      originalTitle: "Claude duplicate",
      firstQuestion: "Claude duplicate",
      isSubagent: true,
      parentSessionId: "root",
    }), [], [], []);

    const family = await findSessionFamily(database, "codex:root");
    expect(family.children.map((node) => node.sessionKey)).toEqual(["codex:visible"]);
    expect(family.children[0].originTurnIndex).toBe(1);
  });

  it("keeps nested descendant origins scoped to the current family", async () => {
    const messages: SessionMessage[] = [
      {
        index: 0,
        role: "user",
        content: "first",
        timestamp: "2026-08-12T09:00:00.000Z",
        sourceTurnId: "turn-1",
      },
      {
        index: 1,
        role: "user",
        content: "delegate",
        timestamp: "2026-08-12T09:05:00.000Z",
        sourceTurnId: "turn-2",
      },
    ];
    const spawn = (childId: string): SessionTraceEvent => ({
      index: 0,
      kind: "event",
      source: "codex",
      title: "agent · spawn_agent",
      detail: "",
      timestamp: "2026-08-12T09:05:01.000Z",
      eventType: "codex.collaboration.tool",
      status: "completed",
      sourceTurnId: "turn-2",
      attributes: {
        collaboration: { tool: "spawn_agent", newThreadId: childId },
      },
    });
    await repository.upsertIndexedSession(session({}), messages, [], [spawn("child")]);
    await repository.upsertIndexedSession(session({
      sessionKey: "codex:child",
      rawId: "child",
      filePath: "/tmp/child.jsonl",
      originalTitle: "Child",
      firstQuestion: "Child",
      isSubagent: true,
      parentSessionId: "root",
    }), messages, [], [spawn("grandchild")]);
    await repository.upsertIndexedSession(session({
      sessionKey: "codex:grandchild",
      rawId: "grandchild",
      filePath: "/tmp/grandchild.jsonl",
      originalTitle: "Grandchild",
      firstQuestion: "Grandchild",
      isSubagent: true,
      parentSessionId: "child",
    }), [], [], []);
    await repository.upsertIndexedSession(session({
      sessionKey: "codex:unrelated",
      rawId: "unrelated",
      filePath: "/tmp/unrelated.jsonl",
      originalTitle: "Unrelated",
      firstQuestion: "Unrelated",
    }), messages, [], [spawn("other-child")]);

    const rootFamily = await findSessionFamily(database, "codex:root");
    expect(rootFamily.children[0].originTurnIndex).toBe(1);
    expect(rootFamily.children[0].children[0].originTurnIndex).toBe(1);
    expect((await findSessionFamily(database, "codex:grandchild")).parentOriginTurnIndex).toBe(1);
  });
});
