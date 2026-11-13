import fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getAdapter } from "./format-adapters";
import { syncDefaultSessionsInBatches } from "./indexer";
import { loadDefaultSessions } from "./session-loader";
import { SessionStore } from "./session-store";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-antigravity-v1-"));
  roots.push(root);
  return root;
}

function antigravityPaths(root: string, conversationId: string): {
  transcript: string;
  transcriptFallback: string;
  metadataDb: string;
  annotation: string;
} {
  const home = path.join(root, ".gemini", "antigravity");
  const logs = path.join(home, "brain", conversationId, ".system_generated", "logs");
  return {
    transcript: path.join(logs, "transcript_full.jsonl"),
    transcriptFallback: path.join(logs, "transcript.jsonl"),
    metadataDb: path.join(home, "conversations", `${conversationId}.db`),
    annotation: path.join(home, "annotations", `${conversationId}.pbtxt`),
  };
}

function writeTranscript(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function protoVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function protoTag(field: number, wire: number): Buffer {
  return protoVarint(field * 8 + wire);
}

function protoLengthDelimited(field: number, payload: Buffer): Buffer {
  return Buffer.concat([protoTag(field, 2), protoVarint(payload.length), payload]);
}

function protoVarintField(field: number, value: number): Buffer {
  return Buffer.concat([protoTag(field, 0), protoVarint(value)]);
}

function protoString(field: number, value: string): Buffer {
  return protoLengthDelimited(field, Buffer.from(value, "utf8"));
}

// The steps table shares the file with the metadata blob; capture what the
// display transcript drops: failed tool results, per-call usage, and titles.
function appendStepsTable(
  dbPath: string,
  rows: Array<{ idx: number; stepType: number; status: number; payload: Buffer; errorDetails?: Buffer }>,
): void {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, error_details BLOB, step_payload BLOB)");
  const insert = db.prepare("INSERT INTO steps (idx, step_type, status, error_details, step_payload) VALUES (?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(row.idx, row.stepType, row.status, row.errorDetails ?? null, row.payload);
  db.close();
}

function plannerPayload(stepType: number, realCallIds: string[], usage?: { input: number; cached: number; output: number; reasoning: number }): Buffer {
  const callMessages = realCallIds.map((callId) => protoLengthDelimited(7, Buffer.concat([
    protoString(1, callId),
    protoString(2, "view_file"),
  ])));
  return Buffer.concat([
    protoVarintField(1, stepType),
    protoLengthDelimited(5, usage
      ? protoLengthDelimited(9, Buffer.concat([
        protoVarintField(2, usage.input),
        protoVarintField(5, usage.cached),
        protoVarintField(9, usage.reasoning),
        protoVarintField(10, usage.output),
      ]))
      : Buffer.alloc(0)),
    protoLengthDelimited(20, Buffer.concat(callMessages)),
  ]);
}

function failedToolPayload(realCallId: string, errorText: string, timestampSeconds: number): Buffer {
  return Buffer.concat([
    protoVarintField(1, 132),
    protoLengthDelimited(5, Buffer.concat([
      protoLengthDelimited(1, protoVarintField(1, timestampSeconds)),
      protoLengthDelimited(4, Buffer.concat([
        protoString(1, realCallId),
        protoString(2, "view_file"),
      ])),
    ])),
    protoLengthDelimited(31, protoString(2, errorText)),
  ]);
}

function setDatabaseTitle(dbPath: string, title: string): void {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE steps SET step_payload = ? WHERE step_type = 23").run(titlePayload(title));
  db.close();
}

function titlePayload(title: string): Buffer {
  return Buffer.concat([protoVarintField(1, 23), protoLengthDelimited(30, protoString(4, title))]);
}

function writeMetadataDb(
  dbPath: string,
  options: {
    folderUri?: string;
    branch?: string;
    createdAtSeconds?: number;
    /** Conversation that spawned this one (metadata field 5). */
    ownerConversationId?: string;
    agentName?: string;
  },
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE trajectory_metadata_blob (id TEXT DEFAULT 'main', data BLOB, PRIMARY KEY (id))");
  const workspaceParts: Buffer[] = [];
  if (options.folderUri) workspaceParts.push(protoString(1, options.folderUri));
  if (options.branch) workspaceParts.push(protoString(4, options.branch));
  const parts: Buffer[] = [];
  if (workspaceParts.length) parts.push(protoLengthDelimited(1, Buffer.concat(workspaceParts)));
  if (options.createdAtSeconds) {
    parts.push(protoLengthDelimited(2, Buffer.concat([protoTag(1, 0), protoVarint(options.createdAtSeconds)])));
  }
  if (options.ownerConversationId) parts.push(protoString(5, options.ownerConversationId));
  if (options.agentName) parts.push(protoLengthDelimited(4, protoString(1, options.agentName)));
  db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(Buffer.concat(parts));
  db.close();
}

const CONVERSATION_ID = "5cb078f8-1111-2222-3333-444455556666";

describe("Antigravity sessions", () => {
  it("orders entries by step_index and projects messages, tools, checkpoints, and metadata", () => {
    const root = fixture();
    const paths = antigravityPaths(root, CONVERSATION_ID);
    const projectDir = path.join(root, "workspace");
    // The tool result is written before the planner response that requested it.
    writeTranscript(paths.transcript, [
      { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-09-15T02:24:05Z", content: "Created At: 2026-09-15T10:24:05+08:00\nCompleted At: 2026-09-15T10:24:11+08:00\nfile contents" },
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-09-15T02:23:59Z", content: "<USER_REQUEST>\nFix the parser\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-15T10:23:59+08:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user enabled something.\n</USER_SETTINGS_CHANGE>" },
      { step_index: 1, source: "SYSTEM", type: "CHECKPOINT", status: "DONE", created_at: "2026-09-15T02:23:59Z", content: "{{ CHECKPOINT 0 }}\nEarlier parts were truncated." },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-15T02:24:00Z", thinking: "Inspect the parser first", content: "Let me inspect the parser.", tool_calls: [{ name: "view_file", args: { AbsolutePath: "/work/app/parser.ts", toolSummary: "Inspect parser" } }] },
      { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-15T02:24:20Z", content: "Done." },
      { step_index: 5, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-09-15T02:24:30Z", content: "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] sender=other-task content=Report ready\n</SYSTEM_MESSAGE>" },
      { step_index: 6, source: "SYSTEM", type: "ERROR_MESSAGE", status: "DONE", created_at: "2026-09-15T02:24:40Z", content: "Error: The stream was interrupted." },
      { step_index: 7, source: "SYSTEM", type: "CONVERSATION_HISTORY", status: "DONE", created_at: "2026-09-15T02:24:41Z" },
    ]);
    writeMetadataDb(paths.metadataDb, {
      folderUri: pathToFileURL(projectDir).href,
      branch: "main",
      createdAtSeconds: 1789442000,
    });
    fs.mkdirSync(path.dirname(paths.annotation), { recursive: true });
    fs.writeFileSync(paths.annotation, 'title:"Parser repair" last_user_view_time:{seconds:1789442944 nanos:944000000}\n', "utf8");

    const loaded = loadDefaultSessions({ homeDir: root, includeAntigravity: true })
      .filter((item) => item.session.source === "antigravity");

    expect(loaded).toHaveLength(1);
    const { session, messages } = loaded[0];
    const traceEvents = loaded[0].traceEvents ?? [];
    expect(session).toMatchObject({
      sessionKey: `antigravity:${CONVERSATION_ID}`,
      rawId: CONVERSATION_ID,
      projectPath: projectDir,
      gitBranch: "main",
      originalTitle: "Parser repair",
      firstQuestion: "Fix the parser",
      isSubagent: false,
      parentSessionId: null,
      timestamp: 1789442000 * 1000,
    });
    // Tool results are tool events, not conversation messages, and the XML
    // wrapper plus system blocks do not leak into the user message.
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Fix the parser"],
      ["assistant", "Let me inspect the parser."],
      ["assistant", "Done."],
    ]);
    const callId = "antigravity:2:0";
    expect(traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool_call", callId, title: "view_file · Inspect parser", eventType: "antigravity.toolCall", status: "running" }),
      expect.objectContaining({ kind: "tool_result", callId, detail: "file contents", eventType: "antigravity.toolResult", status: "completed" }),
      expect.objectContaining({ kind: "event", eventType: "antigravity.thought", detail: "Inspect the parser first" }),
      expect.objectContaining({ kind: "event", eventType: "antigravity.context.compaction" }),
      expect.objectContaining({ kind: "event", eventType: "antigravity.collaboration.message", detail: "[Message] sender=other-task content=Report ready" }),
      expect.objectContaining({ kind: "event", eventType: "antigravity.error", status: "failed" }),
    ]));
    const toolResult = traceEvents.find((event) => event.kind === "tool_result" && event.callId === callId);
    const toolCall = traceEvents.find((event) => event.kind === "tool_call" && event.callId === callId);
    expect(Date.parse(toolResult?.timestamp ?? "")).toBeGreaterThan(Date.parse(toolCall?.timestamp ?? ""));
    // The unknown CONVERSATION_HISTORY entry produces no event or message; the
    // remaining six entries produce exactly one event each.
    expect(traceEvents).toHaveLength(6);
  });

  it("pairs results in order and leaves a failed call unresolved without a database", () => {
    const root = fixture();
    const paths = antigravityPaths(root, CONVERSATION_ID);
    writeTranscript(paths.transcript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-09-15T03:00:00Z", content: "<USER_REQUEST>\nRun the checks\n</USER_REQUEST>" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-15T03:00:01Z", tool_calls: [
        { name: "view_file", args: { AbsolutePath: "/work/app/a.ts" } },
        { name: "run_command", args: { CommandLine: "npm test" } },
      ] },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-09-15T03:00:02Z", content: "Created At: 2026-09-15T11:00:02+08:00\nCompleted At: 2026-09-15T11:00:03+08:00\nfirst result" },
      { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-15T03:00:04Z", content: "Partial result accepted." },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeAntigravity: true })
      .filter((item) => item.session.source === "antigravity");

    const calls = (loaded.traceEvents ?? []).filter((event) => event.kind === "tool_call");
    const results = (loaded.traceEvents ?? []).filter((event) => event.kind === "tool_result");
    expect(calls.map((event) => event.callId)).toEqual(["antigravity:1:0", "antigravity:1:1"]);
    expect(results.map((event) => event.callId)).toEqual(["antigravity:1:0"]);
    expect(results[0].detail).toBe("first result");
    expect(loaded.messages.map((message) => message.content)).toEqual(["Run the checks", "Partial result accepted."]);
  });

  it("recovers failed and aborted tool results, token usage, and the title from the conversation database", () => {
    const root = fixture();
    const paths = antigravityPaths(root, CONVERSATION_ID);
    const projectDir = path.join(root, "workspace");
    writeTranscript(paths.transcript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-09-15T08:00:00Z", content: "<USER_REQUEST>\nAudit the repo\n</USER_REQUEST>" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-15T08:00:01Z", content: "Inspecting now.", tool_calls: [
        { name: "view_file", args: { AbsolutePath: "/work/app/a.ts" } },
        { name: "run_command", args: { CommandLine: "npm test" } },
      ] },
      { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-15T08:00:10Z", tool_calls: [
        { name: "grep_search", args: { Query: "audit" } },
      ] },
      // The failed step 2 is missing from the transcript, so the completed
      // result at step 4 must pair by its recorded call id, not by order.
      { step_index: 4, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-09-15T08:00:12Z", content: "Created At: 2026-09-15T16:00:12+08:00\nCompleted At: 2026-09-15T16:00:13+08:00\nsecond tool output" },
      { step_index: 6, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-15T08:00:20Z", content: "Two tools failed." },
      { step_index: 7, source: "SYSTEM", type: "CHECKPOINT", status: "DONE", created_at: "2026-09-15T08:00:21Z", content: "{{ CHECKPOINT 0 }}\nEarlier parts." },
    ]);
    writeMetadataDb(paths.metadataDb, {
      folderUri: pathToFileURL(projectDir).href,
      branch: "main",
      createdAtSeconds: 1789444800,
    });
    appendStepsTable(paths.metadataDb, [
      { idx: 1, stepType: 15, status: 3, payload: plannerPayload(15, ["toolu_real_one", "toolu_real_two"], { input: 1200, cached: 8000, output: 300, reasoning: 120 }) },
      { idx: 2, stepType: 132, status: 7, payload: failedToolPayload("toolu_real_one", "declaring permissions failed: user denied command(npm test)", 1789444820) },
      { idx: 3, stepType: 15, status: 3, payload: plannerPayload(15, ["toolu_real_three"]) },
      { idx: 4, stepType: 132, status: 3, payload: failedToolPayload("toolu_real_three", "", 1789444812) },
      { idx: 5, stepType: 132, status: 6, payload: failedToolPayload("toolu_real_two", "aborted by the user", 1789444830) },
      { idx: 7, stepType: 23, status: 3, payload: titlePayload("Repository audit") },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeAntigravity: true })
      .filter((item) => item.session.source === "antigravity");

    const calls = (loaded.traceEvents ?? []).filter((event) => event.kind === "tool_call");
    const results = (loaded.traceEvents ?? []).filter((event) => event.kind === "tool_result");
    expect(calls.map((event) => event.callId)).toEqual(["antigravity:1:0", "antigravity:1:1", "antigravity:3:0"]);
    // Order-only pairing would have attached the completed result to run_command.
    expect(results.find((event) => event.status === "completed")).toMatchObject({
      callId: "antigravity:3:0",
      detail: "second tool output",
    });
    expect(results.find((event) => event.status === "failed")).toMatchObject({
      callId: "antigravity:1:0",
      detail: "declaring permissions failed: user denied command(npm test)",
      // The failure timestamp comes from the step metadata, not from the planner call.
      timestamp: new Date(1789444820 * 1000).toISOString(),
    });
    expect(results.find((event) => event.status === "aborted")).toMatchObject({
      callId: "antigravity:1:1",
      detail: "aborted by the user",
    });
    // Every recorded call now has a result.
    for (const call of calls) expect(results.some((result) => result.callId === call.callId)).toBe(true);
    expect(loaded.session).toMatchObject({
      originalTitle: "Repository audit",
      projectPath: projectDir,
      gitBranch: "main",
    });
    expect(loaded.session.tokenUsage).toMatchObject({
      inputTokens: 1200,
      cachedInputTokens: 8000,
      outputTokens: 300,
      reasoningOutputTokens: 120,
      totalTokens: 9620,
    });
    expect(loaded.tokenEvents).toEqual([
      expect.objectContaining({ dedupeKey: "antigravity:1", timestamp: Date.parse("2026-09-15T08:00:01Z") }),
    ]);
  });

  it("falls back to the plain transcript, the file path, and the first question", () => {
    const root = fixture();
    const paths = antigravityPaths(root, CONVERSATION_ID);
    writeTranscript(paths.transcriptFallback, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-09-15T04:00:00Z", content: "<USER_REQUEST>\nSummarize the report\n</USER_REQUEST>" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-15T04:00:05Z", content: "Here is the summary." },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeAntigravity: true })
      .filter((item) => item.session.source === "antigravity");

    expect(loaded.session).toMatchObject({
      projectPath: paths.transcriptFallback,
      gitBranch: null,
      originalTitle: "Summarize the report",
      firstQuestion: "Summarize the report",
      timestamp: Date.parse("2026-09-15T04:00:00Z"),
    });
    expect(loaded.messages.map((message) => message.content)).toEqual(["Summarize the report", "Here is the summary."]);
  });

  it("keeps sessions when the metadata database is unreadable", () => {
    const root = fixture();
    const paths = antigravityPaths(root, CONVERSATION_ID);
    writeTranscript(paths.transcript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-09-15T05:00:00Z", content: "<USER_REQUEST>\nRecover the session\n</USER_REQUEST>" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-15T05:00:01Z", content: "Recovered." },
    ]);
    fs.mkdirSync(path.dirname(paths.metadataDb), { recursive: true });
    fs.writeFileSync(paths.metadataDb, "not a sqlite database", "utf8");

    const [loaded] = loadDefaultSessions({ homeDir: root, includeAntigravity: true })
      .filter((item) => item.session.source === "antigravity");

    expect(loaded.session).toMatchObject({
      projectPath: paths.transcript,
      originalTitle: "Recover the session",
    });
  });

  it("links subagent conversations to the conversation that spawned them", () => {
    const root = fixture();
    const parentId = "71b45468-1111-2222-3333-444455556666";
    const childId = "2256caaf-1111-2222-3333-444455556666";
    const parentPaths = antigravityPaths(root, parentId);
    const childPaths = antigravityPaths(root, childId);
    const workspace = path.join(root, "workspace");
    writeTranscript(parentPaths.transcript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-09-15T09:00:00Z", content: "<USER_REQUEST>\nDelegate the audit\n</USER_REQUEST>" },
    ]);
    writeTranscript(childPaths.transcript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-09-15T09:00:05Z", content: "<USER_REQUEST>\nAudit the middleware\n</USER_REQUEST>" },
    ]);
    // The parent stores its own id here (an older build wrote it that way) and
    // must stay a root conversation.
    writeMetadataDb(parentPaths.metadataDb, { folderUri: pathToFileURL(workspace).href, ownerConversationId: parentId });
    writeMetadataDb(childPaths.metadataDb, { folderUri: pathToFileURL(workspace).href, ownerConversationId: parentId, agentName: "doc-writer" });

    const loaded = loadDefaultSessions({ homeDir: root, includeAntigravity: true })
      .filter((item) => item.session.source === "antigravity");
    const byId = new Map(loaded.map((item) => [item.session.rawId, item.session]));
    expect(byId.get(parentId)).toMatchObject({ isSubagent: false, parentSessionId: null });
    expect(byId.get(childId)).toMatchObject({ isSubagent: true, parentSessionId: parentId });
  });

  it("indexes Antigravity CLI conversations from their own root with transcript usage and failures", () => {
    const root = fixture();
    const conversationId = "f554246f-1111-2222-3333-444455556666";
    const transcript = path.join(
      root, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl",
    );
    writeTranscript(transcript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-10-15T08:49:30Z", content: "<USER_REQUEST>\nlist 目录\n</USER_REQUEST>" },
      {
        step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-10-15T08:49:31Z",
        input_tokens: 11751, output_tokens: 225, cache_read_tokens: 0,
        tool_calls: [{ name: "run_command", args: { CommandLine: "Get-ChildItem" } }],
      },
      {
        step_index: 2, source: "MODEL", type: "GENERIC", status: "ERROR", created_at: "2026-10-15T08:50:03Z",
        error: "permission check failed: user denied permission to run command",
        content: "Created At: 2026-10-15T16:50:03+08:00\nEncountered error in step execution.",
      },
    ]);

    // The CLI keeps failed steps in its transcript, so this needs no database.
    expect(loadDefaultSessions({ homeDir: root, includeAntigravity: true })).toHaveLength(0);
    const [loaded] = loadDefaultSessions({ homeDir: root, includeAntigravityCli: true });
    expect(loaded.session).toMatchObject({
      sessionKey: `antigravity-cli:${conversationId}`,
      source: "antigravity-cli",
      isSubagent: false,
      parentSessionId: null,
      firstQuestion: "list 目录",
    });
    expect(loaded.messages.map((message) => message.content)).toEqual(["list 目录"]);
    expect((loaded.traceEvents ?? []).filter((event) => event.kind === "tool_result")).toEqual([
      expect.objectContaining({
        callId: "antigravity:1:0",
        status: "failed",
        detail: "permission check failed: user denied permission to run command",
      }),
    ]);
    expect(loaded.tokenEvents).toEqual([
      expect.objectContaining({ dedupeKey: "antigravity:1", inputTokens: 11751, outputTokens: 225 }),
    ]);
    expect(loaded.session.tokenUsage).toMatchObject({ inputTokens: 11751, outputTokens: 225, totalTokens: 11976 });
  });

  it("stays out of the default index until the optional source is enabled", () => {
    const root = fixture();
    const paths = antigravityPaths(root, CONVERSATION_ID);
    writeTranscript(paths.transcript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-09-15T06:00:00Z", content: "<USER_REQUEST>\nHidden until enabled\n</USER_REQUEST>" },
    ]);

    expect(loadDefaultSessions({ homeDir: root })).toHaveLength(0);
    expect(loadDefaultSessions({ homeDir: root, includeAntigravity: true })).toHaveLength(1);
  });
  it("maps shared-format rows the way the loaders do", () => {
    expect(getAdapter("antigravity").parseLine({
      type: "USER_INPUT",
      content: "<USER_REQUEST>\nHi\n</USER_REQUEST>",
      created_at: "2026-09-15T10:00:00Z",
    })).toEqual({ role: "user", content: "Hi", timestamp: "2026-09-15T10:00:00Z" });
    expect(getAdapter("antigravity-cli").parseLine({ type: "PLANNER_RESPONSE", content: "Sure" })).toMatchObject({
      role: "assistant",
      content: "Sure",
    });
    // Tool results are trace events, so a generic message path must not read them
    // as model text.
    expect(getAdapter("antigravity").parseLine({
      type: "GENERIC",
      content: "Created At: 2026-09-15T18:00:00+08:00\nresult",
    })).toBeNull();
  });

  it("reindexes when only the conversation database changes", async () => {
    const root = fixture();
    const paths = antigravityPaths(root, CONVERSATION_ID);
    writeTranscript(paths.transcript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-09-15T11:00:00Z", content: "<USER_REQUEST>\nIndex me\n</USER_REQUEST>" },
    ]);
    writeMetadataDb(paths.metadataDb, { folderUri: pathToFileURL(path.join(root, "workspace")).href });
    appendStepsTable(paths.metadataDb, [
      { idx: 1, stepType: 23, status: 3, payload: titlePayload("First title") },
    ]);
    const store = new SessionStore(new DatabaseSync(":memory:"));
    const loadOptions = { homeDir: root, includeAntigravity: true };

    const cold = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions });
    expect(cold).toMatchObject({ indexed: 1, skipped: 0 });
    expect(store.getSession(`antigravity:${CONVERSATION_ID}`)?.originalTitle).toBe("First title");

    // The transcript is untouched, so the warm pass skips the session.
    const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions });
    expect(warm).toMatchObject({ indexed: 0, skipped: 1 });

    // Change only the database title and move its mtime past the index time, so
    // the metadata dependency is what decides this pass.
    setDatabaseTitle(paths.metadataDb, "Second title");
    const bumped = new Date(Date.now() + 5000);
    fs.utimesSync(paths.metadataDb, bumped, bumped);

    const refreshed = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions });
    expect(refreshed).toMatchObject({ indexed: 1, skipped: 0 });
    expect(store.getSession(`antigravity:${CONVERSATION_ID}`)?.originalTitle).toBe("Second title");
  });

  it("reindexes when a WAL-mode database writes only its sidecar", async () => {
    const root = fixture();
    const paths = antigravityPaths(root, CONVERSATION_ID);
    writeTranscript(paths.transcript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-09-15T11:00:00Z", content: "<USER_REQUEST>\nIndex me\n</USER_REQUEST>" },
    ]);
    writeMetadataDb(paths.metadataDb, { folderUri: pathToFileURL(path.join(root, "workspace")).href });
    appendStepsTable(paths.metadataDb, [
      { idx: 1, stepType: 23, status: 3, payload: titlePayload("First title") },
    ]);
    // Switch to WAL before the first index. Converting the journal mode rewrites
    // the database header, which would otherwise move the database mtime past the
    // index time and make the pass look like a metadata change.
    const setup = new DatabaseSync(paths.metadataDb);
    setup.exec("PRAGMA journal_mode=WAL");
    setup.prepare("UPDATE steps SET step_payload = ? WHERE step_type = 23").run(titlePayload("First title"));
    setup.close();
    const store = new SessionStore(new DatabaseSync(":memory:"));
    const loadOptions = { homeDir: root, includeAntigravity: true };

    const cold = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions });
    expect(cold).toMatchObject({ indexed: 1, skipped: 0 });
    expect(store.getSession(`antigravity:${CONVERSATION_ID}`)?.originalTitle).toBe("First title");

    // Antigravity keeps a writing connection open, so the commit lands in the WAL
    // sidecar. Closing the connection here would checkpoint it back into the
    // database and move the database mtime, which is not the state the freshness
    // check has to survive.
    const writer = new DatabaseSync(paths.metadataDb);
    try {
      const databaseMtimeMs = fs.statSync(paths.metadataDb).mtimeMs;
      writer.prepare("UPDATE steps SET step_payload = ? WHERE step_type = 23").run(titlePayload("Second title"));
      expect(fs.statSync(paths.metadataDb).mtimeMs).toBe(databaseMtimeMs);

      const refreshed = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions });
      expect(refreshed).toMatchObject({ indexed: 1, skipped: 0 });
      expect(store.getSession(`antigravity:${CONVERSATION_ID}`)?.originalTitle).toBe("Second title");
    } finally {
      writer.close();
    }
  });

  it("extracts Antigravity step media attachments and materializes local files in the store", async () => {
    const root = fixture();
    const paths = antigravityPaths(root, CONVERSATION_ID);
    const uploadedPath = path.join(root, ".gemini", "antigravity", "brain", CONVERSATION_ID, ".user_uploaded", "screen shot.jpg");
    fs.mkdirSync(path.dirname(uploadedPath), { recursive: true });
    const uploadedBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    fs.writeFileSync(uploadedPath, uploadedBytes);

    writeTranscript(paths.transcript, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-01T08:00:00Z",
        content: "<USER_REQUEST>\n\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>",
        media: [{ mime_type: "image/jpeg", uri: pathToFileURL(uploadedPath).href }],
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-01T08:00:02Z",
        content: "Here is the annotated preview.",
        media: [{ mimeType: "image/png", data: Buffer.from("png-preview").toString("base64"), fileName: "preview.png" }],
      },
      {
        step_index: 2,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-01T08:00:05Z",
        content: "<USER_REQUEST>\nExplain what changed\n</USER_REQUEST>",
      },
    ]);

    const parsedUser = getAdapter("antigravity").parseLine({
      type: "USER_INPUT",
      created_at: "2026-11-01T08:00:00Z",
      content: "<USER_REQUEST>\n</USER_REQUEST>",
      media: [{ mime_type: "image/jpeg", uri: pathToFileURL(uploadedPath).href }],
    });
    expect(parsedUser).toMatchObject({
      role: "user",
      content: "[Attachment]",
      attachments: [expect.objectContaining({ fileName: "screen shot.jpg", mimeType: "image/jpeg", previewKind: "image" })],
    });

    const store = new SessionStore(path.join(root, "sessions.sqlite"));
    try {
      const result = await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: { homeDir: root, includeAntigravity: true },
      });
      expect(result).toMatchObject({ indexed: 1, skipped: 0 });
      const session = store.getSession(`antigravity:${CONVERSATION_ID}`);
      expect(session).toMatchObject({
        firstQuestion: "Explain what changed",
        originalTitle: "Explain what changed",
      });
      const storedMessages = store.getMessages(`antigravity:${CONVERSATION_ID}`);
      expect(storedMessages).toHaveLength(3);
      expect(storedMessages[0]).toMatchObject({
        role: "user",
        content: "[Attachment]",
        attachments: [
          expect.objectContaining({
            id: "0-0-attachment-1",
            fileName: "screen shot.jpg",
            mimeType: "image/jpeg",
            previewKind: "image",
            status: "available",
          }),
        ],
      });
      expect(storedMessages[0].attachments?.[0]).not.toHaveProperty("source");
      const cachedUpload = store.getAttachmentFile(`antigravity:${CONVERSATION_ID}`, "0-0-attachment-1");
      expect(fs.readFileSync(cachedUpload!.cachePath)).toEqual(uploadedBytes);

      const cachedReplyImage = store.getAttachmentFile(`antigravity:${CONVERSATION_ID}`, "1-0-attachment-1");
      expect(fs.readFileSync(cachedReplyImage!.cachePath, "utf8")).toBe("png-preview");
    } finally {
      store.close();
    }
  });

  it("extracts summaries for newer Antigravity tool call argument shapes", () => {
    const root = fixture();
    const paths = antigravityPaths(root, CONVERSATION_ID);
    writeTranscript(paths.transcript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-01T09:00:00Z", content: "<USER_REQUEST>\nInspect workspace\n</USER_REQUEST>" },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-01T09:00:01Z",
        tool_calls: [
          { name: "read_file", args: { Path: "/repo/src/index.ts", StartLine: 1, EndLine: 50 } },
          { name: "edit_file", args: { Path: "/repo/src/index.ts", Target: "a", Replacement: "b" } },
          { name: "read_url_content", args: { Url: "https://example.com/docs" } },
          { name: "search_marketplace", args: { queries: ["figma", "design"] } },
          { name: "invoke_subagent", args: { TypeName: "research", Role: "Codebase Researcher", Prompt: "First line\nSecond line" } },
          { name: "send_message", args: { Recipient: "worker-1", Message: "Check status" } },
          { name: "manage_task", args: { Action: "status", TaskId: "task-7" } },
          { name: "ask_question", args: { questions: [{ question: "Which target?", options: ["V1", "V2"] }] } },
        ],
      },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeAntigravity: true })
      .filter((item) => item.session.source === "antigravity");
    const toolTitles = (loaded.traceEvents ?? [])
      .filter((event) => event.kind === "tool_call")
      .map((event) => event.title);

    expect(toolTitles).toEqual([
      "read_file · /repo/src/index.ts",
      "edit_file · /repo/src/index.ts",
      "read_url_content · https://example.com/docs",
      "search_marketplace · figma, design",
      "invoke_subagent · Codebase Researcher",
      "send_message · worker-1",
      "manage_task · status task-7",
      "ask_question · Which target?",
    ]);
  });
});
