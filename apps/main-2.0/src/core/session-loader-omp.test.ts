import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadDefaultSessions } from "./session-loader";

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-omp-v2-"));
  temporaryHomes.push(homeDir);
  return homeDir;
}

/** omp pads the leading title record to a fixed 256-byte slot. */
function titleSlot(title: string): string {
  const line = JSON.stringify({ type: "title", v: 1, title, source: "auto", pad: "" });
  return line.replace(`"pad":""`, `"pad":"${" ".repeat(Math.max(0, 255 - Buffer.byteLength(line)))}"`);
}

function writeOmpSession(filePath: string, title: string | null, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = rows.map((row) => JSON.stringify(row));
  fs.writeFileSync(filePath, [...(title === null ? [] : [titleSlot(title)]), ...lines].join("\n"));
}

function userMessage(id: string, parentId: string | null, text: string): unknown {
  return { type: "message", id, parentId, timestamp: "2026-11-27T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse("2026-11-27T10:00:01.000Z") } };
}

afterEach(() => {
  for (const homeDir of temporaryHomes.splice(0)) fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("omp session loading", () => {
  it("reads title-slot files, counts side-channel usage, and links subagent transcripts", () => {
    const homeDir = temporaryHome();
    const bucket = path.join(homeDir, ".omp", "agent", "sessions", "--work-omp--");
    const stem = "2026-11-27T10-00-00-000Z_omp-parent";
    writeOmpSession(path.join(bucket, `${stem}.jsonl`), "Slot title", [
      { type: "session", version: 3, id: "omp-parent", timestamp: "2026-11-27T10:00:00.000Z", cwd: "/work/omp" },
      { type: "model_change", id: "m1", parentId: null, timestamp: "2026-11-27T10:00:00.100Z", model: "anthropic/claude" },
      userMessage("u1", "m1", "Searchable omp question"),
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-11-27T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Reading." }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/app.ts" } }],
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20 },
          timestamp: Date.parse("2026-11-27T10:00:02.000Z"),
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "2026-11-27T10:00:03.000Z",
        message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "export const value = 1;" }], isError: false, timestamp: Date.parse("2026-11-27T10:00:03.000Z") },
      },
      { type: "model_usage", id: "mu1", parentId: "t1", timestamp: "2026-11-27T10:00:04.000Z", purpose: "title-fork", usage: { input: 7, output: 1, cacheRead: 4, cacheWrite: 0, totalTokens: 12 } },
      { type: "title_change", id: "tc1", parentId: "mu1", timestamp: "2026-11-27T10:00:04.100Z", title: "Older title", source: "auto" },
    ]);
    writeOmpSession(path.join(bucket, stem, "Scout.jsonl"), null, [
      { type: "session", version: 3, id: "omp-child", timestamp: "2026-11-27T10:00:05.000Z", cwd: "/work/omp" },
      userMessage("cu1", null, "Investigate the loader"),
      { type: "message", id: "ca1", parentId: "cu1", timestamp: "2026-11-27T10:00:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "Found it." }] } },
    ]);

    expect(loadDefaultSessions({ homeDir }).some((item) => item.session.source === "omp-cli")).toBe(false);
    const loaded = loadDefaultSessions({ homeDir, includeOmp: true }).filter((item) => item.session.source === "omp-cli");
    const parent = loaded.find((item) => item.session.rawId === "omp-parent");
    const child = loaded.find((item) => item.session.rawId === "omp-child");

    expect(parent?.session).toMatchObject({
      sessionKey: "omp:omp-parent",
      projectPath: "/work/omp",
      originalTitle: "Slot title",
      firstQuestion: "Searchable omp question",
      isSubagent: false,
      tokenUsage: { inputTokens: 17, outputTokens: 6, cachedInputTokens: 9 },
    });
    expect(parent?.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Searchable omp question"],
      ["assistant", "Reading."],
    ]);
    expect(parent?.traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool_call", callId: "call-1" }),
      expect.objectContaining({ kind: "tool_result", callId: "call-1", status: "completed" }),
    ]));
    expect(child?.session).toMatchObject({
      sessionKey: "omp:omp-child",
      originalTitle: "Investigate the loader",
      isSubagent: true,
      parentSessionId: "omp-parent",
    });
  });

  it("falls back to title_change and the header title for legacy header-first files", () => {
    const homeDir = temporaryHome();
    const bucket = path.join(homeDir, ".omp", "agent", "sessions", "-tmp");
    writeOmpSession(path.join(bucket, "renamed.jsonl"), null, [
      { type: "session", version: 3, id: "renamed", timestamp: "2026-11-27T10:00:00.000Z", cwd: "/tmp", title: "Header title" },
      userMessage("u1", null, "Question"),
      { type: "title_change", id: "tc1", parentId: "u1", timestamp: "2026-11-27T10:00:02.000Z", title: "Renamed title" },
    ]);
    writeOmpSession(path.join(bucket, "header-only.jsonl"), null, [
      { type: "session", version: 3, id: "header-only", timestamp: "2026-11-27T10:00:00.000Z", cwd: "/tmp", title: "Header title" },
      userMessage("u1", null, "Question"),
    ]);

    const titles = Object.fromEntries(
      loadDefaultSessions({ homeDir, includeOmp: true })
        .filter((item) => item.session.source === "omp-cli")
        .map((item) => [item.session.rawId, item.session.originalTitle]),
    );
    expect(titles).toEqual({ renamed: "Renamed title", "header-only": "Header title" });
  });
});
