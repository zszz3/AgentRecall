import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { zstdCompressSync } from "node:zlib";
import { loadDefaultSessionsIterator } from "./session-loader";

describe("deepseek enabled end-to-end (synthetic fixture)", () => {
  it.each(["session.jsonl.zstd", "session.v1.jsonl.zstd", "session.v4.jsonl.zstd"])("discovers %s only when enabled, preferring the current log over its legacy copy", (logName) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-dsh-default-"));
    try {
      const home = path.join(root, "home");
      const logPath = path.join(home, ".dsh", "sessions", "--work--", "s1", logName);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const lines = [
        { type: "session", version: logName === "session.jsonl.zstd" ? 0 : Number(logName.match(/v(\d+)/)?.[1]), id: "s1", createdAt: 1700000000000, cwd: "/work", delegationDepth: 0 },
        { type: "user/message", seq: 0, time: 1700000000001, data: { id: "m1", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } }, surfaceOp: "append" },
      ];
      const text = lines.map((l) => JSON.stringify(l)).join(String.fromCharCode(10)) + String.fromCharCode(10);
      fs.writeFileSync(logPath, zstdCompressSync(Buffer.from(text)));
      if (logName !== "session.jsonl.zstd") {
        fs.writeFileSync(path.join(path.dirname(logPath), "session.jsonl.zstd"), zstdCompressSync(Buffer.from(text.replace("hello", "stale"))));
      }

      const off = [...loadDefaultSessionsIterator({ homeDir: home })];
      expect(off.filter((item) => item.session.source === "deepseek-cli")).toHaveLength(0);

      const on = [...loadDefaultSessionsIterator({ homeDir: home, includeDeepSeekCli: true })];
      const deepseek = on.filter((item) => item.session.source === "deepseek-cli");
      expect(deepseek).toHaveLength(1);
      expect(deepseek[0].session.sessionKey).toBe("deepseek:s1");
      expect(deepseek[0].session.projectPath).toBe("/work");
      expect(deepseek[0].session.filePath).toBe(logPath);
      expect(deepseek[0].messages[0].content).toBe("hello");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
