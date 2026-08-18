import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { syncDefaultSessionsInBatches } from "./indexer";
import { createInMemoryStore } from "./postgres/test-session-store";
import {
  loadDeepSeekHarnessSessionFile,
  loadDeepSeekHarnessSessions,
  loadDefaultSessions,
  loadDefaultSessionsAsyncIterator,
  resolveDeepSeekHarnessHome,
} from "./session-loader";
import { MAX_ATTACHMENT_BYTES } from "./session-attachments";
import type { LoadedSession } from "./types";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const roots: string[] = [];

function temporaryHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-dsh-v2-"));
  roots.push(root);
  return root;
}

function encodeSegment(raw: string): string {
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let encoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    encoded += character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
}

function projectKey(cwd: string): string {
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/u, "") || "root").slice(0, 251)}--`;
}

function sessionPath(
  dshHome: string,
  identity: { id: string; cwd?: string },
  compressed = false,
  override: { project?: string; directory?: string } = {},
): string {
  return path.join(
    dshHome,
    "sessions",
    override.project ?? (identity.cwd === undefined ? "_no-cwd" : projectKey(identity.cwd)),
    override.directory ?? encodeSegment(identity.id),
    compressed ? "session.jsonl.zstd" : "session.jsonl",
  );
}

function jsonl(rows: unknown[], terminalNewline = true): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}${terminalNewline ? "\n" : ""}`;
}

function writeRawSession(
  dshHome: string,
  rows: unknown[],
  options: { project?: string; directory?: string; tail?: string } = {},
): string {
  const storedHeader = rows[0] as { id: string; cwd?: string };
  const filePath = sessionPath(dshHome, storedHeader, false, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, jsonl(rows) + (options.tail ?? ""));
  return filePath;
}

function zstdFrame(value: string): Buffer {
  return zstdCompressSync(Buffer.from(value), {
    params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
  });
}

function zstdPrefix(frame: Buffer): string {
  return zstdDecompressSync(frame, {
    finishFlush: zlibConstants.ZSTD_e_flush,
  }).toString("utf8");
}

function tornZstdFrame(
  plaintext: string,
  accepts: (decoded: string) => boolean,
): Buffer {
  const frame = zstdFrame(plaintext);
  const candidateEnds = [
    frame.length - 1,
    frame.length - 4,
    ...[0.9, 0.75, 0.6, 0.5, 0.4, 0.25].map((ratio) => Math.floor(frame.length * ratio)),
  ];
  for (const end of candidateEnds) {
    const candidate = frame.subarray(0, end);
    try {
      if (accepts(zstdPrefix(candidate))) return candidate;
    } catch {
      // Earlier cuts can precede the first decodable block.
    }
  }
  throw new Error("test fixture could not produce the requested torn Zstandard frame");
}

function deterministicNoise(length: number): string {
  let state = 0x12345678;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output += String.fromCharCode(33 + (state % 90));
  }
  return output;
}

function writeZstdSession(
  dshHome: string,
  frames: Buffer[],
  options: { id?: string; cwd?: string; project?: string; directory?: string } = {},
): string {
  const filePath = sessionPath(
    dshHome,
    { id: options.id ?? "dsh-session", ...(options.cwd === undefined ? { cwd: "/workspace/dsh" } : { cwd: options.cwd }) },
    true,
    options,
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat(frames));
  return filePath;
}

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "session",
    version: 0,
    id: "dsh-session",
    createdAt: Date.parse("2026-08-17T01:00:00.000Z"),
    cwd: "/workspace/dsh",
    delegationDepth: 0,
    ...overrides,
  };
}

function currentAndLegacyRows(id = "session:/雪"): unknown[] {
  return [
    header({
      id,
      parentSession: "parent/α",
      origin: "subagent",
      delegationDepth: 1,
    }),
    { type: "turn/start", seq: 0, time: Date.parse("2026-08-17T01:00:01.000Z"), data: { turn: 1 } },
    {
      type: "user/message",
      seq: 1,
      time: Date.parse("2026-08-17T01:00:01.100Z"),
      surfaceOp: "append",
      data: {
        content: [{ type: "text", text: "plugin context must stay hidden" }],
        source: { kind: "plugin", plugin: "runtime" },
        role: "user",
        id: "plugin-message",
      },
    },
    {
      type: "user/message",
      seq: 2,
      time: Date.parse("2026-08-17T01:00:01.200Z"),
      surfaceOp: "append",
      data: {
        content: [{ type: "text", text: "Inspect the DeepSeek Harness session" }],
        source: { kind: "user" },
      },
    },
    {
      type: "session/title",
      seq: 3,
      time: Date.parse("2026-08-17T01:00:01.300Z"),
      data: { title: "First generated title" },
    },
    {
      type: "assistant/message",
      seq: 4,
      time: Date.parse("2026-08-17T01:00:02.000Z"),
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "assistant",
          id: "assistant-current",
          source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
          content: [
            { type: "reasoning", text: "private reasoning" },
            { type: "text", text: "I will inspect the files." },
            { type: "tool-call", id: "call-read", name: "read", arguments: "{\"file_path\":\"README.md\"}" },
          ],
        },
        usage: {
          inputTokens: 10,
          outputTokens: 30,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          reasoningTokens: 8,
        },
      },
    },
    {
      type: "tool/call",
      seq: 5,
      time: Date.parse("2026-08-17T01:00:02.100Z"),
      data: {
        turn: 1,
        step: 1,
        callId: "call-read",
        name: "read",
        arguments: "{\"path\":\"README.md\",\"file_path\":\"WRONG.md\"}",
      },
    },
    {
      type: "tool/call",
      seq: 6,
      time: Date.parse("2026-08-17T01:00:02.150Z"),
      surfaceOp: { op: "replace", start: 1, end: 1 },
      data: {
        turn: 1,
        step: 1,
        callId: "call-hidden",
        name: "hidden",
        arguments: "{\"path\":\"secret\"}",
      },
    },
    {
      type: "tool/result",
      seq: 7,
      time: Date.parse("2026-08-17T01:00:02.200Z"),
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "user",
          id: "tool-result-current",
          source: { kind: "tool", callId: "call-read" },
          content: [
            {
              type: "tool-result",
              toolCallId: "different-call",
              content: [{ type: "text", text: "mismatched result must stay hidden" }],
              isError: false,
            },
            {
              type: "tool-result",
              toolCallId: "call-read",
              content: [{ type: "text", text: "README contents" }],
              isError: false,
            },
          ],
        },
      },
    },
    {
      type: "assistant/message",
      seq: 8,
      time: Date.parse("2026-08-17T01:00:03.000Z"),
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 2,
        content: [{ type: "text", text: "Legacy response parsed." }],
        provenance: { provider: "deepseek", model: "legacy" },
        usage: {
          inputTokens: 5,
          outputTokens: 12,
          cacheReadTokens: 1,
          reasoningTokens: 2,
        },
      },
    },
    {
      type: "assistant/message",
      seq: 9,
      time: Date.parse("2026-08-17T01:00:03.100Z"),
      surfaceOp: { op: "replace", start: 2, end: 7 },
      data: {
        turn: 1,
        step: 3,
        message: {
          role: "assistant",
          id: "compaction",
          source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
          content: [{ type: "text", text: "must not replace append-only history" }],
        },
        usage: { inputTokens: 10_000, outputTokens: 10_000 },
      },
    },
    {
      type: "session/title",
      seq: 10,
      time: Date.parse("2026-08-17T01:00:03.200Z"),
      data: { title: "Latest Harness title" },
    },
    {
      type: "turn/end",
      seq: 11,
      time: Date.parse("2026-08-17T01:00:04.000Z"),
      data: { turn: 1, reason: { kind: "completed" } },
    },
    {
      type: "text-chunks",
      seq0: 12,
      time0: Date.parse("2026-08-17T01:00:04.100Z"),
      data: {
        turn: 1,
        step: 2,
        index: 0,
        dt: [1, 1],
        texts: ["Legacy", " response", " parsed."],
      },
    },
  ];
}

function writeAttachmentObject(dshHome: string, digest: string, bytes: Buffer): string {
  const filePath = path.join(dshHome, "attachments", "v1", "objects", digest.slice(0, 2), digest);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("DeepSeek Harness home resolution", () => {
  it("matches explicit, environment, default, tilde, and relative DSH_HOME rules", () => {
    const homeDir = path.resolve("/synthetic/home");
    const cwd = path.resolve("/synthetic/work");
    expect(resolveDeepSeekHarnessHome("/explicit/dsh", {
      homeDir,
      cwd,
      env: { DSH_HOME: "~/ignored" },
    })).toBe(path.resolve("/explicit/dsh"));
    expect(resolveDeepSeekHarnessHome(undefined, {
      homeDir,
      cwd,
      env: { DSH_HOME: "~/env-dsh" },
    })).toBe(path.join(homeDir, "env-dsh"));
    expect(resolveDeepSeekHarnessHome(undefined, {
      homeDir,
      cwd,
      env: { DSH_HOME: "   " },
    })).toBe(path.join(homeDir, ".dsh"));
    expect(resolveDeepSeekHarnessHome("relative-dsh", {
      homeDir,
      cwd,
      env: {},
    })).toBe(path.join(cwd, "relative-dsh"));
    expect(resolveDeepSeekHarnessHome("~\\custom-dsh", {
      homeDir,
      cwd,
      env: {},
    })).toBe(path.join(homeDir, "custom-dsh"));
  });
});

describe("DeepSeek Harness session loading", () => {
  it("indexes current and legacy v0 events with human messages, title, traces, usage, and lineage", async () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const filePath = writeRawSession(dshHome, currentAndLegacyRows());

    expect(loadDefaultSessions({ homeDir }).some((item) => item.session.source === "deepseek-harness")).toBe(false);
    const loaded = loadDefaultSessions({
      homeDir,
      includeDeepSeekHarness: true,
      deepSeekHarnessHomeDir: dshHome,
    }).filter((item) => item.session.source === "deepseek-harness");
    expect(loaded).toHaveLength(1);
    const item = loaded[0];
    expect(item.session).toMatchObject({
      sessionKey: "dsh:session:/雪",
      rawId: "session:/雪",
      source: "deepseek-harness",
      projectPath: "/workspace/dsh",
      filePath,
      originalTitle: "Latest Harness title",
      firstQuestion: "Inspect the DeepSeek Harness session",
      isSubagent: true,
      parentSessionId: "parent/α",
      tokenUsage: {
        inputTokens: 15,
        outputTokens: 32,
        cachedInputTokens: 5,
        cacheCreationInputTokens: 2,
        reasoningOutputTokens: 10,
        totalTokens: 64,
      },
    });
    expect(item.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Inspect the DeepSeek Harness session",
        sourceTurnId: "dsh:1",
      }),
      expect.objectContaining({
        role: "assistant",
        content: "I will inspect the files.",
        sourceTurnId: "dsh:1",
      }),
      expect.objectContaining({
        role: "assistant",
        content: "Legacy response parsed.",
        sourceTurnId: "dsh:1",
      }),
    ]);
    expect(item.messages.some((message) => message.content.includes("private reasoning"))).toBe(false);
    expect(item.messages.some((message) => message.content.includes("must not replace"))).toBe(false);
    expect(item.tokenEvents).toEqual([
      expect.objectContaining({
        dedupeKey: "dsh:4",
        outputTokens: 22,
        reasoningOutputTokens: 8,
        sourceTurnId: "dsh:1",
      }),
      expect.objectContaining({
        dedupeKey: "dsh:8",
        outputTokens: 10,
        reasoningOutputTokens: 2,
        sourceTurnId: "dsh:1",
      }),
    ]);
    expect(item.traceEvents).toEqual([
      expect.objectContaining({
        eventType: "dsh.turn.started",
        status: "running",
        sourceTurnId: "dsh:1",
      }),
      expect.objectContaining({
        kind: "tool_call",
        source: "dsh",
        title: "read · README.md",
        callId: "call-read",
        sourceTurnId: "dsh:1",
      }),
      expect.objectContaining({
        kind: "tool_result",
        title: "read · result",
        detail: "README contents",
        callId: "call-read",
        status: "completed",
        sourceTurnId: "dsh:1",
      }),
      expect.objectContaining({
        eventType: "dsh.turn.completed",
        status: "completed",
        attributes: expect.objectContaining({ durationMs: 3_000 }),
      }),
    ]);
    expect((item.traceEvents ?? []).some((event) => event.callId === "call-hidden")).toBe(false);

    const asyncLoaded: LoadedSession[] = [];
    for await (const candidate of loadDefaultSessionsAsyncIterator({
      homeDir,
      includeDeepSeekHarness: true,
      deepSeekHarnessHomeDir: dshHome,
    })) {
      if (candidate.session.source === "deepseek-harness") asyncLoaded.push(candidate);
    }
    expect(asyncLoaded.map((candidate) => candidate.session.sessionKey)).toEqual(["dsh:session:/雪"]);
  });

  it("decodes every complete Zstandard frame and safely ignores an unrecoverable torn frame", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const rows = currentAndLegacyRows("zstd-session");
    const headerFrame = zstdFrame(jsonl([rows[0]]));
    const eventText = jsonl(rows.slice(1));
    const splitAt = eventText.indexOf("Inspect the DeepSeek") + 8;
    const eventFrameA = zstdFrame(eventText.slice(0, splitAt));
    const eventFrameB = zstdFrame(eventText.slice(splitAt));
    const tornFrame = zstdFrame(jsonl([{
      type: "session/title",
      seq: 99,
      time: Date.parse("2026-08-17T01:00:05.000Z"),
      data: { title: "Torn title must not win" },
    }])).subarray(0, 5);
    const filePath = writeZstdSession(
      dshHome,
      [headerFrame, eventFrameA, eventFrameB, tornFrame],
      { id: "zstd-session" },
    );
    const before = fs.readFileSync(filePath);

    expect(zstdDecompressSync(Buffer.concat([headerFrame, eventFrameA, eventFrameB])).toString("utf8"))
      .not.toContain("Inspect the DeepSeek Harness session");
    const loaded = loadDeepSeekHarnessSessionFile(filePath, dshHome);

    expect(loaded.messages.map((message) => message.content)).toContain("Legacy response parsed.");
    expect(loaded.session.originalTitle).toBe("Latest Harness title");
    expect(fs.readFileSync(filePath)).toEqual(before);
  });

  it("recovers complete events when only the final Zstandard checksum is torn", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const rows = currentAndLegacyRows("zstd-torn-checksum");
    const recovered = {
      type: "user/message",
      seq: 15,
      time: Date.parse("2026-08-17T01:00:05.000Z"),
      surfaceOp: "append",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "recovered from a torn checksum" }],
      },
    };
    const finalFrame = zstdFrame(jsonl([recovered]));
    const tornChecksumFrame = finalFrame.subarray(0, -1);
    expect(zstdPrefix(tornChecksumFrame)).toBe(jsonl([recovered]));
    const filePath = writeZstdSession(dshHome, [
      zstdFrame(jsonl([rows[0]])),
      zstdFrame(jsonl(rows.slice(1))),
      tornChecksumFrame,
    ], { id: "zstd-torn-checksum" });
    const before = fs.readFileSync(filePath);

    const loaded = loadDeepSeekHarnessSessionFile(filePath, dshHome);

    expect(loaded.messages.map((message) => message.content))
      .toContain("recovered from a torn checksum");
    expect(fs.readFileSync(filePath)).toEqual(before);
  });

  it("keeps complete JSONL records from a torn Zstandard payload and drops its partial line", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const rows = currentAndLegacyRows("zstd-torn-payload");
    const completeEvent = {
      type: "user/message",
      seq: 15,
      time: Date.parse("2026-08-17T01:00:05.000Z"),
      surfaceOp: "append",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "complete recovered payload event" }],
      },
    };
    const partialEvent = {
      type: "assistant/message",
      seq: 16,
      time: Date.parse("2026-08-17T01:00:06.000Z"),
      surfaceOp: "append",
      data: {
        turn: 2,
        message: {
          role: "assistant",
          source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
          content: [{
            type: "text",
            text: `partial event must be discarded ${deterministicNoise(300_000)}`,
          }],
        },
      },
    };
    const tornPayloadFrame = tornZstdFrame(
      jsonl([completeEvent, partialEvent]),
      (decoded) => decoded.startsWith(`${JSON.stringify(completeEvent)}\n`)
        && !decoded.endsWith("\n"),
    );
    const filePath = writeZstdSession(dshHome, [
      zstdFrame(jsonl([rows[0]])),
      zstdFrame(jsonl(rows.slice(1))),
      tornPayloadFrame,
    ], { id: "zstd-torn-payload" });
    const before = fs.readFileSync(filePath);

    const loaded = loadDeepSeekHarnessSessionFile(filePath, dshHome);

    expect(loaded.messages.map((message) => message.content))
      .toContain("complete recovered payload event");
    expect(loaded.messages.some((message) => message.content.includes("partial event must be discarded")))
      .toBe(false);
    expect(fs.readFileSync(filePath)).toEqual(before);
  });

  it("rejects a non-canonical Zstandard header frame and an unterminated complete frame", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const badHeaderPath = writeZstdSession(dshHome, [
      zstdFrame(jsonl([
        header({ id: "bad-header-frame" }),
        { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      ])),
    ], { id: "bad-header-frame" });
    const unterminatedPath = writeZstdSession(dshHome, [
      zstdFrame(jsonl([header({ id: "unterminated-frame" })])),
      zstdFrame(jsonl([
        { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      ], false)),
    ], { id: "unterminated-frame" });

    expect(() => loadDeepSeekHarnessSessionFile(badHeaderPath, dshHome))
      .toThrow("first frame is not exactly one header line");
    expect(() => loadDeepSeekHarnessSessionFile(unterminatedPath, dshHome))
      .toThrow("complete Zstandard frame contains an unterminated JSONL record");
  });

  it("ignores only a raw torn tail and isolates a corrupt sibling", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const validPath = writeRawSession(dshHome, currentAndLegacyRows("raw-tail"), {
      tail: "{\"type\":\"assistant/message\"",
    });
    writeRawSession(dshHome, [
      header({ id: "corrupt-sibling", cwd: "/workspace/bad-project" }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    ], { tail: "{bad json}\n" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const loaded = loadDeepSeekHarnessSessions({
      homeDir,
      deepSeekHarnessHomeDir: dshHome,
    });

    expect(loaded.map((item) => item.session.sessionKey)).toEqual(["dsh:raw-tail"]);
    expect(loaded[0].session.filePath).toBe(validPath);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid DeepSeek Harness JSONL record"));
  });

  it.each(["", "   ", "\t"])(
    "rejects a committed internal JSONL whitespace record %j while preserving a torn whitespace tail",
    (blank) => {
      const homeDir = temporaryHome();
      const dshHome = path.join(homeDir, ".dsh");
      const committedId = `committed-blank-${blank.length}`;
      const committedPath = sessionPath(dshHome, { id: committedId, cwd: "/workspace/dsh" });
      fs.mkdirSync(path.dirname(committedPath), { recursive: true });
      fs.writeFileSync(committedPath, [
        JSON.stringify(header({ id: committedId })),
        JSON.stringify({ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }),
        blank,
        JSON.stringify({ type: "turn/end", seq: 1, time: 2, data: { turn: 1, reason: { kind: "completed" } } }),
        "",
      ].join("\n"));
      const tornPath = writeRawSession(dshHome, [
        header({ id: `torn-blank-${blank.length}` }),
        { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      ], { tail: blank || " " });

      expect(() => loadDeepSeekHarnessSessionFile(committedPath, dshHome))
        .toThrow("blank DeepSeek Harness JSONL record at line 3");
      expect(loadDeepSeekHarnessSessionFile(tornPath, dshHome).traceEvents)
        .toEqual([expect.objectContaining({ eventType: "dsh.turn.started" })]);
    },
  );

  it("validates contiguous storage sequences while ignoring well-formed packed chunk rows", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const validPath = writeRawSession(dshHome, [
      header({ id: "packed-valid", createdAt: 0 }),
      { type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
      {
        type: "text-chunks",
        seq0: 1,
        time0: 1,
        data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ["a", "b", "c"] },
      },
      {
        type: "assistant/message",
        seq: 4,
        time: 4,
        surfaceOp: "append",
        data: { turn: 1, content: [{ type: "text", text: "packed rows stay hidden" }] },
      },
    ]);
    const gapPath = writeRawSession(dshHome, [
      header({ id: "sequence-gap" }),
      { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
    ]);
    const duplicatePath = writeRawSession(dshHome, [
      header({ id: "sequence-duplicate" }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 0,
        time: 2,
        surfaceOp: "append",
        data: { source: { kind: "user" }, content: [{ type: "text", text: "duplicate" }] },
      },
    ]);
    const malformedPackedPath = writeRawSession(dshHome, [
      header({ id: "packed-malformed" }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      {
        type: "tool-call-chunks",
        seq0: 1,
        time0: 2,
        data: { turn: 1, step: 1, index: 0, dt: [], args: ["a", "b"] },
      },
    ]);
    const oversizedSeedPath = writeRawSession(dshHome, [
      header({ id: "oversized-seed", seedLength: 2 }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    ]);

    const loaded = loadDeepSeekHarnessSessionFile(validPath, dshHome);
    expect(loaded.session.timestamp).toBe(0);
    expect(loaded.messages.map((message) => message.content)).toEqual(["packed rows stay hidden"]);
    expect(loaded.traceEvents?.[0]).toMatchObject({
      eventType: "dsh.turn.started",
      timestamp: "1970-01-01T00:00:00.000Z",
    });
    expect(() => loadDeepSeekHarnessSessionFile(gapPath, dshHome))
      .toThrow("storage sequence gap");
    expect(() => loadDeepSeekHarnessSessionFile(duplicatePath, dshHome))
      .toThrow("storage sequence gap");
    expect(() => loadDeepSeekHarnessSessionFile(malformedPackedPath, dshHome))
      .toThrow("malformed DeepSeek Harness tool-call-chunks storage row");
    expect(() => loadDeepSeekHarnessSessionFile(oversizedSeedPath, dshHome))
      .toThrow("seedLength 2 exceeds the decoded event count 1");
  });

  it("rejects unknown required events while allowing only an explicit ignorable true marker", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const requiredPath = writeRawSession(dshHome, [
      header({ id: "unknown-required" }),
      { type: "future/required", seq: 0, time: 1, data: {} },
      {
        type: "user/message",
        seq: 1,
        time: 2,
        surfaceOp: "append",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "must not load through an unknown required event" }],
        },
      },
    ]);
    const ignorablePath = writeRawSession(dshHome, [
      header({ id: "unknown-ignorable" }),
      { type: "future/informational", seq: 0, time: 1, data: {}, ignorable: true },
      {
        type: "user/message",
        seq: 1,
        time: 2,
        surfaceOp: "append",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "known content after an ignorable event" }],
        },
      },
    ]);
    const truthyPath = writeRawSession(dshHome, [
      header({ id: "unknown-truthy" }),
      { type: "future/truthy", seq: 0, time: 1, data: {}, ignorable: "true" },
      { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
    ]);
    const inheritedPath = writeRawSession(dshHome, [
      header({ id: "unknown-inherited", seedLength: 1 }),
      { type: "future/inherited-required", seq: 0, time: 1, data: {} },
      {
        type: "user/message",
        seq: 1,
        time: 2,
        surfaceOp: "append",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "fork-owned content" }],
        },
      },
    ]);

    expect(() => loadDeepSeekHarnessSessionFile(requiredPath, dshHome))
      .toThrow("event type \"future/required\" at line 2 is unsupported and required");
    expect(loadDeepSeekHarnessSessionFile(ignorablePath, dshHome).messages)
      .toEqual([expect.objectContaining({ content: "known content after an ignorable event" })]);
    expect(() => loadDeepSeekHarnessSessionFile(truthyPath, dshHome))
      .toThrow("invalid ignorable marker");
    expect(() => loadDeepSeekHarnessSessionFile(inheritedPath, dshHome))
      .toThrow("event type \"future/inherited-required\" at line 2 is unsupported and required");
  });

  it("drops a syntactically valid raw record without a committed newline and retries a stale stat", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const rows = currentAndLegacyRows("committed-boundary");
    const filePath = writeRawSession(dshHome, rows);
    fs.appendFileSync(filePath, JSON.stringify({
      type: "session/title",
      seq: 200,
      time: Date.parse("2026-08-17T01:00:06.000Z"),
      data: { title: "Valid JSON without newline must stay invisible" },
    }));

    const loaded = loadDeepSeekHarnessSessionFile(filePath, dshHome, { mtimeMs: 0, size: 0 });

    expect(loaded.session.originalTitle).toBe("Latest Harness title");
    expect(loaded.session.fileSize).toBe(fs.statSync(filePath).size);
    expect(loaded.session.fileMtimeMs).toBe(fs.statSync(filePath).mtimeMs);
  });

  it("refuses a transcript replaced by a symbolic link after discovery", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const rows = currentAndLegacyRows("symlink-race");
    const filePath = writeRawSession(dshHome, rows);
    const outsidePath = path.join(homeDir, "outside-session.jsonl");
    fs.writeFileSync(outsidePath, jsonl(rows));
    const probePath = path.join(homeDir, "symlink-probe");
    try {
      fs.symlinkSync(outsidePath, probePath, "file");
      fs.unlinkSync(probePath);
    } catch (error) {
      if (
        process.platform === "win32"
        && typeof error === "object"
        && error !== null
        && "code" in error
        && (error.code === "EPERM" || error.code === "EACCES")
      ) return;
      throw error;
    }

    const discovered = fs.statSync(filePath);
    let replaced = false;
    const staleStat = {
      get mtimeMs(): number {
        if (!replaced) {
          fs.renameSync(filePath, `${filePath}.original`);
          fs.symlinkSync(outsidePath, filePath, "file");
          replaced = true;
        }
        return discovered.mtimeMs;
      },
      size: discovered.size,
    };

    expect(() => loadDeepSeekHarnessSessionFile(filePath, dshHome, staleStat))
      .toThrow(/regular non-symlink|without following links|resolves outside/u);
    expect(replaced).toBe(true);
  });

  it("refuses a transcript replaced by a non-regular file after discovery", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const filePath = writeRawSession(dshHome, currentAndLegacyRows("non-regular-race"));
    const discovered = fs.statSync(filePath);
    let replaced = false;
    const staleStat = {
      get mtimeMs(): number {
        if (!replaced) {
          fs.renameSync(filePath, `${filePath}.original`);
          fs.mkdirSync(filePath);
          replaced = true;
        }
        return discovered.mtimeMs;
      },
      size: discovered.size,
    };

    expect(() => loadDeepSeekHarnessSessionFile(filePath, dshHome, staleStat))
      .toThrow(/not a .*regular non-symlink file/u);
    expect(replaced).toBe(true);
  });

  it.each(["session", "project"] as const)(
    "refuses a %s directory replaced by a symlink escaping the canonical sessions root",
    (level) => {
      if (process.platform === "win32") return;
      const homeDir = temporaryHome();
      const dshHome = path.join(homeDir, ".dsh");
      const filePath = writeRawSession(dshHome, currentAndLegacyRows(`parent-link-${level}`));
      const sessionDir = path.dirname(filePath);
      const projectDir = path.dirname(sessionDir);
      const outsideTarget = path.join(homeDir, `outside-${level}`);
      const outsideFile = level === "session"
        ? path.join(outsideTarget, "session.jsonl")
        : path.join(outsideTarget, path.basename(sessionDir), "session.jsonl");
      fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
      fs.copyFileSync(filePath, outsideFile);
      const replacedPath = level === "session" ? sessionDir : projectDir;
      const discovered = fs.statSync(filePath);
      let replaced = false;
      const staleStat = {
        get mtimeMs(): number {
          if (!replaced) {
            fs.renameSync(replacedPath, `${replacedPath}.original`);
            fs.symlinkSync(outsideTarget, replacedPath, "dir");
            replaced = true;
          }
          return discovered.mtimeMs;
        },
        size: discovered.size,
      };

      expect(() => loadDeepSeekHarnessSessionFile(filePath, dshHome, staleStat))
        .toThrow("resolves outside the canonical sessions directory");
      expect(replaced).toBe(true);
    },
  );

  it.each([-1, 1.5, "1", Number.NaN])(
    "rejects an explicit invalid delegationDepth value %s",
    (delegationDepth) => {
      const homeDir = temporaryHome();
      const dshHome = path.join(homeDir, ".dsh");
      writeRawSession(dshHome, [
        header({ id: `invalid-depth-${String(delegationDepth)}`, delegationDepth }),
        { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      ]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      expect(loadDeepSeekHarnessSessions({ homeDir, deepSeekHarnessHomeDir: dshHome })).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("session header is missing or unsupported"));
    },
  );

  it("rejects negative-zero header integer fields from their raw JSON representation", () => {
    for (const field of ["createdAt", "delegationDepth", "seedLength"] as const) {
      const homeDir = temporaryHome();
      const dshHome = path.join(homeDir, ".dsh");
      const id = `negative-zero-${field}`;
      const value = header({
        id,
        createdAt: field === "createdAt" ? 0 : 1,
        ...(field === "seedLength" ? { seedLength: 0 } : {}),
      });
      const filePath = sessionPath(dshHome, value as { id: string; cwd?: string });
      const encoded = JSON.stringify(value).replace(`"${field}":0`, `"${field}":-0`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${encoded}\n${JSON.stringify({
        type: "turn/start",
        seq: 0,
        time: 1,
        data: { turn: 1 },
      })}\n`);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      expect(loadDeepSeekHarnessSessions({ homeDir, deepSeekHarnessHomeDir: dshHome })).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("session header is missing or unsupported"));
      warn.mockRestore();
    }
  });

  it("fails closed when raw and Zstandard transcripts appear anywhere in one sessions root", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    writeRawSession(
      dshHome,
      currentAndLegacyRows("raw-root-id").map((row, index) =>
        index === 0 ? header({ id: "raw-root-id", cwd: "/workspace/raw-root" }) : row),
    );
    const zstdRows = currentAndLegacyRows("zstd-root-id");
    writeZstdSession(dshHome, [
      zstdFrame(jsonl([header({ id: "zstd-root-id", cwd: "/workspace/zstd-root" })])),
      zstdFrame(jsonl(zstdRows.slice(1))),
    ], { id: "zstd-root-id", cwd: "/workspace/zstd-root" });
    const scanned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadDeepSeekHarnessSessions({
      homeDir,
      deepSeekHarnessHomeDir: dshHome,
      shouldSkipFile: (filePath) => {
        scanned.push(filePath);
        return false;
      },
    })).toEqual([]);
    expect(scanned).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("both raw and Zstandard transcripts are present"));
  });

  it("fails closed for duplicate header ids within one physical encoding", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    writeRawSession(dshHome, [
      header({ id: "duplicate-id", cwd: "/workspace/duplicate-a" }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    ]);
    writeRawSession(dshHome, [
      header({ id: "duplicate-id", cwd: "/workspace/duplicate-b" }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    ], { tail: "{malformed sibling}\n" });
    const scanned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadDeepSeekHarnessSessions({
      homeDir,
      deepSeekHarnessHomeDir: dshHome,
      shouldSkipFile: (filePath) => {
        scanned.push(filePath);
        return false;
      },
    })).toEqual([]);
    expect(scanned).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate session id \"duplicate-id\""));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("invalid DeepSeek Harness JSONL record"));
  });

  it("keeps fork lineage separate from subagent identity and titles from the first visible task", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const forkHeader = header({ id: "fork-lineage", parentSession: "seed-parent" });
    delete forkHeader.delegationDepth;
    writeRawSession(dshHome, [
      forkHeader,
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        time: 2,
        surfaceOp: "append",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "# AGENTS.md\ninjected instructions" }],
        },
      },
      {
        type: "user/message",
        seq: 2,
        time: 3,
        surfaceOp: "append",
        data: {
          source: { kind: "coordinator", form: "relay" },
          content: [{ type: "text", text: "relay should stay visible" }],
        },
      },
      {
        type: "user/message",
        seq: 3,
        time: 4,
        surfaceOp: "append",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "Human title source" }],
        },
      },
      {
        type: "assistant/message",
        seq: 4,
        time: 5,
        surfaceOp: "append",
        data: {
          turn: 1,
          content: [{ type: "text", text: "clamped usage" }],
          usage: { inputTokens: 3, outputTokens: 5, reasoningTokens: 9 },
        },
      },
      {
        type: "assistant/message",
        seq: 5,
        time: 6,
        surfaceOp: "append",
        data: {
          turn: 1,
          content: [{ type: "text", text: "invalid usage stays message-only" }],
          usage: { inputTokens: -1, outputTokens: 2 },
        },
      },
    ]);
    writeRawSession(dshHome, [
      header({ id: "descriptor-title", parentSession: "seed-parent" }),
      {
        type: "subagent/descriptor",
        seq: 0,
        time: 1,
        data: { version: 1, mode: "one-shot", provider: "fixture", label: "Unsupported label" },
      },
      {
        type: "subagent/descriptor",
        seq: 1,
        time: 2,
        data: { version: 2, mode: "one-shot", provider: "fixture", label: "Descriptor fallback title" },
      },
      {
        type: "subagent/descriptor",
        seq: 2,
        time: 3,
        data: { version: 2, mode: "one-shot", provider: "fixture", label: "Later label must not win" },
      },
      {
        type: "assistant/message",
        seq: 3,
        time: 4,
        surfaceOp: "append",
        data: {
          content: [{ type: "text", text: "descriptor session response" }],
        },
      },
    ]);

    const loaded = loadDeepSeekHarnessSessions({
      homeDir,
      deepSeekHarnessHomeDir: dshHome,
    });
    const fork = loaded.find((item) => item.session.rawId === "fork-lineage");
    const descriptor = loaded.find((item) => item.session.rawId === "descriptor-title");

    expect(fork?.session).toMatchObject({
      isSubagent: false,
      parentSessionId: "seed-parent",
      firstQuestion: "relay should stay visible",
      originalTitle: "relay should stay visible",
      tokenUsage: {
        inputTokens: 3,
        outputTokens: 0,
        reasoningOutputTokens: 5,
        totalTokens: 8,
      },
    });
    expect(fork?.messages.map((message) => message.content)).toEqual([
      "# AGENTS.md\ninjected instructions",
      "relay should stay visible",
      "Human title source",
      "clamped usage",
      "invalid usage stays message-only",
    ]);
    expect(fork?.tokenEvents).toHaveLength(1);
    expect(descriptor?.session).toMatchObject({
      isSubagent: false,
      parentSessionId: "seed-parent",
      firstQuestion: "",
      originalTitle: "Untitled Session",
    });

    writeRawSession(dshHome, [
      header({ id: "descriptor-without-label", parentSession: "seed-parent" }),
      {
        type: "subagent/descriptor",
        seq: 0,
        time: 1,
        data: { version: 2, mode: "one-shot", provider: "fixture" },
      },
      {
        type: "subagent/descriptor",
        seq: 1,
        time: 2,
        data: { version: 2, mode: "one-shot", provider: "fixture", label: "Must not rewrite identity" },
      },
      {
        type: "assistant/message",
        seq: 2,
        time: 3,
        surfaceOp: "append",
        data: { content: [{ type: "text", text: "no label response" }] },
      },
    ]);
    expect(loadDeepSeekHarnessSessions({
      homeDir,
      deepSeekHarnessHomeDir: dshHome,
    }).find((item) => item.session.rawId === "descriptor-without-label")?.session.originalTitle)
      .toBe("Untitled Session");
  });

  it("indexes only the fork-owned suffix after seedLength", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    writeRawSession(dshHome, [
      header({
        id: "fork-seed",
        parentSession: "parent-session",
        origin: "subagent",
        delegationDepth: 1,
        seedLength: 6,
      }),
      {
        type: "subagent/descriptor",
        seq: 0,
        time: 1,
        data: { version: 2, mode: "one-shot", provider: "fixture", label: "Parent descriptor" },
      },
      { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 2,
        time: 3,
        surfaceOp: "append",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "Parent prompt must not repeat" }],
        },
      },
      {
        type: "assistant/message",
        seq: 3,
        time: 4,
        surfaceOp: "append",
        data: {
          turn: 1,
          content: [{ type: "text", text: "Parent answer must not repeat" }],
          usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 10 },
        },
      },
      { type: "turn/end", seq: 4, time: 5, data: { turn: 1, reason: { kind: "completed" } } },
      { type: "session/title", seq: 5, time: 6, data: { title: "Parent title" } },
      {
        type: "subagent/descriptor",
        seq: 6,
        time: 7,
        data: { version: 2, mode: "one-shot", provider: "fixture", label: "Child descriptor" },
      },
      { type: "turn/start", seq: 7, time: 8, data: { turn: 2 } },
      {
        type: "user/message",
        seq: 8,
        time: 9,
        surfaceOp: "append",
        data: {
          source: { kind: "coordinator", form: "relay" },
          content: [{ type: "text", text: "Child task" }],
        },
      },
      {
        type: "assistant/message",
        seq: 9,
        time: 10,
        surfaceOp: "append",
        data: {
          turn: 2,
          content: [{ type: "text", text: "Child answer" }],
          usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 2 },
        },
      },
      { type: "session/title", seq: 10, time: 11, data: { title: "Child title" } },
      { type: "turn/end", seq: 11, time: 12, data: { turn: 2, reason: { kind: "completed" } } },
    ]);

    const loaded = loadDeepSeekHarnessSessions({
      homeDir,
      deepSeekHarnessHomeDir: dshHome,
    })[0];

    expect(loaded.session).toMatchObject({
      originalTitle: "Child title",
      firstQuestion: "Child task",
      parentSessionId: "parent-session",
      isSubagent: true,
      tokenUsage: {
        inputTokens: 7,
        outputTokens: 3,
        reasoningOutputTokens: 2,
        totalTokens: 12,
      },
    });
    expect(loaded.messages.map((message) => message.content)).toEqual([
      "Child task",
      "Child answer",
    ]);
    expect(loaded.tokenEvents).toEqual([
      expect.objectContaining({ dedupeKey: "dsh:9", sourceTurnId: "dsh:2" }),
    ]);
    expect((loaded.traceEvents ?? []).map((event) => event.eventType)).toEqual([
      "dsh.turn.started",
      "dsh.turn.completed",
    ]);
  });

  it.each([
    ["relative cwd", { cwd: "workspace/relative" }],
    ["NUL cwd", { cwd: "/workspace/\0invalid" }],
    ["empty parent session", { parentSession: "" }],
    ["NUL parent session", { parentSession: "parent\0invalid" }],
    ["non-string parent session", { parentSession: 7 }],
    ["unsupported origin", { origin: "fork" }],
    ["invalid seed length", { seedLength: 1.5 }],
    ["invalid agent preset", { agentPreset: 7 }],
    ["retired sandbox baseline", { sandboxMode: "workspace-write" }],
    ["retired approval baseline", { approvalPolicy: "never" }],
  ])("rejects a header with %s", (_label, override) => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const id = `invalid-header-${roots.length}`;
    writeRawSession(dshHome, [
      header({ id, ...override }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadDeepSeekHarnessSessions({ homeDir, deepSeekHarnessHomeDir: dshHome })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("session header is missing or unsupported"));
  });

  it("rejects a header id containing NUL before using it as indexed metadata", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const filePath = writeRawSession(dshHome, [
      header({ id: "invalid\0id" }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    ], { directory: "invalid-id" });

    expect(() => loadDeepSeekHarnessSessionFile(filePath, dshHome))
      .toThrow("session header is missing or unsupported");
  });

  it("validates the encoded session directory and project key while supporting _no-cwd", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    writeRawSession(dshHome, [
      header({ id: "wrong-id-path" }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    ], { directory: "not-the-encoded-header-id" });
    writeRawSession(dshHome, [
      header({ id: "wrong-project-path", cwd: "/workspace/right-project" }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    ], { project: "--wrong-project--" });
    writeRawSession(dshHome, [
      header({ id: "no-cwd", cwd: undefined }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        time: 2,
        surfaceOp: "append",
        data: { source: { kind: "user" }, content: [{ type: "text", text: "no cwd prompt" }] },
      },
    ]);
    writeRawSession(dshHome, [
      header({ id: "windows-cwd", cwd: "C:\\Users\\fixture\\repo" }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        time: 2,
        surfaceOp: "append",
        data: { source: { kind: "user" }, content: [{ type: "text", text: "windows cwd prompt" }] },
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const loaded = loadDeepSeekHarnessSessions({
      homeDir,
      deepSeekHarnessHomeDir: dshHome,
    });

    expect(loaded).toHaveLength(2);
    expect(loaded.find((item) => item.session.rawId === "no-cwd")?.session).toMatchObject({
      sessionKey: "dsh:no-cwd",
      projectPath: "",
    });
    expect(loaded.find((item) => item.session.rawId === "windows-cwd")?.session).toMatchObject({
      sessionKey: "dsh:windows-cwd",
      projectPath: "C:\\Users\\fixture\\repo",
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("header id and cwd do not match"));
  });

  it("records skipped transcript paths before parsing", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const filePath = writeRawSession(dshHome, currentAndLegacyRows("skip-before-read"));
    fs.writeFileSync(filePath, "{this would fail if read}");
    const skipped: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadDeepSeekHarnessSessions({
      homeDir,
      deepSeekHarnessHomeDir: dshHome,
      shouldSkipFile: (candidate) => candidate === filePath,
      onSkippedFile: (candidate) => skipped.push(candidate),
    })).toEqual([]);
    expect(skipped).toEqual([filePath]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("materializes verified image objects and preserves missing, corrupt, invalid, and oversized states", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const validDigest = createHash("sha256").update(PNG).digest("hex");
    writeAttachmentObject(dshHome, validDigest, PNG);
    const corruptDigest = "b".repeat(64);
    writeAttachmentObject(dshHome, corruptDigest, PNG);
    const missingDigest = "a".repeat(64);
    const rows = [
      header({ id: "attachments" }),
      { type: "turn/start", seq: 0, time: 1_787_000_000_000, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        time: 1_787_000_000_100,
        surfaceOp: "append",
        data: {
          source: { kind: "user" },
          content: [
            { type: "text", text: "inspect " },
            {
              type: "image",
              attachment: {
                attachmentId: `sha256:${validDigest}`,
                mediaType: "image/png",
                bytes: PNG.length,
                width: 1,
                height: 1,
                name: "pixel.png",
              },
            },
            { type: "text", text: "images" },
            {
              type: "image",
              attachment: {
                attachmentId: `sha256:${missingDigest}`,
                mediaType: "image/png",
                bytes: PNG.length,
                width: 1,
                height: 1,
              },
            },
            {
              type: "image",
              attachment: {
                attachmentId: `sha256:${corruptDigest}`,
                mediaType: "image/png",
                bytes: PNG.length,
                width: 1,
                height: 1,
              },
            },
            {
              type: "image",
              attachment: {
                attachmentId: `sha256:${"c".repeat(64)}`,
                mediaType: "image/png",
                bytes: MAX_ATTACHMENT_BYTES + 1,
                width: 1,
                height: 1,
              },
            },
            {
              type: "image",
              attachment: {
                attachmentId: "sha256:../../escape",
                mediaType: "image/png",
                bytes: PNG.length,
                width: 1,
                height: 1,
              },
            },
            {
              type: "image",
              attachment: {
                attachmentId: `sha256:${validDigest}`,
                mediaType: "image/png",
                bytes: PNG.length,
                height: 1,
              },
            },
            {
              type: "image",
              attachment: {
                attachmentId: `sha256:${validDigest}`,
                mediaType: "image/png",
                width: 1,
                height: 1,
              },
            },
            {
              type: "image",
              attachment: {
                attachmentId: `sha256:${validDigest}`,
                mediaType: "image/png",
                bytes: PNG.length,
                width: 1,
              },
            },
            {
              type: "image",
              attachment: {
                attachmentId: `sha256:${validDigest}`,
                mediaType: "image/png",
                bytes: PNG.length,
                width: 2,
                height: 1,
              },
            },
          ],
        },
      },
      { type: "turn/end", seq: 2, time: 1_787_000_001_000, data: { turn: 1, reason: { kind: "completed" } } },
    ];
    writeRawSession(dshHome, rows);

    const loaded = loadDeepSeekHarnessSessions({
      homeDir,
      deepSeekHarnessHomeDir: dshHome,
    })[0];
    expect(loaded.messages[0]).toMatchObject({
      content: "inspect \nimages",
      attachments: [
        {
          id: `sha256:${validDigest}`,
          fileName: "pixel.png",
          status: "available",
          sizeBytes: PNG.length,
          sha256: validDigest,
          source: { kind: "inline", value: PNG.toString("base64") },
        },
        {
          id: `sha256:${missingDigest}`,
          fileName: `${missingDigest.slice(0, 12)}.png`,
          status: "missing",
          sha256: missingDigest,
        },
        { id: `sha256:${corruptDigest}`, status: "unsafe", sha256: corruptDigest },
        { status: "too_large", sizeBytes: MAX_ATTACHMENT_BYTES + 1 },
        { id: "sha256:../../escape", status: "unsafe" },
        { id: `sha256:${validDigest}`, status: "unsafe" },
        { id: `sha256:${validDigest}`, status: "unsafe" },
        { id: `sha256:${validDigest}`, status: "unsafe" },
        { id: `sha256:${validDigest}`, status: "unsafe" },
      ],
    });
  });

  it("keeps attachment-only messages visible without using their placeholder as the session title", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const digest = "a".repeat(64);
    writeRawSession(dshHome, [
      header({ id: "attachment-only" }),
      {
        type: "user/message",
        seq: 0,
        time: 1,
        surfaceOp: "append",
        data: {
          source: { kind: "user" },
          content: [{
            type: "image",
            attachment: {
              attachmentId: `sha256:${digest}`,
              mediaType: "image/png",
              bytes: PNG.length,
              width: 1,
              height: 1,
            },
          }],
        },
      },
    ]);

    const loaded = loadDeepSeekHarnessSessionFile(
      sessionPath(dshHome, { id: "attachment-only", cwd: "/workspace/dsh" }),
      dshHome,
    );

    expect(loaded.messages[0]).toMatchObject({
      role: "user",
      content: "[Attachment]",
      attachments: [expect.objectContaining({ status: "missing" })],
    });
    expect(loaded.session.firstQuestion).toBe("");
    expect(loaded.session.originalTitle).toBe("Untitled Session");
  });

  it("reuses one verified attachment resolution for repeated references in a session", () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const digest = createHash("sha256").update(PNG).digest("hex");
    writeAttachmentObject(dshHome, digest, PNG);
    const attachmentBlock = {
      type: "image",
      attachment: {
        attachmentId: `sha256:${digest}`,
        mediaType: "image/png",
        bytes: PNG.length,
        width: 1,
        height: 1,
        name: "pixel.png",
      },
    };
    const filePath = writeRawSession(dshHome, [
      header({ id: "repeated-attachment" }),
      {
        type: "user/message",
        seq: 0,
        time: 1,
        surfaceOp: "append",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "inspect repeated image" }, attachmentBlock],
        },
      },
      {
        type: "assistant/message",
        seq: 1,
        time: 2,
        surfaceOp: "append",
        data: {
          message: {
            content: [{ type: "text", text: "same image" }, attachmentBlock],
          },
        },
      },
    ]);
    const loaded = loadDeepSeekHarnessSessionFile(filePath, dshHome);

    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages.every((message) => message.attachments?.[0]?.status === "available"))
      .toBe(true);
    expect(loaded.messages[0].attachments?.[0]).toBe(loaded.messages[1].attachments?.[0]);
  });

  it("indexes, skips, refreshes, searches, and prunes DeepSeek Harness sessions", async () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    const filePath = writeRawSession(dshHome, currentAndLegacyRows("indexed-session"));
    const store = createInMemoryStore();
    try {
      const cold = await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeDeepSeekHarness: true,
          deepSeekHarnessHomeDir: dshHome,
        },
      });
      expect(cold).toMatchObject({ indexed: 1, skipped: 0, total: 1 });
      expect(await store.searchSessions({ query: "DeepSeek Harness session", limit: 10 }))
        .toEqual([expect.objectContaining({
          sessionKey: "dsh:indexed-session",
          source: "deepseek-harness",
        })]);

      const warm = await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeDeepSeekHarness: true,
          deepSeekHarnessHomeDir: dshHome,
        },
      });
      expect(warm).toMatchObject({ indexed: 0, skipped: 1, total: 1 });

      fs.appendFileSync(filePath, jsonl([{
        type: "assistant/message",
        seq: 15,
        time: Date.parse("2026-08-17T01:00:05.000Z"),
        surfaceOp: "append",
        data: {
          turn: 2,
          step: 1,
          message: {
            role: "assistant",
            id: "new-answer",
            source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
            content: [{ type: "text", text: "fresh appended answer" }],
          },
        },
      }]));
      const changed = await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeDeepSeekHarness: true,
          deepSeekHarnessHomeDir: dshHome,
        },
      });
      expect(changed).toMatchObject({ indexed: 1, skipped: 0, total: 1 });
      expect(await store.searchSessions({ query: "fresh appended answer", limit: 10 })).toHaveLength(1);

      fs.unlinkSync(filePath);
      await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeDeepSeekHarness: true,
          deepSeekHarnessHomeDir: dshHome,
        },
      });
      expect(await store.getSession("dsh:indexed-session")).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("prunes a warm-indexed session when a duplicate id makes the root ambiguous", async () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    writeRawSession(dshHome, [
      header({ id: "warm-duplicate", cwd: "/workspace/duplicate-a" }),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        time: 2,
        surfaceOp: "append",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "cached duplicate session" }],
        },
      },
    ]);
    const store = createInMemoryStore();
    const shouldSkipFile = vi.fn(() => false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeDeepSeekHarness: true,
          deepSeekHarnessHomeDir: dshHome,
          shouldSkipFile,
        },
      });
      expect(await store.getSession("dsh:warm-duplicate")).not.toBeNull();
      shouldSkipFile.mockClear();

      writeRawSession(dshHome, [
        header({ id: "warm-duplicate", cwd: "/workspace/duplicate-b" }),
        { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      ]);
      const ambiguous = await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeDeepSeekHarness: true,
          deepSeekHarnessHomeDir: dshHome,
          shouldSkipFile,
        },
      });

      expect(ambiguous).toMatchObject({ indexed: 0, skipped: 0, total: 0 });
      expect(shouldSkipFile).not.toHaveBeenCalled();
      expect(await store.getSession("dsh:warm-duplicate")).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate session id \"warm-duplicate\""));
    } finally {
      await store.close();
    }
  });

  it("prunes a warm-indexed session when mixed encodings make the root ambiguous", async () => {
    const homeDir = temporaryHome();
    const dshHome = path.join(homeDir, ".dsh");
    writeRawSession(dshHome, currentAndLegacyRows("warm-mixed-raw"));
    const store = createInMemoryStore();
    const shouldSkipFile = vi.fn(() => false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeDeepSeekHarness: true,
          deepSeekHarnessHomeDir: dshHome,
          shouldSkipFile,
        },
      });
      expect(await store.getSession("dsh:warm-mixed-raw")).not.toBeNull();
      shouldSkipFile.mockClear();

      const zstdRows = currentAndLegacyRows("warm-mixed-zstd");
      writeZstdSession(dshHome, [
        zstdFrame(jsonl([zstdRows[0]])),
        zstdFrame(jsonl(zstdRows.slice(1))),
      ], { id: "warm-mixed-zstd" });
      const ambiguous = await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeDeepSeekHarness: true,
          deepSeekHarnessHomeDir: dshHome,
          shouldSkipFile,
        },
      });

      expect(ambiguous).toMatchObject({ indexed: 0, skipped: 0, total: 0 });
      expect(shouldSkipFile).not.toHaveBeenCalled();
      expect(await store.getSession("dsh:warm-mixed-raw")).toBeNull();
      expect(await store.getSession("dsh:warm-mixed-zstd")).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("both raw and Zstandard transcripts are present"));
    } finally {
      await store.close();
    }
  });
});
