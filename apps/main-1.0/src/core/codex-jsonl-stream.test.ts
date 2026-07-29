import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { scanCompleteJsonl } from "./codex-jsonl-stream";
import { loadCodexSessionFile } from "./session-loader";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-stream-"));
  roots.push(root);
  const filePath = path.join(root, "session.jsonl");
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("scanCompleteJsonl", () => {
  test("parses records spanning chunks and leaves an incomplete tail behind the cursor", () => {
    const large = { type: "response_item", payload: { type: "message", text: "你好".repeat(40) } };
    const second = { type: "event_msg", payload: { type: "task_complete" } };
    const complete = `${JSON.stringify(large)}\n${JSON.stringify(second)}\n`;
    const filePath = fixture(`${complete}{"type":"event_msg"`);
    const records: unknown[] = [];

    const result = scanCompleteJsonl(filePath, {
      chunkSize: 17,
      onRecord: (record) => records.push(record),
    });

    expect(records).toEqual([large, second]);
    expect(result.committedOffset).toBe(Buffer.byteLength(complete));
    expect(result.fileSize).toBeGreaterThan(result.committedOffset);
    expect(result.malformedLines).toBe(0);
  });

  test("starts from a committed byte offset and skips malformed complete lines", () => {
    const first = `${JSON.stringify({ id: 1 })}\n`;
    const appended = `not-json\n${JSON.stringify({ id: 2 })}\n`;
    const filePath = fixture(`${first}${appended}`);
    const records: unknown[] = [];

    const result = scanCompleteJsonl(filePath, {
      startOffset: Buffer.byteLength(first),
      chunkSize: 5,
      onRecord: (record) => records.push(record),
    });

    expect(records).toEqual([{ id: 2 }]);
    expect(result.startOffset).toBe(Buffer.byteLength(first));
    expect(result.committedOffset).toBe(Buffer.byteLength(`${first}${appended}`));
    expect(result.malformedLines).toBe(1);
  });

  test("loads a Codex session without reading the whole source into one string", () => {
    const sessionId = "019f0000-0000-7000-8000-000000000001";
    const filePath = fixture([
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-29T00:00:00Z", payload: { id: sessionId, cwd: "/work/app" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-29T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "检查项目" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-29T00:00:02Z", payload: { type: "function_call_output", call_id: "call-1", output: "x".repeat(200_000) } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-29T00:00:03Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "完成" }] } }),
    ].join("\n") + "\n");
    const originalReadFileSync = fs.readFileSync;
    const wholeFileRead = vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(target) === filePath) throw new Error("whole-file read forbidden");
      return (originalReadFileSync as (...input: unknown[]) => unknown)(target, ...args);
    }) as typeof fs.readFileSync);

    const loaded = loadCodexSessionFile(filePath);

    expect(wholeFileRead).not.toHaveBeenCalledWith(filePath, expect.anything());
    expect(loaded?.session.rawId).toBe(sessionId);
    expect(loaded?.messages.map((message) => message.content)).toEqual(["检查项目", "完成"]);
  });
});
