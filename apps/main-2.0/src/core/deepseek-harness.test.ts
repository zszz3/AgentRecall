import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_HARNESS_LOG_NAME,
  deleteDeepSeekCliSessionDirectory,
  parseDeepSeekSessionLog,
  scanDeepSeekZstdFrames,
} from "./deepseek-harness";
import { loadDeepSeekCliSessions } from "./session-loader";
import { deriveSessionTimeline } from "./turns/derive-turns";

describe("deepseek harness session parser", () => {
  it("rejects non-zstd garbage", () => {
    expect(parseDeepSeekSessionLog(Buffer.from("not zstd"))).toBeNull();
    expect(() => scanDeepSeekZstdFrames(Buffer.from([1, 2, 3, 4, 5]))).toThrow();
  });

  it("refuses to recursively delete a lookalike log outside the DSH sessions layout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-dsh-delete-guard-"));
    try {
      const sessionDir = path.join(root, "not-sessions", "project", "session");
      const logPath = path.join(sessionDir, DEEPSEEK_HARNESS_LOG_NAME);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(logPath, "fixture");
      deleteDeepSeekCliSessionDirectory(logPath);
      expect(fs.existsSync(logPath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads concatenated harness frames and stops at a sequence gap", async () => {
    const { zstdCompressSync } = await import("node:zlib");
    const header = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "session", version: 0, id: "framed", createdAt: 1700000000000, cwd: "/work", delegationDepth: 0 })}\n`));
    const firstBatch = zstdCompressSync(Buffer.from(`${JSON.stringify({
      type: "user/message",
      seq: 0,
      time: 1700000000001,
      data: { id: "m1", role: "user", content: [{ type: "text", text: "first" }], source: { kind: "user" } },
    })}\n`));
    const badBatch = zstdCompressSync(Buffer.from([
      JSON.stringify({ type: "text-chunks", seq0: 2, time0: 1700000000002, data: { turn: 1, step: 1, index: 0, texts: ["a", "b", "c"], dt: [1, 1] } }),
      JSON.stringify({ type: "assistant/message", seq: 1, time: 1700000000005, data: { turn: 1, step: 1, message: { id: "m2", role: "assistant", content: [{ type: "text", text: "must not be accepted" }], source: { kind: "model" } } } }),
      "",
    ].join("\n")));

    const parsed = parseDeepSeekSessionLog(Buffer.concat([header, firstBatch, badBatch]));
    expect(parsed?.events).toHaveLength(1);
    expect(parsed?.committedBytes).toBe(header.length + firstBatch.length);
  });

  it.each([0, 4])("parses and safely deletes a synthetic v%s harness log", async (version) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-dsh-"));
    try {
      const { zstdCompressSync } = await import("node:zlib");
      const lines = [
        { type: "session", version, id: "session-abc", createdAt: 1700000000000, cwd: "/work/demo", delegationDepth: 0, agentPreset: "standard" },
        { type: "permission/preset", seq: 0, time: 1700000000001, data: { preset: "workspace-write" } },
        { type: "turn/start", seq: 1, time: 1700000000002, data: { turn: 1 } },
        { type: "step/start", seq: 2, time: 1700000000003, data: { turn: 1, step: 1 } },
        { type: "user/message", seq: 3, time: 1700000000004, data: { id: "m1", role: "user", content: [{ type: "text", text: "请修复登录 bug" }], source: { kind: "user", rpcId: "rpc1" } }, surfaceOp: "append" },
        { type: "assistant/chunk", seq: 4, time: 1700000000005, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 1 } } } },
        { type: "assistant/message", seq: 5, time: 1700000000006, data: { turn: 1, step: 1, message: { id: "m2", role: "assistant", content: [{ type: "text", text: "好的，先查看代码。" }], source: { kind: "model", provider: "tt-switch", model: "deepseek-v4-pro-ioa" } }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3, reasoningTokens: 2 } }, surfaceOp: "append" },
        { type: "tool/call", seq: 6, time: 1700000000007, data: { turn: 1, step: 1, callId: "call_1", name: "bash", arguments: "ls" } },
        { type: "tool/result", seq: 7, time: 1700000000008, data: { turn: 1, step: 1, message: version === 4 ? { id: "m3", role: "tool", toolCallId: "call_1", isError: true, content: [{ type: "text", text: "demo" }], source: { kind: "tool" } } : { id: "m3", role: "user", content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "demo" }] }], source: { kind: "tool", callId: "call_1" } } } },
        { type: "step/end", seq: 8, time: 1700000000009, data: { turn: 1, step: 1 } },
        { type: "turn/end", seq: 9, time: 1700000000010, data: { turn: 1, reason: { kind: "completed" } } },
        { type: "session/title", seq: 10, time: 1700000000011, data: { title: "修复登录 bug", messageSeqs: [3], source: { kind: "fallback" } } },
      ];
      const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
      const compressed = zstdCompressSync(Buffer.from(text));
      const sessionDir = path.join(root, "sessions", "--work-demo--", "session-abc");
      fs.mkdirSync(sessionDir, { recursive: true });
      const logPath = path.join(sessionDir, version === 4 ? "session.v4.jsonl.zstd" : DEEPSEEK_HARNESS_LOG_NAME);
      fs.writeFileSync(logPath, compressed);

      const loaded = loadDeepSeekCliSessions(root);
      expect(loaded).toHaveLength(1);
      const { session, messages, tokenEvents = [], traceEvents = [] } = loaded[0];
      expect(session.rawId).toBe("session-abc");
      expect(session.projectPath).toBe("/work/demo");
      expect(session.originalTitle).toBe("修复登录 bug");
      expect(session.source).toBe("deepseek-cli");
      expect(session.tokenUsage).toEqual({
        inputTokens: 10,
        outputTokens: 3,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 3,
        reasoningOutputTokens: 2,
        totalTokens: 20,
      });
      expect(tokenEvents).toEqual([{
        inputTokens: 10,
        outputTokens: 3,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 3,
        reasoningOutputTokens: 2,
        totalTokens: 20,
        timestamp: 1700000000006,
        dedupeKey: "deepseek:session-abc:1:1",
      }]);
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages[0].content).toBe("请修复登录 bug");
      expect(messages[1].content).toBe("好的，先查看代码。");
      expect(traceEvents.map((event) => event.kind)).toEqual(["tool_call"]);
      expect(traceEvents[0].title).toBe("bash");
      expect(traceEvents[0].status).toBe(version === 4 ? "failed" : "completed");
      expect(traceEvents[0].detail).toContain("demo");
      expect(deriveSessionTimeline({
        sessionKey: session.sessionKey,
        messages,
        tokenEvents,
        traceEvents,
      }).turns[0]).toMatchObject({
        inputTokens: 10,
        outputTokens: 3,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 3,
        reasoningOutputTokens: 2,
        totalTokens: 20,
      });

      // Best-effort source deletion removes only the session directory.
      deleteDeepSeekCliSessionDirectory(logPath);
      expect(fs.existsSync(sessionDir)).toBe(false);
      expect(fs.existsSync(root)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips a log with no human messages and expands packed chunk rows", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-dsh-chunks-"));
    try {
      const { zstdCompressSync } = await import("node:zlib");
      const lines = [
        { type: "session", version: 0, id: "session-chunks", createdAt: 1700000000000, cwd: "/work/chunks", delegationDepth: 0 },
        { type: "turn/start", seq: 0, time: 1700000000001, data: { turn: 1 } },
        { type: "step/start", seq: 1, time: 1700000000002, data: { turn: 1, step: 1 } },
        { type: "user/message", seq: 2, time: 1700000000003, data: { id: "m1", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } }, surfaceOp: "append" },
        { type: "text-chunks", seq0: 3, time0: 1700000000004, data: { turn: 1, step: 1, index: 0, texts: ["你", "好", "呀"], dt: [1, 2] } },
        { type: "assistant/message", seq: 6, time: 1700000000010, data: { turn: 1, step: 1, message: { id: "m2", role: "assistant", content: [{ type: "text", text: "你好呀" }], source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 1, outputTokens: 2 } }, surfaceOp: "append" },
      ];
      const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
      const logPath = path.join(root, "sessions", "--work-chunks--", "session-chunks", DEEPSEEK_HARNESS_LOG_NAME);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, zstdCompressSync(Buffer.from(text)));

      const loaded = loadDeepSeekCliSessions(root);
      expect(loaded).toHaveLength(1);
      const { messages, traceEvents } = loaded[0];
      expect(messages.map((message) => message.content)).toEqual(["你好", "你好呀"]);
      expect(traceEvents).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips injected user messages and empty assistant steps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-dsh-inject-"));
    try {
      const { zstdCompressSync } = await import("node:zlib");
      const lines = [
        { type: "session", version: 0, id: "session-inject", createdAt: 1700000000000, cwd: "/work/inject", delegationDepth: 0 },
        { type: "user/message", seq: 0, time: 1700000000001, data: { id: "m1", role: "user", content: [{ type: "text", text: "<system-reminder>AGENTS.md</system-reminder>" }], source: { kind: "instruction-hint" } }, surfaceOp: "append" },
        { type: "user/message", seq: 1, time: 1700000000002, data: { id: "m2", role: "user", content: [{ type: "text", text: "真正的问题" }], source: { kind: "user" } }, surfaceOp: "append" },
        { type: "assistant/message", seq: 2, time: 1700000000003, data: { turn: 1, step: 1, message: { id: "m3", role: "assistant", content: [{ type: "reasoning", text: "内部思考" }], source: { kind: "model", provider: "p", model: "m" } } }, surfaceOp: "append" },
      ];
      const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
      const logPath = path.join(root, "sessions", "--work-inject--", "session-inject", DEEPSEEK_HARNESS_LOG_NAME);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, zstdCompressSync(Buffer.from(text)));

      const loaded = loadDeepSeekCliSessions(root);
      expect(loaded).toHaveLength(1);
      const { messages } = loaded[0];
      expect(messages.map((message) => message.content)).toEqual(["真正的问题"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers sessions from DSH_HOME without reading the real home", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-dsh-home-"));
    const previous = process.env.DSH_HOME;
    try {
      process.env.DSH_HOME = root;
      const { zstdCompressSync } = await import("node:zlib");
      const logPath = path.join(root, "sessions", "--work--", "custom-home", DEEPSEEK_HARNESS_LOG_NAME);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, zstdCompressSync(Buffer.from([
        JSON.stringify({ type: "session", version: 0, id: "custom-home", createdAt: 1700000000000, cwd: "/work", delegationDepth: 0 }),
        JSON.stringify({
          type: "user/message",
          seq: 0,
          time: 1700000000001,
          data: { id: "m1", role: "user", content: [{ type: "text", text: "from DSH_HOME" }], source: { kind: "user" } },
        }),
        "",
      ].join("\n"))));

      expect(loadDeepSeekCliSessions()).toHaveLength(1);
      expect(loadDeepSeekCliSessions()[0].session.rawId).toBe("custom-home");
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
