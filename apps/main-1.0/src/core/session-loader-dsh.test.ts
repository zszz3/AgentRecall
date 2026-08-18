import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "./session-attachments";
import {
  loadDefaultSessions,
  resolveDeepSeekHarnessHome,
} from "./session-loader";

const temporaryRoots: string[] = [];
const originalDshHome = process.env.DSH_HOME;
const require = createRequire(import.meta.url);

beforeEach(() => {
  process.env.DSH_HOME = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalDshHome;
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-dsh-"));
  temporaryRoots.push(home);
  return home;
}

function dshHome(homeDir: string): string {
  return path.join(homeDir, ".dsh");
}

function transcriptPath(
  homeDir: string,
  id: string,
  projectDirectory = "--repo--",
  fileName: "session.jsonl" | "session.jsonl.zstd" = "session.jsonl",
): string {
  return path.join(dshHome(homeDir), "sessions", projectDirectory, id, fileName);
}

function writeRaw(filePath: string, rows: unknown[], tail = ""): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${tail}`);
}

function zstdFrame(text: string): Buffer {
  return zstdCompressSync(text, {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  });
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
    try {
      const candidate = frame.subarray(0, end);
      const decoded = zstdDecompressSync(candidate, {
        finishFlush: constants.ZSTD_e_flush,
      }).toString("utf8");
      if (accepts(decoded)) return candidate;
    } catch {
      // Keep searching for a cut that exposes a useful decompressed prefix.
    }
  }
  throw new Error("test fixture could not produce a recoverable torn Zstandard frame");
}

function writeZstd(filePath: string, frames: Buffer[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat(frames));
}

function header(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "session",
    version: 0,
    id,
    createdAt: Date.parse("2026-08-01T00:00:00.000Z"),
    cwd: "/repo",
    delegationDepth: 0,
    ...overrides,
  };
}

function humanMessage(seq: number, text: string): Record<string, unknown> {
  return {
    type: "user/message",
    seq,
    time: Date.parse("2026-08-01T00:00:01.000Z") + seq,
    data: {
      id: `user-${seq}`,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
    },
    surfaceOp: "append",
  };
}

function loadDsh(homeDir: string) {
  return loadDefaultSessions({
    homeDir,
    includeDeepSeekHarness: true,
    deepSeekHarnessHomeDir: dshHome(homeDir),
  }).filter((item) => item.session.source === "deepseek-harness");
}

describe("DeepSeek Harness session loading", () => {
  it("is opt-in and parses current plus legacy v0 messages, titles, tools, usage, and attachments", () => {
    const homeDir = temporaryHome();
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const imageHash = createHash("sha256").update(image).digest("hex");
    const objectPath = path.join(
      dshHome(homeDir),
      "attachments",
      "v1",
      "objects",
      imageHash.slice(0, 2),
      imageHash,
    );
    fs.mkdirSync(path.dirname(objectPath), { recursive: true });
    fs.writeFileSync(objectPath, image);
    const filePath = transcriptPath(homeDir, "session-current-legacy");
    writeRaw(filePath, [
      header("session-current-legacy"),
      {
        type: "user/message",
        seq: 0,
        time: Date.parse("2026-08-01T00:00:01.000Z"),
        data: {
          role: "user",
          content: [{ type: "text", text: "injected plugin context" }],
          source: { kind: "plugin", plugin: "fixture" },
        },
        surfaceOp: "append",
      },
      {
        type: "user/message",
        seq: 1,
        time: Date.parse("2026-08-01T00:00:02.000Z"),
        data: {
          id: "user-1",
          role: "user",
          turn: 1,
          content: [
            { type: "text", text: "Searchable DSH question" },
            {
              type: "image",
              attachment: {
                attachmentId: `sha256:${imageHash}`,
                mediaType: "image/png",
                bytes: image.length,
                width: 1,
                height: 1,
                name: "C:\\private\\shot.png",
              },
            },
          ],
          source: { kind: "user" },
        },
        surfaceOp: "append",
      },
      {
        type: "session/title",
        seq: 2,
        time: Date.parse("2026-08-01T00:00:03.000Z"),
        data: { title: "Old DSH title", messageSeqs: [1], source: { kind: "fallback" } },
      },
      {
        type: "assistant/message",
        seq: 3,
        time: Date.parse("2026-08-01T00:00:04.000Z"),
        data: {
          turn: 1,
          step: 1,
          content: [
            { type: "reasoning", text: "hidden reasoning" },
            { type: "text", text: "Legacy answer" },
          ],
          provenance: { provider: "fixture", model: "legacy" },
          usage: {
            inputTokens: 100,
            outputTokens: 40,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            reasoningTokens: 15,
          },
        },
        surfaceOp: "append",
      },
      {
        type: "tool/call",
        seq: 4,
        time: Date.parse("2026-08-01T00:00:05.000Z"),
        data: {
          turn: 1,
          step: 1,
          callId: "call-current",
          name: "read",
          arguments: JSON.stringify({
            path: "preferred/path.ts",
            file_path: "fallback/path.ts",
          }),
        },
      },
      {
        type: "tool/result",
        seq: 5,
        time: Date.parse("2026-08-01T00:00:06.000Z"),
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "tool-current",
            role: "user",
            source: { kind: "tool", callId: "call-current" },
            content: [{
              type: "tool-result",
              toolCallId: "call-current",
              content: [{ type: "text", text: "current result" }],
              isError: false,
            }],
          },
        },
        surfaceOp: "append",
      },
      {
        type: "assistant/message",
        seq: 6,
        time: Date.parse("2026-08-01T00:00:07.000Z"),
        data: {
          content: [{ type: "text", text: "Replaced duplicate" }],
          provenance: { provider: "fixture", model: "legacy" },
          usage: { inputTokens: 999, outputTokens: 999 },
        },
        surfaceOp: { op: "replace", start: 3 },
      },
      {
        type: "assistant/message",
        seq: 7,
        time: Date.parse("2026-08-01T00:00:08.000Z"),
        data: {
          turn: 1,
          step: 2,
          message: {
            id: "assistant-current",
            role: "assistant",
            content: [
              { type: "reasoning", text: "also hidden" },
              { type: "text", text: "Current answer" },
              { type: "tool-call", id: "hidden-call", name: "bash", arguments: "{}" },
            ],
            source: { kind: "model", provider: "fixture", model: "current" },
          },
          usage: {
            inputTokens: 50,
            outputTokens: 20,
            cacheReadTokens: 4,
            cacheWriteTokens: 1,
            reasoningTokens: 5,
          },
        },
        surfaceOp: "append",
      },
      {
        type: "tool/call",
        seq: 8,
        time: Date.parse("2026-08-01T00:00:09.000Z"),
        data: {
          turn: 1,
          step: 2,
          callId: "call-legacy-result",
          name: "bash",
          arguments: "{\"command\":\"pwd\"}",
        },
      },
      {
        type: "tool/result",
        seq: 9,
        time: Date.parse("2026-08-01T00:00:10.000Z"),
        data: {
          turn: 1,
          step: 2,
          callId: "call-legacy-result",
          content: [{ type: "text", text: "legacy result" }],
          isError: true,
        },
        surfaceOp: "append",
      },
      {
        type: "session/title",
        seq: 10,
        time: Date.parse("2026-08-01T00:00:11.000Z"),
        data: { title: "Latest DSH title", messageSeqs: [1], source: { kind: "user" } },
      },
      {
        type: "text-chunks",
        seq0: 11,
        time0: 1,
        data: {
          turn: 1,
          step: 3,
          index: 0,
          dt: [],
          texts: ["not visible"],
        },
      },
      {
        type: "future/event",
        seq: 12,
        time: 2,
        data: { ignored: true },
        ignorable: true,
      },
    ], "{unfinished");

    expect(loadDefaultSessions({
      homeDir,
      deepSeekHarnessHomeDir: dshHome(homeDir),
    }).some((item) => item.session.source === "deepseek-harness")).toBe(false);

    const [loaded] = loadDsh(homeDir);
    expect(loaded.session).toMatchObject({
      sessionKey: "dsh:session-current-legacy",
      rawId: "session-current-legacy",
      source: "deepseek-harness",
      projectPath: "/repo",
      originalTitle: "Latest DSH title",
      firstQuestion: "Searchable DSH question",
      timestamp: Date.parse("2026-08-01T00:00:00.000Z"),
      isSubagent: false,
      parentSessionId: null,
      tokenUsage: {
        inputTokens: 150,
        outputTokens: 40,
        cachedInputTokens: 14,
        cacheCreationInputTokens: 6,
        reasoningOutputTokens: 20,
        totalTokens: 230,
      },
    });
    expect(loaded.messages.map((message) => message.content)).toEqual([
      "Searchable DSH question",
      "Legacy answer",
      "Current answer",
    ]);
    expect(loaded.messages.map((message) => message.sourceTurnId)).toEqual([
      "dsh:1",
      "dsh:1",
      "dsh:1",
    ]);
    expect(loaded.messages[0].attachments).toEqual([
      expect.objectContaining({
        id: `sha256:${imageHash}`,
        fileName: "shot.png",
        mimeType: "image/png",
        sizeBytes: image.length,
        sha256: imageHash,
        status: "available",
        source: { kind: "inline", value: image.toString("base64") },
      }),
    ]);
    expect(loaded.tokenEvents).toEqual([
      expect.objectContaining({
        dedupeKey: "dsh:3",
        sourceTurnId: "dsh:1",
        reasoningOutputTokens: 15,
        outputTokens: 25,
      }),
      expect.objectContaining({
        dedupeKey: "dsh:7",
        sourceTurnId: "dsh:1",
        reasoningOutputTokens: 5,
        outputTokens: 15,
      }),
    ]);
    expect(loaded.traceEvents).toMatchObject([
      {
        kind: "tool_call",
        source: "dsh",
        title: "read · preferred/path.ts",
        detail: [
          "{",
          '  "path": "preferred/path.ts",',
          '  "file_path": "fallback/path.ts"',
          "}",
        ].join("\n"),
        callId: "call-current",
        eventType: "dsh.tool.call",
        status: "running",
        sourceTurnId: "dsh:1",
        attributes: {
          input: {
            path: "preferred/path.ts",
            file_path: "fallback/path.ts",
          },
        },
      },
      {
        kind: "tool_result",
        source: "dsh",
        title: "read · result",
        detail: "current result",
        callId: "call-current",
        eventType: "dsh.tool.result",
        status: "completed",
        sourceTurnId: "dsh:1",
      },
      {
        kind: "tool_call",
        source: "dsh",
        title: "bash · pwd",
        callId: "call-legacy-result",
        eventType: "dsh.tool.call",
        status: "running",
        sourceTurnId: "dsh:1",
      },
      {
        kind: "tool_result",
        source: "dsh",
        title: "bash · result",
        detail: "legacy result",
        callId: "call-legacy-result",
        eventType: "dsh.tool.result",
        status: "failed",
        sourceTurnId: "dsh:1",
      },
    ]);
  });

  it("decodes complete Zstandard frames and recovers a final frame torn in its checksum", () => {
    const homeDir = temporaryHome();
    const filePath = transcriptPath(
      homeDir,
      "multi-frame",
      "--repo--",
      "session.jsonl.zstd",
    );
    const tornTitle = zstdFrame(`${JSON.stringify({
      type: "session/title",
      seq: 2,
      time: 4,
      data: { title: "Torn title", messageSeqs: [0], source: { kind: "fallback" } },
    })}\n`);
    writeZstd(filePath, [
      zstdFrame(`${JSON.stringify(header("multi-frame"))}\n`),
      zstdFrame(`${JSON.stringify(humanMessage(0, "Question from second frame"))}\n`),
      zstdFrame(`${JSON.stringify({
        type: "assistant/message",
        seq: 1,
        time: Date.parse("2026-08-01T00:00:03.000Z"),
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "assistant-frame-3",
            role: "assistant",
            content: [{ type: "text", text: "Answer from third frame" }],
            source: { kind: "model", provider: "fixture", model: "fixture" },
          },
        },
        surfaceOp: "append",
      })}\n`),
      tornTitle.subarray(0, tornTitle.length - 2),
    ]);

    const [loaded] = loadDsh(homeDir);
    expect(loaded.messages.map((message) => message.content)).toEqual([
      "Question from second frame",
      "Answer from third frame",
    ]);
    expect(loaded.session.originalTitle).toBe("Torn title");
  });

  it("rejects complete Zstandard frames that violate committed JSONL boundaries", () => {
    const homeDir = temporaryHome();
    const splitRecord = JSON.stringify(humanMessage(0, "Valid framed content"));
    const splitAt = Math.floor(splitRecord.length / 2);
    writeZstd(
      transcriptPath(homeDir, "valid-framed", "--repo--", "session.jsonl.zstd"),
      [
        zstdFrame(`${JSON.stringify(header("valid-framed"))}\n`),
        zstdFrame(splitRecord.slice(0, splitAt)),
        zstdFrame(`${splitRecord.slice(splitAt)}\n`),
      ],
    );
    writeZstd(
      transcriptPath(homeDir, "unterminated-frame", "--repo--", "session.jsonl.zstd"),
      [
        zstdFrame(`${JSON.stringify(header("unterminated-frame"))}\n`),
        zstdFrame(JSON.stringify(humanMessage(0, "must not be accepted"))),
      ],
    );
    writeZstd(
      transcriptPath(homeDir, "combined-header-frame", "--repo--", "session.jsonl.zstd"),
      [zstdFrame([
        JSON.stringify(header("combined-header-frame")),
        JSON.stringify(humanMessage(0, "must not share the header frame")),
        "",
      ].join("\n"))],
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadDsh(homeDir).map((item) => item.session.rawId)).toEqual(["valid-framed"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unterminated-frame"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("combined-header-frame"));
    expect(warn.mock.calls.flat().join("\n")).not.toContain("must not");
  });

  it("keeps complete JSONL records from a payload-torn Zstandard frame without rewriting the source", () => {
    const homeDir = temporaryHome();
    const filePath = transcriptPath(
      homeDir,
      "torn-payload",
      "--repo--",
      "session.jsonl.zstd",
    );
    const complete = JSON.stringify(humanMessage(0, "Recovered complete record"));
    const partial = JSON.stringify({
      type: "assistant/message",
      seq: 1,
      time: 2,
      data: {
        content: [{ type: "text", text: deterministicNoise(300_000) }],
      },
      surfaceOp: "append",
    });
    const torn = tornZstdFrame(`${complete}\n${partial}\n`, (decoded) =>
      decoded.startsWith(`${complete}\n`)
      && decoded.length > complete.length + 1
      && !decoded.endsWith("\n"));
    writeZstd(filePath, [
      zstdFrame(`${JSON.stringify(header("torn-payload"))}\n`),
      torn,
    ]);
    const sourceBefore = fs.readFileSync(filePath);

    const [loaded] = loadDsh(homeDir);

    expect(loaded.messages.map((message) => message.content)).toEqual([
      "Recovered complete record",
    ]);
    expect(fs.readFileSync(filePath)).toEqual(sourceBefore);
  });

  it("isolates malformed raw siblings while preserving a valid raw tail", () => {
    const homeDir = temporaryHome();
    writeRaw(
      transcriptPath(homeDir, "valid-tail"),
      [header("valid-tail"), humanMessage(0, "Valid tail session")],
      "{partial",
    );
    const malformedPath = transcriptPath(homeDir, "malformed-middle");
    fs.mkdirSync(path.dirname(malformedPath), { recursive: true });
    fs.writeFileSync(malformedPath, [
      JSON.stringify(header("malformed-middle")),
      "{malformed",
      JSON.stringify(humanMessage(0, "must not be recovered")),
      "",
    ].join("\n"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const loaded = loadDsh(homeDir);

    expect(loaded.map((item) => item.session.sessionKey)).toEqual(["dsh:valid-tail"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed-middle"));
    expect(warn.mock.calls.flat().join("\n")).not.toContain("must not be recovered");
  });

  it("rejects committed empty or whitespace-only JSONL records", () => {
    const homeDir = temporaryHome();
    for (const [id, blank] of [
      ["empty-record", ""],
      ["whitespace-record", " \t "],
    ] as const) {
      const filePath = transcriptPath(homeDir, id);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [
        JSON.stringify(header(id)),
        blank,
        JSON.stringify(humanMessage(0, "must not be indexed")),
        "",
      ].join("\n"));
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadDsh(homeDir)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("empty-record"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("whitespace-record"));
    expect(warn.mock.calls.flat().join("\n")).not.toContain("must not be indexed");
  });

  it("isolates a corrupt compressed sibling within a compressed-only root", () => {
    const homeDir = temporaryHome();
    writeZstd(
      transcriptPath(homeDir, "valid-zstd", "--repo--", "session.jsonl.zstd"),
      [
        zstdFrame(`${JSON.stringify(header("valid-zstd"))}\n`),
        zstdFrame(`${JSON.stringify(humanMessage(0, "Valid compressed session"))}\n`),
      ],
    );
    const corruptFrame = zstdFrame(`${JSON.stringify(header("corrupt-zstd"))}\n`);
    corruptFrame[corruptFrame.length - 1] ^= 0xff;
    writeZstd(
      transcriptPath(homeDir, "corrupt-zstd", "--repo--", "session.jsonl.zstd"),
      [corruptFrame],
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadDsh(homeDir).map((item) => item.session.sessionKey)).toEqual(["dsh:valid-zstd"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupt-zstd"));
    expect(warn.mock.calls.flat().join("\n")).not.toContain("Valid compressed session");
  });

  it("fails the entire root closed when different session directories mix raw and compressed encodings", () => {
    const homeDir = temporaryHome();
    const rawPath = transcriptPath(homeDir, "raw-session");
    const compressedPath = transcriptPath(
      homeDir,
      "compressed-session",
      "--repo--",
      "session.jsonl.zstd",
    );
    writeRaw(rawPath, [header("raw-session"), humanMessage(0, "secret raw content")]);
    writeZstd(
      compressedPath,
      [zstdFrame([
        JSON.stringify(header("compressed-session")),
        JSON.stringify(humanMessage(0, "secret compressed content")),
        "",
      ].join("\n"))],
    );
    const scanned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const loaded = loadDefaultSessions({
      homeDir,
      includeDeepSeekHarness: true,
      deepSeekHarnessHomeDir: dshHome(homeDir),
      shouldSkipFile: (filePath) => {
        scanned.push(filePath);
        return false;
      },
    }).filter((item) => item.session.source === "deepseek-harness");

    expect(loaded).toEqual([]);
    expect(scanned).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(rawPath));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(compressedPath));
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/secret (raw|compressed) content/u);
  });

  it("fails duplicate ids closed without blocking valid same-encoding siblings", () => {
    const homeDir = temporaryHome();
    writeRaw(
      transcriptPath(homeDir, "duplicate", "--repo-a--"),
      [header("duplicate", { cwd: "/repo-a" }), humanMessage(0, "duplicate A")],
    );
    writeRaw(
      transcriptPath(homeDir, "duplicate", "--repo-b--"),
      [header("duplicate", { cwd: "/repo-b" }), humanMessage(0, "duplicate B")],
    );
    writeRaw(
      transcriptPath(homeDir, "valid"),
      [header("valid"), humanMessage(0, "valid sibling")],
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadDsh(homeDir).map((item) => item.session.sessionKey)).toEqual(["dsh:valid"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate session id"));
  });

  it("keeps fork lineage without misclassifying ordinary forks as subagents", () => {
    const homeDir = temporaryHome();
    writeRaw(
      transcriptPath(homeDir, "fork-session"),
      [
        header("fork-session", {
          parentSession: "parent-session",
          delegationDepth: 0,
        }),
        humanMessage(0, "Forked task"),
      ],
    );

    const [loaded] = loadDsh(homeDir);
    expect(loaded.session).toMatchObject({
      isSubagent: false,
      parentSessionId: "parent-session",
    });
  });

  it("classifies subagents from explicit origin or positive delegation depth", () => {
    const homeDir = temporaryHome();
    writeRaw(
      transcriptPath(homeDir, "origin-child", "_no-cwd"),
      [
        header("origin-child", {
          cwd: undefined,
          parentSession: "parent-session",
          origin: "subagent",
          delegationDepth: 0,
        }),
        humanMessage(0, "Origin subagent task"),
      ],
    );
    writeRaw(
      transcriptPath(homeDir, "depth-child"),
      [
        header("depth-child", {
          parentSession: "parent-session",
          delegationDepth: 2,
        }),
        humanMessage(0, "Depth subagent task"),
      ],
    );

    const loaded = loadDsh(homeDir);
    expect(loaded.map((item) => ({
      rawId: item.session.rawId,
      projectPath: item.session.projectPath,
      isSubagent: item.session.isSubagent,
      parentSessionId: item.session.parentSessionId,
    }))).toEqual([
      {
        rawId: "origin-child",
        projectPath: "",
        isSubagent: true,
        parentSessionId: "parent-session",
      },
      {
        rawId: "depth-child",
        projectPath: "/repo",
        isSubagent: true,
        parentSessionId: "parent-session",
      },
    ]);
  });

  it("keeps coordinator relay follow-ups visible and falls back to a valid subagent label for the title", () => {
    const homeDir = temporaryHome();
    writeRaw(transcriptPath(homeDir, "continuable-child"), [
      header("continuable-child", {
        parentSession: "parent-session",
        origin: "subagent",
        delegationDepth: 1,
      }),
      {
        type: "subagent/descriptor",
        seq: 0,
        time: 1,
        data: {
          version: 2,
          mode: "continuable",
          provider: "fixture",
          label: "Investigate the parser",
        },
      },
      {
        type: "user/message",
        seq: 1,
        time: 2,
        data: {
          role: "user",
          source: {
            kind: "coordinator",
            form: "relay",
            senderSessionId: "parent-session",
          },
          content: [{ type: "text", text: "Please check the remaining edge case" }],
        },
        surfaceOp: "append",
      },
      {
        type: "user/message",
        seq: 2,
        time: 3,
        data: {
          role: "user",
          source: { kind: "plugin", plugin: "fixture" },
          content: [{ type: "text", text: "injected plugin context" }],
        },
        surfaceOp: "append",
      },
    ]);

    const [loaded] = loadDsh(homeDir);
    expect(loaded.session).toMatchObject({
      originalTitle: "Please check the remaining edge case",
      firstQuestion: "Please check the remaining edge case",
    });
    expect(loaded.messages.map((message) => message.content)).toEqual([
      "Please check the remaining edge case",
    ]);

    writeRaw(transcriptPath(homeDir, "descriptor-valid"), [
      header("descriptor-valid", {
        parentSession: "parent-session",
        origin: "subagent",
        delegationDepth: 1,
      }),
      {
        type: "subagent/descriptor",
        seq: 0,
        time: 1,
        data: {
          version: 2,
          mode: "one-shot",
          provider: "fixture",
          label: "Summarize the findings",
        },
      },
      {
        type: "assistant/message",
        seq: 1,
        time: 2,
        data: {
          content: [{ type: "text", text: "Summary complete" }],
        },
        surfaceOp: "append",
      },
    ]);

    expect(loadDsh(homeDir).find((item) => item.session.rawId === "descriptor-valid")?.session)
      .toMatchObject({
        originalTitle: "Summarize the findings",
        firstQuestion: "",
      });

    const authoritativeCases = [
      {
        id: "descriptor-malformed-authoritative",
        first: {
          version: 2,
          mode: "continuable",
          provider: "fixture",
          label: "Malformed first label",
          toolFilter: {},
        },
      },
      {
        id: "descriptor-unsupported-authoritative",
        first: {
          version: 1,
          mode: "one-shot",
          provider: "fixture",
          label: "Unsupported first label",
        },
      },
      {
        id: "descriptor-empty-authoritative",
        first: {
          version: 2,
          mode: "one-shot",
          provider: "fixture",
        },
      },
    ];
    for (const { id, first } of authoritativeCases) {
      writeRaw(transcriptPath(homeDir, id), [
        header(id, {
          parentSession: "parent-session",
          origin: "subagent",
          delegationDepth: 1,
        }),
        {
          type: "subagent/descriptor",
          seq: 0,
          time: 1,
          data: first,
        },
        {
          type: "subagent/descriptor",
          seq: 1,
          time: 2,
          data: {
            version: 2,
            mode: "one-shot",
            provider: "fixture",
            label: "Must not override the first descriptor event",
          },
        },
        {
          type: "assistant/message",
          seq: 2,
          time: 3,
          data: {
            content: [{ type: "text", text: "No user prompt" }],
          },
          surfaceOp: "append",
        },
      ]);
    }

    const afterAuthoritativeCases = loadDsh(homeDir);
    for (const { id } of authoritativeCases) {
      expect(afterAuthoritativeCases
        .find((item) => item.session.rawId === id)?.session.originalTitle)
        .toBe("Untitled Session");
    }
  });

  it("filters inherited fork events at seedLength before deriving content, title, usage, and traces", () => {
    const homeDir = temporaryHome();
    writeRaw(transcriptPath(homeDir, "forked-child"), [
      header("forked-child", {
        parentSession: "parent-session",
        origin: "subagent",
        delegationDepth: 1,
        seedLength: 4,
      }),
      humanMessage(0, "Parent prompt must not be indexed in child"),
      {
        type: "session/title",
        seq: 1,
        time: 2,
        data: { title: "Parent title", source: { kind: "user" } },
      },
      {
        type: "assistant/message",
        seq: 2,
        time: 3,
        data: {
          content: [{ type: "text", text: "Parent answer must not be indexed" }],
          usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 10 },
        },
        surfaceOp: "append",
      },
      {
        type: "tool/call",
        seq: 3,
        time: 4,
        data: {
          turn: 1,
          step: 1,
          callId: "parent-call",
          name: "read",
          arguments: "{\"path\":\"parent-secret\"}",
        },
      },
      {
        type: "subagent/descriptor",
        seq: 4,
        time: 5,
        data: {
          version: 2,
          mode: "continuable",
          provider: "fixture",
          label: "Child descriptor",
        },
      },
      {
        type: "user/message",
        seq: 5,
        time: 6,
        data: {
          role: "user",
          source: {
            kind: "coordinator",
            form: "relay",
            senderSessionId: "parent-session",
          },
          content: [{ type: "text", text: "Child follow-up" }],
        },
        surfaceOp: "append",
      },
      {
        type: "session/title",
        seq: 6,
        time: 7,
        data: { title: "Child title", source: { kind: "user" } },
      },
      {
        type: "assistant/message",
        seq: 7,
        time: 8,
        data: {
          turn: 2,
          content: [{ type: "text", text: "Child answer" }],
          usage: {
            inputTokens: 10,
            outputTokens: 6,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            reasoningTokens: 2,
          },
        },
        surfaceOp: "append",
      },
      {
        type: "tool/call",
        seq: 8,
        time: 9,
        data: {
          turn: 2,
          step: 1,
          callId: "child-call",
          name: "read",
          arguments: "{\"path\":\"child-visible\"}",
        },
      },
      {
        type: "tool/result",
        seq: 9,
        time: 10,
        data: {
          turn: 2,
          step: 1,
          callId: "child-call",
          content: [{ type: "text", text: "child result" }],
          isError: false,
        },
        surfaceOp: "append",
      },
    ]);

    const [loaded] = loadDsh(homeDir);
    expect(loaded.session).toMatchObject({
      originalTitle: "Child title",
      firstQuestion: "Child follow-up",
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 1,
        reasoningOutputTokens: 2,
        totalTokens: 19,
      },
    });
    expect(loaded.messages.map((message) => message.content)).toEqual([
      "Child follow-up",
      "Child answer",
    ]);
    expect(loaded.tokenEvents).toEqual([
      expect.objectContaining({
        dedupeKey: "dsh:7",
        inputTokens: 10,
        outputTokens: 4,
        reasoningOutputTokens: 2,
      }),
    ]);
    expect((loaded.traceEvents ?? []).map((event) => ({
      title: event.title,
      callId: event.callId,
      eventType: event.eventType,
    }))).toEqual([
      { title: "read · child-visible", callId: "child-call", eventType: "dsh.tool.call" },
      { title: "read · result", callId: "child-call", eventType: "dsh.tool.result" },
    ]);
    expect(JSON.stringify(loaded)).not.toMatch(/Parent prompt|Parent answer|Parent title|parent-secret/u);
  });

  it("drops explicitly invalid usage while clamping reasoning tokens to output", () => {
    const homeDir = temporaryHome();
    writeRaw(transcriptPath(homeDir, "usage-validation"), [
      header("usage-validation"),
      humanMessage(0, "Usage validation"),
      {
        type: "assistant/message",
        seq: 1,
        time: 2,
        data: {
          content: [{ type: "text", text: "Message with invalid usage stays visible" }],
          usage: { inputTokens: -1, outputTokens: 20 },
        },
        surfaceOp: "append",
      },
      {
        type: "assistant/message",
        seq: 2,
        time: 3,
        data: {
          turn: 1,
          content: [{ type: "text", text: "Message with clamped reasoning" }],
          usage: {
            inputTokens: 3,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            reasoningTokens: 99,
          },
        },
        surfaceOp: "append",
      },
    ]);

    const [loaded] = loadDsh(homeDir);
    expect(loaded.messages.map((message) => message.content)).toEqual([
      "Usage validation",
      "Message with invalid usage stays visible",
      "Message with clamped reasoning",
    ]);
    expect(loaded.tokenEvents).toEqual([
      expect.objectContaining({
        dedupeKey: "dsh:2",
        inputTokens: 3,
        outputTokens: 0,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 1,
        reasoningOutputTokens: 5,
        totalTokens: 11,
      }),
    ]);
  });

  it("validates packed row shape and the complete event sequence before indexing", () => {
    const homeDir = temporaryHome();
    writeRaw(transcriptPath(homeDir, "valid-packed"), [
      header("valid-packed"),
      humanMessage(0, "Visible before packed chunks"),
      {
        type: "text-chunks",
        seq0: 1,
        time0: 2,
        data: {
          turn: 1,
          step: 1,
          index: 0,
          dt: [1],
          texts: ["hidden", " deltas"],
        },
      },
      {
        type: "assistant/message",
        seq: 3,
        time: 4,
        data: { content: [{ type: "text", text: "Visible after packed chunks" }] },
        surfaceOp: "append",
      },
    ]);
    writeRaw(
      transcriptPath(homeDir, "sequence-gap"),
      [header("sequence-gap"), humanMessage(1, "private gap payload")],
    );
    writeRaw(transcriptPath(homeDir, "sequence-duplicate"), [
      header("sequence-duplicate"),
      humanMessage(0, "first"),
      {
        type: "assistant/message",
        seq: 0,
        time: 2,
        data: { content: [{ type: "text", text: "private duplicate payload" }] },
        surfaceOp: "append",
      },
    ]);
    writeRaw(transcriptPath(homeDir, "malformed-packed"), [
      header("malformed-packed"),
      {
        type: "text-chunks",
        seq0: 0,
        time0: 1,
        data: {
          turn: 1,
          step: 1,
          index: 0,
          dt: [],
          texts: ["one", "two"],
        },
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const loaded = loadDsh(homeDir);

    expect(loaded.map((item) => item.session.rawId)).toEqual(["valid-packed"]);
    expect(loaded[0].messages.map((message) => message.content)).toEqual([
      "Visible before packed chunks",
      "Visible after packed chunks",
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sequence-gap"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sequence-duplicate"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed-packed"));
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/private (gap|duplicate) payload/u);
  });

  it("always discards a final raw JSON record without a terminating newline", () => {
    const homeDir = temporaryHome();
    const filePath = transcriptPath(homeDir, "unterminated-valid-record");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify(header("unterminated-valid-record")),
      JSON.stringify(humanMessage(0, "Stable title")),
      JSON.stringify({
        type: "session/title",
        seq: 1,
        time: 2,
        data: { title: "Must be discarded", source: { kind: "user" } },
      }),
    ].join("\n"));

    const [loaded] = loadDsh(homeDir);
    expect(loaded.session.originalTitle).toBe("Stable title");
  });

  it("retries a transcript read when the source changes between stat calls", () => {
    const homeDir = temporaryHome();
    const filePath = transcriptPath(homeDir, "stable-read");
    writeRaw(filePath, [
      header("stable-read"),
      humanMessage(0, "Question before concurrent append"),
    ]);
    const mutableFs = require("node:fs") as typeof import("node:fs");
    const originalReadFileSync = mutableFs.readFileSync;
    let reads = 0;
    mutableFs.readFileSync = ((
      target: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      const result = (originalReadFileSync as (...input: unknown[]) => unknown)(target, ...args);
      if (typeof target === "number" && reads++ === 0) {
        fs.appendFileSync(filePath, `${JSON.stringify({
          type: "assistant/message",
          seq: 1,
          time: 2,
          data: {
            content: [{ type: "text", text: "Answer appended during the first read" }],
          },
          surfaceOp: "append",
        })}\n`);
      }
      return result;
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      const [loaded] = loadDsh(homeDir);

      expect(reads).toBe(2);
      expect(loaded.messages.map((message) => message.content)).toEqual([
        "Question before concurrent append",
        "Answer appended during the first read",
      ]);
      expect(loaded.session.fileSize).toBe(fs.statSync(filePath).size);
    } finally {
      mutableFs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
    }
  });

  it.skipIf(process.platform === "win32")("does not read a transcript replaced by a symlink after discovery", () => {
    const homeDir = temporaryHome();
    const filePath = transcriptPath(homeDir, "symlink-swap");
    const outsidePath = path.join(homeDir, "outside.jsonl");
    writeRaw(filePath, [
      header("symlink-swap"),
      humanMessage(0, "Original transcript"),
    ]);
    writeRaw(outsidePath, [
      header("symlink-swap"),
      humanMessage(0, "Outside transcript must not be read"),
    ]);

    const mutableFs = require("node:fs") as typeof import("node:fs");
    const originalOpenSync = mutableFs.openSync;
    const originalReadFileSync = mutableFs.readFileSync;
    let replaced = false;
    let descriptorReads = 0;
    mutableFs.openSync = ((
      target: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ) => {
      if (String(target) === filePath && !replaced) {
        replaced = true;
        fs.renameSync(filePath, `${filePath}.original`);
        fs.symlinkSync(outsidePath, filePath);
      }
      return originalOpenSync(target, flags, mode);
    }) as typeof fs.openSync;
    mutableFs.readFileSync = ((
      target: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (typeof target === "number") descriptorReads += 1;
      return (originalReadFileSync as (...input: unknown[]) => unknown)(target, ...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      expect(loadDsh(homeDir)).toEqual([]);
      expect(replaced).toBe(true);
      expect(descriptorReads).toBe(0);
    } finally {
      mutableFs.openSync = originalOpenSync;
      mutableFs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
    }
  });

  it.skipIf(process.platform === "win32")("rejects project or session directories replaced by escaping symlinks after discovery", () => {
    for (const level of ["project", "session"] as const) {
      const homeDir = temporaryHome();
      const id = `${level}-directory-swap`;
      const filePath = transcriptPath(homeDir, id);
      writeRaw(filePath, [
        header(id),
        humanMessage(0, "Original transcript"),
      ]);
      const sessionDirectory = path.dirname(filePath);
      const projectDirectory = path.dirname(sessionDirectory);
      const sessionsRoot = path.dirname(projectDirectory);
      const outsideDirectory = path.join(homeDir, `outside-${level}`);
      if (level === "project") {
        writeRaw(path.join(outsideDirectory, id, "session.jsonl"), [
          header(id),
          humanMessage(0, "Escaped project transcript must not be read"),
        ]);
      } else {
        writeRaw(path.join(outsideDirectory, "session.jsonl"), [
          header(id),
          humanMessage(0, "Escaped session transcript must not be read"),
        ]);
      }

      const mutableFs = require("node:fs") as typeof import("node:fs");
      const originalRealpathSync = mutableFs.realpathSync;
      const originalReadFileSync = mutableFs.readFileSync;
      let swapped = false;
      let descriptorReads = 0;
      mutableFs.realpathSync = ((
        target: fs.PathLike,
        ...args: unknown[]
      ) => {
        if (String(target) === sessionsRoot && !swapped) {
          swapped = true;
          const replacedDirectory = level === "project" ? projectDirectory : sessionDirectory;
          fs.renameSync(replacedDirectory, `${replacedDirectory}.original`);
          fs.symlinkSync(outsideDirectory, replacedDirectory, "dir");
        }
        return (originalRealpathSync as (...input: unknown[]) => unknown)(target, ...args);
      }) as typeof fs.realpathSync;
      mutableFs.readFileSync = ((
        target: fs.PathOrFileDescriptor,
        ...args: unknown[]
      ) => {
        if (typeof target === "number") descriptorReads += 1;
        return (originalReadFileSync as (...input: unknown[]) => unknown)(target, ...args);
      }) as typeof fs.readFileSync;
      syncBuiltinESMExports();
      try {
        expect(loadDsh(homeDir)).toEqual([]);
        expect(swapped).toBe(true);
        expect(descriptorReads).toBe(0);
      } finally {
        mutableFs.realpathSync = originalRealpathSync;
        mutableFs.readFileSync = originalReadFileSync;
        syncBuiltinESMExports();
      }
    }
  });

  it("rejects a transcript replaced by a directory after discovery", () => {
    const homeDir = temporaryHome();
    const filePath = transcriptPath(homeDir, "directory-swap");
    writeRaw(filePath, [
      header("directory-swap"),
      humanMessage(0, "Original transcript"),
    ]);

    const mutableFs = require("node:fs") as typeof import("node:fs");
    const originalOpenSync = mutableFs.openSync;
    let replaced = false;
    mutableFs.openSync = ((
      target: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ) => {
      if (String(target) === filePath && !replaced) {
        replaced = true;
        fs.renameSync(filePath, `${filePath}.original`);
        fs.mkdirSync(filePath);
      }
      return originalOpenSync(target, flags, mode);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try {
      expect(loadDsh(homeDir)).toEqual([]);
      expect(replaced).toBe(true);
    } finally {
      mutableFs.openSync = originalOpenSync;
      syncBuiltinESMExports();
    }
  });

  it("accepts only positive safe-integer turn identifiers", () => {
    const homeDir = temporaryHome();
    writeRaw(transcriptPath(homeDir, "strict-turns"), [
      header("strict-turns"),
      { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
      {
        ...humanMessage(1, "String turn must be ignored"),
        data: {
          ...(humanMessage(1, "").data as Record<string, unknown>),
          content: [{ type: "text", text: "String turn must be ignored" }],
          turn: "1",
        },
      },
      { type: "turn/start", seq: 2, time: 2, data: { turn: 2 } },
      humanMessage(3, "Positive integer turn is retained"),
    ]);

    const [loaded] = loadDsh(homeDir);
    expect(loaded.messages.map((message) => message.sourceTurnId)).toEqual([
      undefined,
      "dsh:2",
    ]);
  });

  it("accepts every event type in the DeepSeek Harness rc.7 persistence vocabulary", () => {
    const homeDir = temporaryHome();
    const knownTypes = [
      "agent-preset/selected",
      "agent/inbox/spliced",
      "approval/asked",
      "approval/decided",
      "approval/policy",
      "assistant/chunk",
      "assistant/message",
      "command/done",
      "command/run",
      "compaction/end",
      "compaction/prune",
      "compaction/start",
      "compaction/summary",
      "feedback/record",
      "goal/change",
      "hook/invoked",
      "hook/result",
      "llm/retry",
      "llm/retry-started",
      "permission/preset",
      "plan/mode",
      "request/context",
      "request/header",
      "sandbox/mode",
      "schedule/change",
      "session/end-seed",
      "session/title",
      "session/title-llm-request",
      "step/end",
      "step/start",
      "subagent/descriptor",
      "todo/write",
      "tool-workflow/agent-end",
      "tool-workflow/agent-start",
      "tool-workflow/run-end",
      "tool-workflow/run-start",
      "tool/call",
      "tool/code-dispatch",
      "tool/code-dispatch-start",
      "tool/result",
      "turn/end",
      "turn/start",
      "user/message",
      "web/deepseek-search-llm-request",
    ];
    writeRaw(transcriptPath(homeDir, "known-event-vocabulary"), [
      header("known-event-vocabulary"),
      ...knownTypes.map((type, seq) => ({
        type,
        seq,
        time: seq + 1,
        data: {},
      })),
      humanMessage(knownTypes.length, "Known event vocabulary remains readable"),
    ]);

    const [loaded] = loadDsh(homeDir);
    expect(loaded.messages.map((message) => message.content))
      .toContain("Known event vocabulary remains readable");
  });

  it("skips an unknown event only when its ignorable marker is exactly true", () => {
    const acceptedHome = temporaryHome();
    writeRaw(transcriptPath(acceptedHome, "ignorable-unknown"), [
      header("ignorable-unknown"),
      {
        type: "future/informational-event",
        seq: 0,
        time: 1,
        data: { informational: true },
        ignorable: true,
      },
      humanMessage(1, "Known content after an ignorable future event"),
    ]);
    expect(loadDsh(acceptedHome)[0].messages.map((message) => message.content))
      .toEqual(["Known content after an ignorable future event"]);

    for (const [suffix, ignorable] of [
      ["missing", undefined],
      ["false", false],
      ["number", 1],
      ["string", "true"],
      ["null", null],
    ] as const) {
      const homeDir = temporaryHome();
      const id = `required-unknown-${suffix}`;
      const unknown = {
        type: "future/required-event",
        seq: 1,
        time: 2,
        data: {},
        ...(ignorable === undefined ? {} : { ignorable }),
      };
      writeRaw(transcriptPath(homeDir, id), [
        header(id),
        humanMessage(0, "This session must be rejected"),
        unknown,
      ]);
      expect(loadDsh(homeDir)).toEqual([]);
    }
  });

  it("rejects an unknown required event inside the inherited seed prefix", () => {
    const homeDir = temporaryHome();
    writeRaw(transcriptPath(homeDir, "unknown-seed-event"), [
      header("unknown-seed-event", { seedLength: 1 }),
      {
        type: "future/required-seed-event",
        seq: 0,
        time: 1,
        data: {},
      },
      humanMessage(1, "Own event after the inherited prefix"),
    ]);

    expect(loadDsh(homeDir)).toEqual([]);
  });

  it("rejects headers with non-absolute cwd, invalid metadata, or retired policy fields", () => {
    const homeDir = temporaryHome();
    const invalidHeaders = [
      {
        id: "relative-cwd",
        projectDirectory: "--relative--",
        overrides: { cwd: "relative" },
      },
      {
        id: "invalid-depth",
        projectDirectory: "--repo--",
        overrides: { delegationDepth: "0" },
      },
      {
        id: "invalid-seed-length",
        projectDirectory: "--repo--",
        overrides: { seedLength: -1 },
      },
      {
        id: "invalid-agent-preset",
        projectDirectory: "--repo--",
        overrides: { agentPreset: 7 },
      },
      {
        id: "retired-sandbox-mode",
        projectDirectory: "--repo--",
        overrides: { sandboxMode: "workspace-write" },
      },
      {
        id: "retired-approval-policy",
        projectDirectory: "--repo--",
        overrides: { approvalPolicy: "never" },
      },
    ];
    for (const fixture of invalidHeaders) {
      writeRaw(
        transcriptPath(homeDir, fixture.id, fixture.projectDirectory),
        [
          header(fixture.id, fixture.overrides),
          humanMessage(0, `private content from ${fixture.id}`),
        ],
      );
    }
    writeRaw(
      transcriptPath(homeDir, "nul~0000id"),
      [header("nul\0id"), humanMessage(0, "private content from nul id")],
    );
    writeRaw(
      transcriptPath(homeDir, "nul-cwd", "--repo~0000private--"),
      [
        header("nul-cwd", { cwd: "/repo\0private" }),
        humanMessage(0, "private content from nul cwd"),
      ],
    );
    writeRaw(
      transcriptPath(homeDir, "nul-parent"),
      [
        header("nul-parent", { parentSession: "parent\0private" }),
        humanMessage(0, "private content from nul parent"),
      ],
    );
    const negativeZeroSeedPath = transcriptPath(homeDir, "negative-zero-seed");
    fs.mkdirSync(path.dirname(negativeZeroSeedPath), { recursive: true });
    fs.writeFileSync(negativeZeroSeedPath, [
      `{"type":"session","version":0,"id":"negative-zero-seed","createdAt":1,"cwd":"/repo","seedLength":-0,"delegationDepth":0}`,
      JSON.stringify(humanMessage(0, "private content from negative-zero-seed")),
      "",
    ].join("\n"));
    writeRaw(
      transcriptPath(homeDir, "valid-header"),
      [
        header("valid-header", { seedLength: 1, agentPreset: "minimal" }),
        humanMessage(0, "Inherited"),
        {
          type: "assistant/message",
          seq: 1,
          time: 2,
          data: { content: [{ type: "text", text: "Valid own suffix" }] },
          surfaceOp: "append",
        },
      ],
    );
    writeRaw(
      transcriptPath(homeDir, "legacy-missing-depth"),
      [header("legacy-missing-depth", { delegationDepth: undefined }), humanMessage(0, "Legacy valid")],
    );
    writeRaw(
      transcriptPath(homeDir, "windows-cwd", "--C-repo--"),
      [header("windows-cwd", { cwd: "C:\\repo" }), humanMessage(0, "Windows valid")],
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadDsh(homeDir).map((item) => item.session.rawId).sort()).toEqual([
      "legacy-missing-depth",
      "valid-header",
      "windows-cwd",
    ]);
    for (const fixture of invalidHeaders) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(fixture.id));
    }
    for (const fixture of ["nul~0000id", "nul-cwd", "nul-parent"]) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(fixture));
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("negative-zero-seed"));
    expect(warn.mock.calls.flat().join("\n")).not.toContain("private content");
  });

  it("reports missing, corrupt, oversized, and path-escaping attachment objects safely", () => {
    const homeDir = temporaryHome();
    const missingHash = "1".repeat(64);
    const expected = Buffer.from("right");
    const corruptHash = createHash("sha256").update(expected).digest("hex");
    const corruptPath = path.join(
      dshHome(homeDir),
      "attachments",
      "v1",
      "objects",
      corruptHash.slice(0, 2),
      corruptHash,
    );
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, "wrong");
    const outside = path.join(homeDir, "outside-image");
    fs.writeFileSync(outside, "escape");
    const linkedHash = createHash("sha256").update("escape").digest("hex");
    const linkedPath = path.join(
      dshHome(homeDir),
      "attachments",
      "v1",
      "objects",
      linkedHash.slice(0, 2),
      linkedHash,
    );
    fs.mkdirSync(path.dirname(linkedPath), { recursive: true });
    if (process.platform !== "win32") fs.symlinkSync(outside, linkedPath);
    const imageBlock = (
      hash: string,
      bytes: number,
      name: string,
    ) => ({
      type: "image",
      attachment: {
        attachmentId: `sha256:${hash}`,
        mediaType: "image/png",
        bytes,
        width: 1,
        height: 1,
        name,
      },
    });
    writeRaw(transcriptPath(homeDir, "attachment-statuses"), [
      header("attachment-statuses"),
      {
        type: "user/message",
        seq: 0,
        time: 1,
        data: {
          role: "user",
          source: { kind: "user" },
          content: [
            { type: "text", text: "Inspect attachments" },
            imageBlock(missingHash, 1, "missing.png"),
            imageBlock(corruptHash, expected.length, "corrupt.png"),
            imageBlock("2".repeat(64), MAX_ATTACHMENT_BYTES + 1, "large.png"),
            ...(process.platform === "win32"
              ? []
              : [imageBlock(linkedHash, 6, "linked.png")]),
          ],
        },
        surfaceOp: "append",
      },
    ]);

    const [loaded] = loadDsh(homeDir);
    expect(loaded.messages[0].attachments?.map((attachment) => attachment.status)).toEqual(
      process.platform === "win32"
        ? ["missing", "unsafe", "too_large"]
        : ["missing", "unsafe", "too_large", "unsafe"],
    );
    expect(loaded.messages[0].attachments?.every((attachment) => !attachment.source)).toBe(true);
  });

  it("does not read attachment objects swapped to links, directories, or oversized files", () => {
    const homeDir = temporaryHome();
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const swapKinds = [
      ...(process.platform === "win32" ? [] : ["symlink" as const]),
      "directory" as const,
      "oversized" as const,
    ];
    const fixtures = swapKinds.map((kind, index) => {
      const bytes = Buffer.concat([image, Buffer.from([index])]);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const objectPath = path.join(
        dshHome(homeDir),
        "attachments",
        "v1",
        "objects",
        hash.slice(0, 2),
        hash,
      );
      fs.mkdirSync(path.dirname(objectPath), { recursive: true });
      fs.writeFileSync(objectPath, bytes);
      return { kind, bytes, hash, objectPath };
    });
    const outsidePath = path.join(homeDir, "outside-image.png");
    fs.writeFileSync(outsidePath, image);
    writeRaw(transcriptPath(homeDir, "attachment-swap"), [
      header("attachment-swap"),
      {
        type: "user/message",
        seq: 0,
        time: 1,
        data: {
          role: "user",
          source: { kind: "user" },
          content: [
            { type: "text", text: "Inspect swapped attachments" },
            ...fixtures.map((fixture) => ({
              type: "image",
              attachment: {
                attachmentId: `sha256:${fixture.hash}`,
                mediaType: "image/png",
                bytes: fixture.bytes.length,
                width: 1,
                height: 1,
                name: `${fixture.kind}.png`,
              },
            })),
          ],
        },
        surfaceOp: "append",
      },
    ]);

    const mutableFs = require("node:fs") as typeof import("node:fs");
    const originalOpenSync = mutableFs.openSync;
    const originalReadFileSync = mutableFs.readFileSync;
    const replaced = new Set<string>();
    const objectDescriptors = new Set<number>();
    let objectReads = 0;
    mutableFs.openSync = ((
      target: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ) => {
      const targetPath = String(target);
      const fixture = fixtures.find((candidate) => candidate.objectPath === targetPath);
      if (fixture && !replaced.has(targetPath)) {
        replaced.add(targetPath);
        fs.renameSync(targetPath, `${targetPath}.original`);
        if (fixture.kind === "symlink") {
          fs.symlinkSync(outsidePath, targetPath);
        } else if (fixture.kind === "directory") {
          fs.mkdirSync(targetPath);
        } else {
          fs.writeFileSync(targetPath, "");
          fs.truncateSync(targetPath, MAX_ATTACHMENT_BYTES + 1);
        }
      }
      const descriptor = originalOpenSync(target, flags, mode);
      if (fixture) objectDescriptors.add(descriptor);
      return descriptor;
    }) as typeof fs.openSync;
    mutableFs.readFileSync = ((
      target: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (typeof target === "number" && objectDescriptors.has(target)) objectReads += 1;
      return (originalReadFileSync as (...input: unknown[]) => unknown)(target, ...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      const [loaded] = loadDsh(homeDir);
      expect(loaded.messages[0].attachments?.map((attachment) => attachment.status)).toEqual(
        process.platform === "win32"
          ? ["unsafe", "too_large"]
          : ["unsafe", "unsafe", "too_large"],
      );
      expect(replaced.size).toBe(fixtures.length);
      expect(objectReads).toBe(0);
    } finally {
      mutableFs.openSync = originalOpenSync;
      mutableFs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
    }
  });

  it("checks declared image dimensions on every reference and uses stable digest names", () => {
    const homeDir = temporaryHome();
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const hash = createHash("sha256").update(image).digest("hex");
    const objectPath = path.join(
      dshHome(homeDir),
      "attachments",
      "v1",
      "objects",
      hash.slice(0, 2),
      hash,
    );
    fs.mkdirSync(path.dirname(objectPath), { recursive: true });
    fs.writeFileSync(objectPath, image);
    const reference = (width: number, name?: string) => ({
      type: "image",
      attachment: {
        attachmentId: `sha256:${hash}`,
        mediaType: "image/png",
        bytes: image.length,
        width,
        height: 1,
        ...(name ? { name } : {}),
      },
    });
    writeRaw(transcriptPath(homeDir, "dimension-check"), [
      header("dimension-check"),
      {
        type: "user/message",
        seq: 0,
        time: 1,
        data: {
          role: "user",
          source: { kind: "user" },
          content: [
            { type: "text", text: "Check dimensions" },
            reference(1),
            reference(2, "wrong.png"),
          ],
        },
        surfaceOp: "append",
      },
    ]);

    const [loaded] = loadDsh(homeDir);
    expect(loaded.messages[0].attachments).toEqual([
      expect.objectContaining({
        fileName: `${hash.slice(0, 12)}.png`,
        status: "available",
      }),
      expect.objectContaining({
        fileName: "wrong.png",
        status: "unsafe",
      }),
    ]);
  });

  it("preserves a valid zero creation timestamp instead of falling back to file mtime", () => {
    const homeDir = temporaryHome();
    writeRaw(
      transcriptPath(homeDir, "epoch-session"),
      [header("epoch-session", { createdAt: 0 }), humanMessage(0, "Epoch session")],
    );

    const [loaded] = loadDsh(homeDir);
    expect(loaded.session.timestamp).toBe(0);
    expect(loaded.session.fileMtimeMs).toBeGreaterThan(0);
  });

  it("resolves explicit, environment, default, tilde, blank, and relative homes", () => {
    const homeDir = temporaryHome();
    expect(resolveDeepSeekHarnessHome("/explicit/dsh", homeDir, { DSH_HOME: "/env/dsh" }))
      .toBe(path.resolve("/explicit/dsh"));
    expect(resolveDeepSeekHarnessHome(undefined, homeDir, { DSH_HOME: "relative-dsh" }))
      .toBe(path.resolve("relative-dsh"));
    expect(resolveDeepSeekHarnessHome(undefined, homeDir, { DSH_HOME: "" }))
      .toBe(path.resolve(homeDir, ".dsh"));
    expect(resolveDeepSeekHarnessHome(undefined, homeDir, { DSH_HOME: "   " }))
      .toBe(path.resolve(homeDir, ".dsh"));
    expect(resolveDeepSeekHarnessHome("~/explicit", homeDir, {}))
      .toBe(path.join(homeDir, "explicit"));
    expect(resolveDeepSeekHarnessHome(undefined, homeDir, { DSH_HOME: "~\\environment" }))
      .toBe(path.join(homeDir, "environment"));
  });
});
