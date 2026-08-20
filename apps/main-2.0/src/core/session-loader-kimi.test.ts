import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadDefaultSessions } from "./session-loader";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

function home(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-kimi-v2-")); homes.push(value); return value; }
function write(filePath: string, rows: unknown[]): void { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8"); }

describe("Kimi Code session loading", () => {
  it("loads legacy context.jsonl read-only", () => {
    const root = home();
    write(path.join(root, ".kimi", "sessions", "work", "session-1", "context.jsonl"), [
      { type: "session", id: "session-1", cwd: "D:/demo" },
      { role: "user", content: "hello Kimi" },
      { role: "assistant", content: "hello" },
    ]);
    const [loaded] = loadDefaultSessions({ homeDir: root, includeKimiCli: true });
    expect(loaded.session.source).toBe("kimi-cli");
    expect(loaded.session.rawId).toBe("session-1");
    expect(loaded.messages.map((message) => message.content)).toEqual(["hello Kimi", "hello"]);
  });

  it("accepts nested wire records from the newer layout", () => {
    const root = home();
    write(path.join(root, ".kimi-code", "sessions", "work", "session-2", "agents", "root", "wire.jsonl"), [
      { event: { role: "user", content: "new layout" } },
      { data: { message: { role: "assistant", content: "works" } } },
    ]);
    const [loaded] = loadDefaultSessions({ homeDir: root, includeKimiCli: true });
    expect(loaded.session.rawId).toBe("session-2");
    expect(loaded.messages.map((message) => message.content)).toEqual(["new layout", "works"]);
  });
});
