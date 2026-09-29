import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { scanCompleteJsonl, scanCompleteJsonlAsync } from "./codex-jsonl-stream";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(text: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-cursor-")); roots.push(root);
  const file = path.join(root, "session.jsonl"); fs.writeFileSync(file, text); return file;
}
for (const scan of [scanCompleteJsonl, scanCompleteJsonlAsync]) {
  test(`${scan.name} propagates consumer failures for terminated and final records`, async () => {
    for (const ending of ["\n", ""]) {
      const file = fixture('{"id":1}' + ending);
      const error = new Error("projection failed");
      await expect(Promise.resolve().then(() => scan(file, { onRecord: () => { throw error; } }))).rejects.toBe(error);
    }
  });
  test(`${scan.name} resumes incomplete multibyte records without replaying history`, async () => {
    const head = '{"id":1}\r\n';
    const tail = Buffer.from('{"text":"你好"}\n');
    const file = fixture(head); fs.appendFileSync(file, tail.subarray(0, 11));
    const first: unknown[] = [];
    const cursor = await scan(file, { chunkSize: 2, onRecord: row => { first.push(row); } });
    expect(first).toEqual([{ id: 1 }]);
    expect(cursor.committedOffset).toBe(Buffer.byteLength(head));
    fs.appendFileSync(file, tail.subarray(11));
    const appended: unknown[] = [];
    const next = await scan(file, { startOffset: cursor.committedOffset, chunkSize: 2, onRecord: row => { appended.push(row); } });
    expect(appended).toEqual([{ text: "你好" }]);
    expect(next.committedOffset).toBe(fs.statSync(file).size);
  });
}
