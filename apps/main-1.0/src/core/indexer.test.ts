import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { indexMigratedSessionFile, syncDefaultSessionsInBatches, syncLoadedSessionsInBatches } from "./indexer";
import { createInMemoryStore, SessionStore } from "./session-store";
import { writeMigratedSession } from "./session-migration-writers";
import { migrateSessionStore } from "./store/schema";
import type { IndexedSession, LoadedSession, MigrationTarget, PortableSession, SessionSource } from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

function session(index: number): LoadedSession {
  const id = `session-${index}`;
  const item: IndexedSession = {
    sessionKey: `codex:${id}`,
    rawId: id,
    source: "codex-cli",
    projectPath: `/repo/${index}`,
    filePath: `/tmp/${id}.jsonl`,
    originalTitle: `Session ${index}`,
    firstQuestion: `Question ${index}`,
    timestamp: index,
    fileMtimeMs: index,
    fileSize: 100 + index,
    prUrl: null,
    prNumber: null,
  };

  return {
    session: item,
    messages: [{ role: "user", content: `Question ${index}`, timestamp: "2026-06-01T10:00:00Z", index: 0 }],
  };
}

describe("indexer", () => {
  it("indexes loaded sessions in batches and yields between batches", async () => {
    const store = createInMemoryStore();
    const progress: number[] = [];
    let yields = 0;

    const status = await syncLoadedSessionsInBatches(store, [session(1), session(2), session(3)], {
      batchSize: 1,
      onProgress: (nextStatus) => progress.push(nextStatus.indexed),
      yieldToEventLoop: async () => {
        yields++;
      },
    });

    expect(progress).toEqual([1, 2, 3]);
    expect(yields).toBe(3);
    expect(status).toMatchObject({ running: false, indexed: 3, total: 3, error: null });
    expect(store.searchSessions({ query: "Question", limit: 10 })).toHaveLength(3);
  });

  it("accepts asynchronously loaded sessions without blocking batch processing", async () => {
    const store = createInMemoryStore();
    let producerYielded = false;
    const loaded = (async function* () {
      await new Promise<void>((resolve) => setImmediate(resolve));
      producerYielded = true;
      yield session(1);
      yield session(2);
    })();

    const status = await syncLoadedSessionsInBatches(store, loaded, { batchSize: 1 });

    expect(producerYielded).toBe(true);
    expect(status).toMatchObject({ indexed: 2, skipped: 0, total: 2, error: null });
  });

  it("yields when the time budget is exhausted before the batch limit", async () => {
    const store = createInMemoryStore();
    const progress: number[] = [];
    let yields = 0;
    let clock = 0;
    const loaded = (function* () {
      clock = 4;
      yield session(1);
      clock = 9;
      yield session(2);
      clock = 10;
      yield session(3);
    })();

    await syncLoadedSessionsInBatches(store, loaded, {
      batchSize: 100,
      timeBudgetMs: 8,
      now: () => clock,
      onProgress: (nextStatus) => progress.push(nextStatus.indexed),
      yieldToEventLoop: async () => {
        yields++;
      },
    });

    expect(progress).toEqual([2, 3]);
    expect(yields).toBe(2);
  });

  it("skips rebuilding unchanged sessions", async () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(session(1).session, [
      { role: "user", content: "original indexed question", timestamp: "2026-06-01T10:00:00Z", index: 0 },
    ]);

    const unchanged = session(1);
    unchanged.messages = [{ role: "user", content: "should not replace unchanged content", timestamp: "2026-06-01T10:00:00Z", index: 0 }];

    const status = await syncLoadedSessionsInBatches(store, [unchanged], { batchSize: 1 });

    expect(status).toMatchObject({ indexed: 0, skipped: 1, total: 1 });
    expect(store.searchSessions({ query: "original indexed question", limit: 10 })).toHaveLength(1);
    expect(store.searchSessions({ query: "should not replace unchanged content", limit: 10 })).toHaveLength(0);
  });

  it("continues indexing after one session write fails", async () => {
    const store = createInMemoryStore();
    const originalUpsert = store.upsertIndexedSession.bind(store);
    vi.spyOn(store, "upsertIndexedSession")
      .mockImplementationOnce(() => {
        throw new Error("session write failed");
      })
      .mockImplementation((...args) => originalUpsert(...args));
    const progress: Array<{ error: string | null }> = [];
    const diagnostics: unknown[] = [];

    const status = await syncLoadedSessionsInBatches(store, [session(1), session(2)], {
      batchSize: 1,
      onProgress: (next) => progress.push(next),
      indexFailureLogPath: "/tmp/session-index-failures.jsonl",
      logIndexFailure: async (diagnostic) => {
        await Promise.resolve();
        diagnostics.push(diagnostic);
      },
    });

    expect(status).toMatchObject({ running: false, indexed: 1, skipped: 1, total: 2 });
    expect(status.error).toContain("1 session could not be indexed");
    expect(status.error).toContain("Diagnostic log: /tmp/session-index-failures.jsonl");
    expect(progress.every((next) => next.error === null)).toBe(true);
    expect(diagnostics).toEqual([expect.objectContaining({
      source: "codex-cli",
      sessionKey: "codex:session-1",
      filePath: "/tmp/session-1.jsonl",
      error: expect.objectContaining({ name: "Error", message: "session write failed" }),
    })]);
    expect(store.searchSessions({ query: "Question 2", limit: 10 })).toHaveLength(1);
  });

  it("continues indexing when the diagnostic log cannot be written", async () => {
    const store = createInMemoryStore();
    const originalUpsert = store.upsertIndexedSession.bind(store);
    vi.spyOn(store, "upsertIndexedSession")
      .mockImplementationOnce(() => {
        throw new Error("session write failed");
      })
      .mockImplementation((...args) => originalUpsert(...args));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const status = await syncLoadedSessionsInBatches(store, [session(1), session(2)], {
        batchSize: 1,
        indexFailureLogPath: "/tmp/session-index-failures.jsonl",
        logIndexFailure: async () => {
          throw new Error("disk full");
        },
      });

      expect(status).toMatchObject({ indexed: 1, skipped: 1, total: 2 });
      expect(status.error).toContain("Diagnostic details could not be written to the local log.");
      expect(status.error).not.toContain("/tmp/session-index-failures.jsonl");
      expect(store.searchSessions({ query: "Question 2", limit: 10 })).toHaveLength(1);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("isolates an execution-environment resolution failure to its session", async () => {
    const store = createInMemoryStore();
    vi.spyOn(store, "upsertEnvironment").mockImplementationOnce(() => {
      throw new Error("environment write failed");
    });
    const remote = session(1);
    remote.executionEnvironmentHint = { kind: "ssh", label: "dev", hostAlias: "dev" };
    const diagnostics: unknown[] = [];

    const status = await syncLoadedSessionsInBatches(store, [remote, session(2)], {
      batchSize: 1,
      logIndexFailure: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });

    expect(status).toMatchObject({ indexed: 1, skipped: 1, total: 2 });
    expect(diagnostics).toEqual([expect.objectContaining({
      sessionKey: "codex:session-1",
      error: expect.objectContaining({ message: "environment write failed" }),
    })]);
    expect(store.searchSessions({ query: "Question 2", limit: 10 })).toHaveLength(1);
  });

  it("creates a disabled SSH environment for locally stored Cursor Remote sessions", async () => {
    const store = createInMemoryStore();
    const remote = session(1);
    remote.session = {
      ...remote.session,
      sessionKey: "cursor:workspace:remote-1",
      rawId: "remote-1",
      source: "cursor-agent",
      storageEnvironmentId: "local",
    };
    remote.executionEnvironmentHint = { kind: "ssh", label: "dev", hostAlias: "dev" };
    let environmentsChanged = 0;

    await syncLoadedSessionsInBatches(store, [remote], {
      batchSize: 1,
      onEnvironmentsChanged: () => {
        environmentsChanged++;
      },
    });

    expect(store.listEnvironments()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dev", kind: "ssh", label: "dev", hostAlias: "dev", enabled: false }),
    ]));
    expect(store.getSession("cursor:workspace:remote-1")).toMatchObject({
      sessionKey: "cursor:workspace:remote-1",
      environmentId: "dev",
      environmentKind: "ssh",
      environmentLabel: "dev",
      storageEnvironmentId: "local",
    });
    expect(environmentsChanged).toBe(1);
  });

  it("reuses an enabled SSH environment for Cursor Remote sessions without disabling it", async () => {
    const store = createInMemoryStore();
    const existing = store.upsertEnvironment({
      id: "ssh-dev",
      kind: "ssh",
      label: "Development",
      hostAlias: "dev",
      enabled: true,
    });
    const remote = session(1);
    remote.session = {
      ...remote.session,
      sessionKey: "cursor:workspace:remote-1",
      rawId: "remote-1",
      source: "cursor-agent",
      storageEnvironmentId: "local",
    };
    remote.executionEnvironmentHint = { kind: "ssh", label: "dev", hostAlias: "dev" };
    let environmentsChanged = 0;

    await syncLoadedSessionsInBatches(store, [remote], {
      batchSize: 1,
      onEnvironmentsChanged: () => {
        environmentsChanged++;
      },
    });

    expect(store.getSession("cursor:workspace:remote-1")).toMatchObject({
      environmentId: existing.id,
      environmentKind: "ssh",
      environmentLabel: "Development",
      storageEnvironmentId: "local",
    });
    expect(store.getEnvironment(existing.id)).toMatchObject({ enabled: true });
    expect(environmentsChanged).toBe(0);
  });

  it("indexes opted-in Pi sessions so their content is searchable", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-pi-index-"));
    const filePath = path.join(homeDir, ".pi", "agent", "sessions", "--repo--", "pi-indexed.jsonl");
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [
        { type: "session", version: 1, id: "pi-indexed", timestamp: "2026-07-31T03:00:00.000Z", cwd: "/repo" },
        {
          type: "message",
          timestamp: "2026-07-31T03:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text: "searchable Pi integration" }] },
        },
        {
          type: "message",
          timestamp: "2026-07-31T03:00:02.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Pi search result" }] },
        },
      ].map((row) => JSON.stringify(row)).join("\n"));

      await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: { homeDir, includePi: true },
      });

      const results = await Promise.resolve(
        store.searchSessions({ query: "searchable Pi integration", limit: 10 }),
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        sessionKey: "pi:pi-indexed",
        source: "pi-cli",
      });
    } finally {
      store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("yields before writing a large Codex session with inline image output", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-async-index-"));
    try {
      const filePath = writeCodexSession(homeDir, "codex-async-index", "responsive indexing", "Async Index");
      fs.appendFileSync(filePath, `\n${JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T10:00:03Z",
        payload: {
          type: "function_call_output",
          call_id: "image-output",
          output: [{ type: "input_image", image_url: `data:image/png;base64,${"x".repeat(2 * 1024 * 1024)}` }],
        },
      })}\n`);
      let heartbeat = false;
      setImmediate(() => {
        heartbeat = true;
      });
      const originalUpsert = store.upsertIndexedSession.bind(store);
      vi.spyOn(store, "upsertIndexedSession").mockImplementation((...args) => {
        expect(heartbeat).toBe(true);
        return originalUpsert(...args);
      });

      const status = await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: { homeDir },
      });

      expect(status).toMatchObject({ indexed: 1, skipped: 0, total: 1, error: null });
      expect(store.searchSessions({ query: "responsive indexing", limit: 10 })).toHaveLength(1);
    } finally {
      store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("skips unchanged default session files before reading them", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-default-skip-"));
    try {
      const filePath = writeCodexSession(homeDir, "codex-skip", "original question", "Original Title");
      const cold = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      expect(cold).toMatchObject({ indexed: 1, skipped: 0, total: 1 });

      const previousStat = store.listIndexedSessionFiles()[0];
      fs.writeFileSync(filePath, "{not jsonl".padEnd(previousStat.fileSize, "x"));
      fs.utimesSync(filePath, previousStat.fileMtimeMs / 1000, previousStat.fileMtimeMs / 1000);
      const oldIndexTime = new Date(Math.max(0, previousStat.indexedAt - 1000));
      fs.utimesSync(path.join(homeDir, ".codex", "session_index.jsonl"), oldIndexTime, oldIndexTime);
      const getAllMessages = vi.spyOn(store, "getAllMessages");

      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm).toMatchObject({ indexed: 0, skipped: 1, total: 1 });
      expect(getAllMessages).not.toHaveBeenCalled();
      expect(store.searchSessions({ query: "original question", limit: 10 })).toHaveLength(1);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rebuilds invalidated Codex sessions from the file head before resuming normal skips", async () => {
    const db = new DatabaseSync(":memory:");
    const store = new SessionStore(db);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-freshness-"));
    try {
      writeCodexSession(homeDir, "codex-freshness", "fresh question", "Freshness");
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      const sessionKey = "codex:codex-freshness";
      const existing = store.getSession(sessionKey)!;
      store.upsertIndexedSession(
        existing,
        store.getAllMessages(sessionKey),
        store.getTokenEvents(sessionKey),
        [{
          index: 0,
          kind: "event",
          source: "codex",
          title: "stale trace that is not in the source",
          detail: "",
          timestamp: "2026-06-01T10:01:00Z",
        }],
      );
      db.prepare("DELETE FROM data_migrations WHERE id = 'codex-session-semantics-v2'").run();
      migrateSessionStore(db);
      expect(db.prepare(`
        SELECT file_mtime_ms, content_indexed_mtime_ms, content_indexed_size
        FROM sessions
        WHERE session_key = 'codex:codex-freshness'
      `).get()).toEqual({
        file_mtime_ms: 0,
        content_indexed_mtime_ms: 0,
        content_indexed_size: 0,
      });

      const rebuilt = await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: { homeDir },
      });
      expect(rebuilt).toMatchObject({ indexed: 1, skipped: 0, total: 1 });
      expect(store.getTraceEvents(sessionKey)).toEqual([]);

      const warm = await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: { homeDir },
      });
      expect(warm).toMatchObject({ indexed: 0, skipped: 1, total: 1 });
    } finally {
      store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("indexes only the appended Codex tail after the first scan", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-tail-"));
    try {
      const filePath = writeCodexSession(homeDir, "codex-tail", "original question", "Tail");
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      const originalSize = fs.statSync(filePath).size;
      const original = fs.readFileSync(filePath, "utf8");
      fs.writeFileSync(filePath, `${"x".repeat(originalSize)}\n${JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T10:02:00Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "appended answer" }] },
      })}\n`);

      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm.indexed).toBe(1);
      expect(store.getAllMessages("codex:codex-tail").map((message) => message.content)).toEqual([
        "original question",
        "appended answer",
      ]);
      expect(original).toContain("original question");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("indexes custom tool traces appended to a Codex session", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-custom-tail-"));
    try {
      const filePath = writeCodexSession(homeDir, "codex-custom-tail", "original question", "Custom Tail");
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      fs.appendFileSync(
        filePath,
        [
          "",
          JSON.stringify({
            type: "session_meta",
            timestamp: "2026-06-01T10:01:30Z",
            payload: { id: "codex-custom-tail", cwd: "/repo", history_mode: "paginated" },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-06-01T10:02:00Z",
            payload: {
              type: "custom_tool_call",
              name: "exec",
              call_id: "custom-tail-1",
              input: "console.log('tail')",
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-06-01T10:03:00Z",
            payload: {
              type: "custom_tool_call_output",
              call_id: "custom-tail-1",
              output: "tail",
            },
          }),
          "",
        ].join("\n"),
      );

      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm.indexed).toBe(1);
      expect(store.getTraceEvents("codex:codex-custom-tail")).toEqual([
        expect.objectContaining({
          kind: "tool_result",
          title: "exec",
          callId: "custom-tail-1",
          eventType: "codex.custom_tool",
        }),
      ]);

      fs.appendFileSync(filePath, `${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-01T10:04:00Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-tail",
          completed_at_ms: Date.parse("2026-06-01T10:04:00Z"),
          item: {
            type: "DynamicToolCall",
            id: "custom-tail-1",
            namespace: "workspace",
            tool: "exec",
            arguments: "console.log('tail')",
            status: "completed",
            content_items: [{ text: "tail complete" }],
            success: true,
          },
        },
      })}\n`);
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(store.getTraceEvents("codex:codex-custom-tail")).toEqual([
        expect.objectContaining({
          kind: "tool_result",
          title: "workspace.exec",
          callId: "custom-tail-1",
          eventType: "codex.dynamic_tool",
          attributes: expect.objectContaining({
            codex: { sourceItemId: "item_completed:custom-tail-1", rawType: "dynamictoolcall" },
          }),
        }),
      ]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reconciles persisted Code Mode tool state when runtime evidence arrives later", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-tool-state-tail-"));
    try {
      const filePath = writeCodexSession(homeDir, "codex-tool-state-tail", "run pwd", "Tool State Tail");
      fs.appendFileSync(filePath, [
        "",
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-08-20T03:00:00Z",
          payload: { id: "codex-tool-state-tail", cwd: "/repo", history_mode: "paginated" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-20T03:00:01Z",
          payload: { type: "task_started", turn_id: "turn-tool" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-20T03:00:02Z",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "code-mode-incremental",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-tool" },
            input: "await tools.exec_command({ cmd: 'pwd' });",
          },
        }),
        "",
      ].join("\n"));
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      fs.appendFileSync(filePath, `${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-20T03:00:03Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-tool",
          item: {
            type: "CommandExecution",
            id: "exec-runtime-incremental",
            command: ["/bin/zsh", "-lc", "pwd"],
            cwd: "/repo",
            status: "completed",
            exit_code: 0,
            duration: { secs: 1, nanos: 250_000_000 },
          },
        },
      })}\n`);
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      const nestedCommands = store.getTraceEvents("codex:codex-tool-state-tail").filter((event) => {
        const tool = event.attributes?.tool as Record<string, unknown> | undefined;
        return tool?.canonicalName === "exec_command";
      });
      expect(nestedCommands).toEqual([
        expect.objectContaining({
          callId: "exec-runtime-incremental",
          status: "completed",
          attributes: expect.objectContaining({
            durationMs: 1_250,
            tool: expect.objectContaining({
              parentCallId: "code-mode-incremental",
              executionEvidence: "runtime-confirmed",
            }),
          }),
        }),
      ]);
    } finally {
      store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("restores an active Codex turn when lifecycle records arrive in separate scans", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-lifecycle-tail-"));
    try {
      const filePath = writeCodexSession(homeDir, "codex-lifecycle-tail", "original question", "Lifecycle Tail");
      fs.appendFileSync(filePath, [
        "",
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:30Z",
          payload: { id: "codex-lifecycle-tail", cwd: "/repo", history_mode: "paginated" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "task_started", turn_id: "turn-tail" },
        }),
        "",
      ].join("\n"));
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(store.getCodexIncrementalState("codex:codex-lifecycle-tail").activeTurnIds).toEqual(["turn-tail"]);

      fs.appendFileSync(filePath, [
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:02:00Z",
          payload: {
            type: "message",
            id: "answer-tail",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "tail complete" }],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:02:30Z",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:03:00Z",
          payload: { type: "task_complete", turn_id: "turn-tail", duration_ms: 2_000 },
        }),
        "",
      ].join("\n"));
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(store.getAllMessages("codex:codex-lifecycle-tail").at(-1)).toMatchObject({
        content: "tail complete",
        sourceTurnId: "turn-tail",
        phase: "final_answer",
      });
      expect(store.getTraceEvents("codex:codex-lifecycle-tail").at(-1)).toMatchObject({
        eventType: "codex.turn.completed",
        sourceTurnId: "turn-tail",
        attributes: { durationMs: 2_000 },
      });
      expect(store.getCodexIncrementalState("codex:codex-lifecycle-tail")).toMatchObject({
        activeTurnIds: [],
        messageProvenance: expect.arrayContaining([
          { messageIndex: 1, sourceRecordId: "response_item:answer-tail" },
        ]),
      });

      fs.appendFileSync(filePath, `${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-01T10:04:00Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-tail",
          completed_at_ms: Date.parse("2026-06-01T10:04:00Z"),
          item: {
            type: "AgentMessage",
            id: "answer-tail",
            phase: "final_answer",
            content: [{ type: "output_text", text: "authoritative tail complete" }],
          },
        },
      })}\n`);
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(store.getAllMessages("codex:codex-lifecycle-tail").at(-1)).toMatchObject({
        content: "authoritative tail complete",
        sourceTurnId: "turn-tail",
        phase: "final_answer",
      });
      expect(store.getCodexIncrementalState("codex:codex-lifecycle-tail").messageProvenance).toContainEqual({
        messageIndex: 1,
        sourceRecordId: "item_completed:answer-tail",
      });

      fs.appendFileSync(filePath, [
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:05:00Z",
          payload: { type: "task_started", turn_id: "turn-rolled" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:06:00Z",
          payload: {
            type: "message",
            id: "question-rolled",
            role: "user",
            content: [{ type: "input_text", text: "rolled-back tail question" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-rolled" },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:07:00Z",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 20, output_tokens: 2 } },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:07:30Z",
          payload: { type: "turn_aborted", turn_id: "turn-rolled", reason: "interrupted" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:08:00Z",
          payload: { type: "thread_rolled_back", num_turns: 1 },
        }),
        "",
      ].join("\n"));
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(store.getAllMessages("codex:codex-lifecycle-tail").some(
        (message) => message.sourceTurnId === "turn-rolled",
      )).toBe(false);
      expect(store.getTraceEvents("codex:codex-lifecycle-tail").some(
        (event) => event.sourceTurnId === "turn-rolled",
      )).toBe(false);
      expect(store.getTokenEvents("codex:codex-lifecycle-tail").map(
        (event) => event.sourceTurnId,
      )).toEqual(["turn-tail", "turn-rolled"]);
      expect(store.getSession("codex:codex-lifecycle-tail")?.tokenUsage?.totalTokens).toBe(33);
      expect(store.getCodexIncrementalState("codex:codex-lifecycle-tail").activeTurnIds).toEqual([]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("deduplicates Codex token events when an appended tail repeats prior usage", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-token-tail-"));
    const tokenCount = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-06-01T10:02:00Z",
      payload: {
        type: "token_count",
        info: {
          model: "gpt-5.6-sol",
          last_token_usage: {
            input_tokens: 120,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          },
        },
      },
    });
    try {
      const filePath = writeCodexSession(homeDir, "codex-token-tail", "original question", "Token Tail");
      fs.appendFileSync(filePath, `\n${tokenCount}`);
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      fs.appendFileSync(filePath, `\n${tokenCount}`);
      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm).toMatchObject({ indexed: 1, error: null });
      expect(store.getTokenEvents("codex:codex-token-tail")).toHaveLength(1);
    } finally {
      store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps a Cursor conversation as cache when its row disappears from the shared database", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-cursor-cache-"));
    const stateDbPath = path.join(homeDir, "Cursor", "User", "globalStorage", "state.vscdb");
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    const db = new DatabaseSync(stateDbPath);
    db.exec(`
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY,
        createdAt INTEGER,
        isSubagent INTEGER,
        value TEXT
      );
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
    `);
    db.prepare("INSERT INTO composerHeaders (composerId, createdAt, isSubagent, value) VALUES (?, ?, 0, ?)").run(
      "live",
      Date.parse("2026-07-27T10:00:00Z"),
      JSON.stringify({
        name: "Live Cursor session",
        workspaceIdentifier: { uri: { scheme: "file", fsPath: "/repo/live" } },
      }),
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "bubbleId:live:user-1",
      JSON.stringify({
        bubbleId: "user-1",
        type: 1,
        text: "Live prompt",
        createdAt: "2026-07-27T10:00:00Z",
      }),
    );
    db.close();
    const stat = fs.statSync(stateDbPath);
    const cached = session(99);
    cached.session = {
      ...cached.session,
      sessionKey: "cursor:repo-stale:stale",
      rawId: "stale",
      source: "cursor-agent",
      filePath: stateDbPath,
      fileMtimeMs: stat.mtimeMs,
      fileSize: stat.size,
    };
    cached.messages = [{
      role: "user",
      content: "Only cached prompt",
      timestamp: "2026-07-26T10:00:00Z",
      index: 0,
    }];
    store.upsertIndexedSession(cached.session, cached.messages);

    try {
      await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeCursorAgent: true,
          cursorStateDbPath: stateDbPath,
        },
      });

      expect(store.getSession("cursor:repo-stale:stale")).toMatchObject({
        sourceAvailable: false,
        messageCount: 1,
      });
      expect(store.findByRawId("live")).toMatchObject({
        sourceAvailable: true,
        messageCount: 1,
      });
      expect(store.searchSessions({ query: "Only cached prompt", limit: 10 })).toHaveLength(1);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rekeys a cached Cursor conversation when the same composer moves to a new workspace key", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-cursor-rekey-"));
    const stateDbPath = path.join(homeDir, "Cursor", "User", "globalStorage", "state.vscdb");
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    const db = new DatabaseSync(stateDbPath);
    db.exec(`
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY,
        createdAt INTEGER,
        isSubagent INTEGER,
        value TEXT
      );
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
    `);
    db.prepare("INSERT INTO composerHeaders (composerId, createdAt, isSubagent, value) VALUES (?, ?, 0, ?)").run(
      "same-composer",
      Date.parse("2026-07-29T10:00:00Z"),
      JSON.stringify({
        name: "Moved Cursor session",
        workspaceIdentifier: { uri: { scheme: "file", fsPath: "/repo/new" } },
      }),
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "bubbleId:same-composer:user-1",
      JSON.stringify({
        bubbleId: "user-1",
        type: 1,
        text: "Current Cursor prompt",
        createdAt: "2026-07-29T10:00:00Z",
      }),
    );
    db.close();
    const stat = fs.statSync(stateDbPath);
    const cached = session(99);
    cached.session = {
      ...cached.session,
      sessionKey: "cursor:repo-old:same-composer",
      rawId: "same-composer",
      source: "cursor-agent",
      filePath: stateDbPath,
      fileMtimeMs: stat.mtimeMs,
      fileSize: stat.size,
    };
    cached.messages = [{
      role: "user",
      content: "Cached Cursor prompt",
      timestamp: "2026-07-28T10:00:00Z",
      index: 0,
    }];
    store.upsertIndexedSession(cached.session, cached.messages);
    store.upsertIndexedSession({
      ...cached.session,
      sessionKey: "cursor:repo-new:same-composer",
      projectPath: "/repo/new",
      originalTitle: "Moved Cursor session",
      firstQuestion: "Current Cursor prompt",
      timestamp: Date.parse("2026-07-29T10:00:00Z"),
    }, [{
      role: "user",
      content: "Current Cursor prompt",
      timestamp: "2026-07-29T10:00:00Z",
      index: 0,
    }]);
    store.setCustomTitle(cached.session.sessionKey, "Remembered Cursor title");
    store.setFavorited(cached.session.sessionKey, true);
    store.addTag(cached.session.sessionKey, "cursor-work");
    store.upsertSessionSyncBinding({
      localSessionKey: cached.session.sessionKey,
      remoteSessionId: "cursor-remote",
      lastLocalRevision: "local-revision",
      lastRemoteRevision: "remote-revision",
      lastSyncedAt: 123,
      direction: "upload",
    });

    try {
      await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeCursorAgent: true,
          cursorStateDbPath: stateDbPath,
        },
      });

      expect(store.getSession("cursor:repo-old:same-composer")).toBeNull();
      expect(store.getSession("cursor:repo-new:same-composer")).toMatchObject({
        rawId: "same-composer",
        sourceAvailable: true,
        displayTitle: "Remembered Cursor title",
        favorited: true,
        tags: ["cursor-work"],
        messageCount: 1,
      });
      expect(store.searchSessions({ query: "Cached Cursor prompt", limit: 10 })).toHaveLength(0);
      expect(store.searchSessions({ query: "Current Cursor prompt", limit: 10 })).toHaveLength(1);
      expect(store.getSessionSyncBindingForLocalKey("cursor:repo-old:same-composer")).toBeNull();
      expect(store.getSessionSyncBindingForLocalKey("cursor:repo-new:same-composer")).toMatchObject({
        remoteSessionId: "cursor-remote",
        lastLocalRevision: "local-revision",
        lastRemoteRevision: "remote-revision",
      });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("continues removing Codex records after their individual source file disappears", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-missing-codex-"));
    const missing = session(100);
    missing.session = {
      ...missing.session,
      filePath: path.join(homeDir, ".codex", "sessions", "missing.jsonl"),
    };
    store.upsertIndexedSession(missing.session, missing.messages);

    try {
      await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: { homeDir },
      });

      expect(store.getSession(missing.session.sessionKey)).toBeNull();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("re-reads Codex sessions when the session index changes", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-index-"));
    try {
      writeCodexSession(homeDir, "codex-title-refresh", "title refresh question", "Old Title");
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      expect(store.searchSessions({ query: "Old Title", limit: 10 })).toHaveLength(1);

      const indexPath = path.join(homeDir, ".codex", "session_index.jsonl");
      fs.writeFileSync(
        indexPath,
        `${JSON.stringify({ id: "codex-title-refresh", thread_name: "New Title", updated_at: "2026-06-01T10:05:00Z" })}\n`,
      );
      const futureIndexTime = new Date(Date.now() + 2000);
      fs.utimesSync(indexPath, futureIndexTime, futureIndexTime);

      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm).toMatchObject({ indexed: 1, skipped: 0, total: 1 });
      expect(store.searchSessions({ query: "New Title", limit: 10 })).toHaveLength(1);
      expect(store.searchSessions({ query: "Old Title", limit: 10 })).toHaveLength(0);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rebuilds unchanged session content when a metadata dependency changes", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-content-refresh-"));
    try {
      const filePath = writeCodexSession(homeDir, "codex-content-refresh", "alphaoldx", "Stable Title");
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      expect(store.searchSessions({ query: "alphaoldx", limit: 10 })).toHaveLength(1);

      const previousStat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, "utf8").replace("alphaoldx", "betanewxx");
      fs.writeFileSync(filePath, content);
      fs.utimesSync(filePath, previousStat.atime, previousStat.mtime);

      const indexPath = path.join(homeDir, ".codex", "session_index.jsonl");
      const futureIndexTime = new Date(Date.now() + 2000);
      fs.utimesSync(indexPath, futureIndexTime, futureIndexTime);

      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm).toMatchObject({ indexed: 1, skipped: 0, total: 1 });
      expect(store.searchSessions({ query: "betanewxx", limit: 10 })).toHaveLength(1);
      expect(store.searchSessions({ query: "alphaoldx", limit: 10 })).toHaveLength(0);
    } finally {
      store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each([
    { target: "claude", source: "claude-cli" },
    { target: "tclaude", source: "tclaude-cli" },
    { target: "codex", source: "codex-cli" },
    { target: "tcodex", source: "tcodex-cli" },
    { target: "codebuddy", source: "codebuddy-cli" },
    { target: "codewiz", source: "codewiz-cli" },
    { target: "cursor", source: "cursor-agent" },
  ] as const satisfies readonly { target: MigrationTarget; source: SessionSource }[])(
    "indexes one migrated $target session file as its concrete source without a full scan",
    async ({ target, source }) => {
      const store = createInMemoryStore();
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-recall-index-migration-${target}-`));
      try {
        const written = await writeMigratedSession({
          target,
          homeDir,
          now: new Date("2026-06-24T10:00:00.000Z"),
          session: portableSession(),
        });

        const status = indexMigratedSessionFile(store, target, written.filePath, written.sessionId);

        expect(status).toMatchObject({ running: false, indexed: 1, total: 1, error: null });
        const indexed = store.searchSessions({ source, limit: 10 });
        expect(indexed).toHaveLength(1);
        const sessionKey = indexed[0].sessionKey;
        expect(indexed[0]).toMatchObject({ source, sessionKey });
        expect(store.searchSessions({ query: "migrated question", source, limit: 10 })).toMatchObject([
          { sessionKey },
        ]);
      } finally {
        store.close();
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );

  it("indexes the exact migrated CodeWiz session from a shared database", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-codewiz-exact-"));
    try {
      await writeMigratedSession({
        target: "codewiz",
        homeDir,
        now: new Date("2026-06-24T10:00:00.000Z"),
        session: { ...portableSession(), title: "Old CodeWiz session", messages: [{ role: "user", content: "old codewiz question", timestamp: "2026-06-24T09:00:00.000Z", index: 0 }] },
      });
      const written = await writeMigratedSession({
        target: "codewiz",
        homeDir,
        now: new Date("2026-06-24T10:01:00.000Z"),
        session: portableSession(),
      });

      const status = indexMigratedSessionFile(store, "codewiz", written.filePath, written.sessionId);

      expect(status).toMatchObject({ running: false, indexed: 1, total: 1, error: null });
      expect(store.searchSessions({ query: "migrated question", source: "codewiz-cli", limit: 10 })).toHaveLength(1);
      expect(store.searchSessions({ query: "old codewiz question", source: "codewiz-cli", limit: 10 })).toHaveLength(0);
    } finally {
      store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each(["claude", "codex", "codebuddy"] as const)(
    "reports a stable domain error when a migrated %s session file is missing",
    (target) => {
      const store = createInMemoryStore();
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-recall-index-missing-${target}-`));
      const filePath = path.join(homeDir, "missing.jsonl");
      try {
        expect(() => indexMigratedSessionFile(store, target, filePath)).toThrow(
          `Migrated ${target} session could not be loaded from ${filePath}.`,
        );
      } finally {
        store.close();
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );
});

function writeCodexSession(homeDir: string, id: string, question: string, title: string): string {
  const codexDir = path.join(homeDir, ".codex");
  const sessionDir = path.join(codexDir, "sessions", "2026", "06", "01");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    `${JSON.stringify({ id, thread_name: title, updated_at: "2026-06-01T10:00:00Z" })}\n`,
  );
  const filePath = path.join(sessionDir, `${id}.jsonl`);
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-01T10:00:00Z",
        payload: { id, cwd: "/repo", title: "Embedded Title" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T10:01:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: question }] },
      }),
    ].join("\n"),
  );
  return filePath;
}

function portableSession(): PortableSession {
  return {
    sourceSessionKey: "codex:source",
    sourceAgent: "codex",
    title: "Migrated session",
    projectPath: "/tmp/migrated-project",
    startedAt: "2026-06-24T09:00:00.000Z",
    messages: [
      { role: "user", content: "migrated question", timestamp: "2026-06-24T09:00:00.000Z", index: 0 },
      { role: "assistant", content: "migrated answer", timestamp: "2026-06-24T09:00:01.000Z", index: 1 },
    ],
  };
}
