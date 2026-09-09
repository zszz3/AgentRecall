import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDefaultSessions } from "./session-loader";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

const roots: string[] = [];
const defaultHomeDir = os.homedir();
const originalGeminiDir = process.env.GEMINI_DIR;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
beforeEach(() => {
  delete process.env.GEMINI_DIR;
});
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalGeminiDir === undefined) delete process.env.GEMINI_DIR;
  else process.env.GEMINI_DIR = originalGeminiDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  vi.restoreAllMocks();
  vi.mocked(os.homedir).mockReset().mockReturnValue(defaultHomeDir);
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-gemini-v1-"));
  roots.push(root);
  return root;
}

function projectChats(root: string, slug: string, projectPath: string): string {
  const projectDir = path.join(root, ".gemini", "tmp", slug);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".project_root"), projectPath, "utf8");
  const chats = path.join(projectDir, "chats");
  fs.mkdirSync(chats, { recursive: true });
  return chats;
}

function writeChat(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
}

function header(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId, projectHash: "abc123", startTime: "2026-07-29T04:54:37.634Z", lastUpdated: "2026-07-29T05:00:00.000Z", ...extra };
}

describe("Gemini CLI sessions", () => {
  it("loads main sessions with messages, tokens, tool calls, and the project root", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    writeChat(path.join(chats, "session-2026-07-29T04-54-72d14847.jsonl"), [
      header("72d14847-09f0-4562-aa8e-f7b42bf11749"),
      { id: "m-user", timestamp: "2026-07-29T04:55:00.000Z", type: "user", content: [{ text: "expanded @file model input" }], displayContent: "Fix the login flow" },
      {
        id: "m-gemini",
        timestamp: "2026-07-29T04:56:00.000Z",
        type: "gemini",
        content: [{ text: "I will inspect auth.ts" }],
        thoughts: [{ subject: "Auth plan", description: "Consider the auth module", timestamp: "2026-07-29T04:55:59.000Z" }],
        tokens: { input: 100, output: 20, cached: 5, thoughts: 3, tool: 0, total: 125 },
        model: "gemini-2.5-pro",
        toolCalls: [{ id: "call-1", name: "read_file", displayName: "Read File", timestamp: "2026-07-29T04:56:01.000Z", args: { path: "auth.ts" }, result: [{ text: "file contents" }], status: "ok" }, { id: "call-2", name: "bash", displayName: "Shell", timestamp: "2026-07-29T04:56:02.000Z", args: { cmd: "ls" }, status: "cancelled" }],
      },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });

    expect(loaded.session).toMatchObject({
      sessionKey: "gemini:72d14847-09f0-4562-aa8e-f7b42bf11749",
      source: "gemini-cli",
      projectPath: "/work/gemini-app",
      isSubagent: false,
      parentSessionId: null,
    });
    expect(loaded.messages.map((message) => message.content)).toEqual(["Fix the login flow", "I will inspect auth.ts"]);
    // Gemini 的 input 已含 cached:input 100 → 非缓存 95 + cached 5;total = 95+5+20(+tool)+3 = 123
    expect(loaded.session.tokenUsage?.totalTokens).toBe(123);
    expect(loaded.traceEvents?.some((event) => event.kind === "tool_result" && event.callId === "call-1" && event.status === "completed")).toBe(true);
    expect(loaded.traceEvents?.some((event) => event.kind === "tool_result" && event.callId === "call-2" && event.status === "aborted")).toBe(true);
    expect(loaded.session.timestamp).toBe(Date.parse("2026-07-29T04:54:37.634Z"));
    expect(loaded.traceEvents?.some((event) => event.eventType === "gemini.thought" && event.timestamp === "2026-07-29T04:55:59.000Z")).toBe(true);
  });

  it("rebuilds messages from checkpoints and applies rewinds", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    writeChat(path.join(chats, "session-2026-07-29T05-10-66fcaf99.jsonl"), [
      header("66fcaf99-1111-2222-3333-444444555555"),
      { id: "old-user", timestamp: "2026-07-29T05:10:00.000Z", type: "user", content: "stale request" },
      { id: "old-gemini", timestamp: "2026-07-29T05:11:00.000Z", type: "gemini", content: "stale answer", tokens: { input: 9, output: 9, cached: 0, thoughts: 0, tool: 0, total: 18 } },
      { $set: { messages: [
        { id: "new-user", timestamp: "2026-07-29T05:12:00.000Z", type: "user", content: "fresh request" },
        { id: "mid-gemini", timestamp: "2026-07-29T05:13:00.000Z", type: "gemini", content: "keep me", tokens: { input: 10, output: 4, cached: 0, thoughts: 0, tool: 0, total: 14 } },
        { id: "tail-gemini", timestamp: "2026-07-29T05:14:00.000Z", type: "gemini", content: "rewind past me", tokens: { input: 7, output: 7, cached: 0, thoughts: 0, tool: 0, total: 14 } },
      ] } },
      { $rewindTo: "tail-gemini" },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });

    expect(loaded.messages.map((message) => message.content)).toEqual(["fresh request", "keep me"]);
    expect(loaded.session.tokenUsage?.totalTokens).toBe(14);
  });

  it("indexes nested subagent sessions with parent linkage", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    const parentId = "72d14847-09f0-4562-aa8e-f7b42bf11749";
    writeChat(path.join(chats, `session-2026-07-29T04-54-72d14847.jsonl`), [
      header(parentId),
      { id: "p-user", timestamp: "2026-07-29T04:55:00.000Z", type: "user", content: "Delegate the audit" },
    ]);
    writeChat(path.join(chats, parentId, "aaaabbbb-cccc-dddd-eeee-ffff00001111.jsonl"), [
      { sessionId: "aaaabbbb-cccc-dddd-eeee-ffff00001111", projectHash: "abc123", startTime: "2026-07-29T04:56:00.000Z", lastUpdated: "2026-07-29T04:57:00.000Z", kind: "subagent" },
      { id: "s-user", timestamp: "2026-07-29T04:56:30.000Z", type: "user", content: "Audit the middleware" },
    ]);

    const loaded = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });
    const byKey = new Map(loaded.map((item) => [item.session.rawId, item.session]));

    expect(byKey.get(parentId)).toMatchObject({ isSubagent: false, parentSessionId: null });
    expect(byKey.get("aaaabbbb-cccc-dddd-eeee-ffff00001111")).toMatchObject({
      isSubagent: true,
      parentSessionId: parentId,
    });
  });

  it.each(["json", "jsonl"])("indexes legacy .json subagents under a %s parent", (parentFormat) => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    const parentId = "72d14847-09f0-4562-aa8e-f7b42bf11749";
    const subagentId = "legacy01-cccc-dddd-eeee-ffff00001111";
    const parentMessage = { id: "p-user", timestamp: "2026-07-29T04:55:00.000Z", type: "user", content: "Delegate the audit" };
    const parentPath = path.join(chats, `session-2026-07-29T04-54-72d14847.${parentFormat}`);
    if (parentFormat === "json") {
      fs.writeFileSync(parentPath, JSON.stringify({ ...header(parentId), messages: [parentMessage] }), "utf8");
    } else {
      writeChat(parentPath, [header(parentId), parentMessage]);
    }
    const subagentPath = path.join(chats, parentId, `${subagentId}.json`);
    fs.mkdirSync(path.dirname(subagentPath), { recursive: true });
    fs.writeFileSync(subagentPath, JSON.stringify({
      ...header(subagentId, { kind: "subagent" }),
      messages: [
        { id: "s-user", timestamp: "2026-07-29T04:56:30.000Z", type: "user", content: "Audit the legacy middleware" },
      ],
    }), "utf8");

    const loaded = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });
    const byId = new Map(loaded.map((item) => [item.session.rawId, item]));

    expect(loaded).toHaveLength(2);
    expect(byId.get(parentId)?.session).toMatchObject({ isSubagent: false, parentSessionId: null });
    expect(byId.get(subagentId)?.session).toMatchObject({
      isSubagent: true,
      parentSessionId: parentId,
    });
    expect(byId.get(subagentId)?.messages.map((message) => message.content)).toEqual(["Audit the legacy middleware"]);
  });

  it("uses summaries as titles and ignores temp or unreadable chat files", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    writeChat(path.join(chats, "session-2026-07-29T06-00-abcdef01.jsonl"), [
      header("abcdef01-0000-0000-0000-000000000001"),
      { id: "u", timestamp: "2026-07-29T06:00:30.000Z", type: "user", content: "Summarized session" },
      { $set: { summary: "Custom summary" } },
    ]);
    writeChat(path.join(chats, "session-2026-07-29T06-05-deadbeef.jsonl.tmp-123"), [header("tmp-session")]);
    writeChat(path.join(chats, "session-2026-07-29T06-06-badc0de.jsonl.unreadable-1785300000000"), [header("unreadable-session")]);

    const loaded = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.originalTitle).toBe("Custom summary");
  });

  it("replays enriched re-emissions under the same message id without duplication", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    const geminiBase = { id: "dup-1", timestamp: "2026-07-29T08:00:00.000Z", type: "gemini", content: [{ text: "working on it" }] };
    writeChat(path.join(chats, "session-2026-07-29T08-00-dup00001.jsonl"), [
      header("dup00001-0000-0000-0000-000000000001"),
      { id: "u", timestamp: "2026-07-29T07:59:00.000Z", type: "user", content: "Run the audit" },
      { ...geminiBase, thoughts: [{ subject: "Plan", description: "first pass", timestamp: "2026-07-29T08:00:01.000Z" }], toolCalls: [{ id: "call-a", name: "grep", timestamp: "2026-07-29T08:00:02.000Z", args: { q: "auth" }, status: "ok" }] },
      { ...geminiBase, tokens: { input: 50, output: 10, cached: 0, thoughts: 2, tool: 4, total: 66 } },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });

    expect(loaded.messages.map((message) => message.content)).toEqual(["Run the audit", "working on it"]);
    expect(loaded.session.tokenUsage?.totalTokens).toBe(66);
    expect(loaded.traceEvents?.filter((event) => event.eventType === "gemini.thought")).toHaveLength(1);
    expect(loaded.traceEvents?.filter((event) => event.kind === "tool_call")).toHaveLength(1);
  });

  it("resolves rewinds that target filtered tool-only messages", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    writeChat(path.join(chats, "session-2026-07-29T09-00-aaaa0001.jsonl"), [
      header("aaaa0001-0000-0000-0000-000000000002"),
      { id: "keep-user", timestamp: "2026-07-29T09:00:00.000Z", type: "user", content: "Keep this request" },
      { id: "tool-only", timestamp: "2026-07-29T09:00:10.000Z", type: "gemini", content: [], toolCalls: [{ id: "call-z", name: "bash", timestamp: "2026-07-29T09:00:11.000Z", args: { cmd: "ls" }, status: "ok" }] },
      { id: "tail", timestamp: "2026-07-29T09:00:20.000Z", type: "gemini", content: "later answer" },
      { $rewindTo: "tool-only" },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });

    expect(loaded.messages.map((message) => message.content)).toEqual(["Keep this request"]);
    expect(loaded.traceEvents?.some((event) => event.callId === "call-z")).toBe(false);
  });

  it("indexes legacy .json conversation records", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    fs.writeFileSync(path.join(chats, "session-2026-07-29T10-00-legacy01.json"), JSON.stringify({
      sessionId: "legacy01-0000-0000-0000-000000000003",
      summary: "Persisted legacy summary",
      startTime: "2026-07-29T10:00:00.000Z",
      lastUpdated: "2026-07-29T10:01:00.000Z",
      messages: [
        { id: "lu", timestamp: "2026-07-29T10:00:30.000Z", type: "user", content: "Legacy request" },
        { id: "lg", timestamp: "2026-07-29T10:00:40.000Z", type: "gemini", content: "Legacy answer", tokens: { input: 8, output: 2, cached: 0, thoughts: 0, tool: 0, total: 10 } },
      ],
    }), "utf8");

    const [loaded] = loadDefaultSessions({ homeDir: root, includeGeminiCli: true });

    expect(loaded.session).toMatchObject({ rawId: "legacy01-0000-0000-0000-000000000003", source: "gemini-cli", originalTitle: "Persisted legacy summary" });
    expect(loaded.messages.map((message) => message.content)).toEqual(["Legacy request", "Legacy answer"]);
    expect(loaded.session.tokenUsage?.totalTokens).toBe(10);
  });

  it("resolves the root from GEMINI_CLI_HOME", () => {
    const syntheticHome = fixture();
    const altHome = fixture();
    const chats = path.join(altHome, ".gemini", "tmp", "gemini-app", "chats");
    fs.mkdirSync(chats, { recursive: true });
    writeChat(path.join(chats, "session-2026-07-29T11-00-bbb00002.jsonl"), [
      header("bbb00002-0000-0000-0000-000000000004"),
      { id: "u", timestamp: "2026-07-29T11:00:30.000Z", type: "user", content: "Alternate home request" },
    ]);

    vi.mocked(os.homedir).mockReturnValue(syntheticHome);
    process.env.GEMINI_CLI_HOME = altHome;
    const loaded = loadDefaultSessions({ includeGeminiCli: true }).filter((item) => item.session.source === "gemini-cli");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.rawId).toBe("bbb00002-0000-0000-0000-000000000004");
  });

  it("stays out of the default index until the optional source is enabled", () => {
    const root = fixture();
    const chats = projectChats(root, "gemini-app", "/work/gemini-app");
    writeChat(path.join(chats, "session-2026-07-29T07-00-12345678.jsonl"), [
      header("12345678-0000-0000-0000-000000000002"),
      { id: "u", timestamp: "2026-07-29T07:00:30.000Z", type: "user", content: "Hidden until enabled" },
    ]);

    expect(loadDefaultSessions({ homeDir: root })).toHaveLength(0);
    expect(loadDefaultSessions({ homeDir: root, includeGeminiCli: true })).toHaveLength(1);
  });
});
