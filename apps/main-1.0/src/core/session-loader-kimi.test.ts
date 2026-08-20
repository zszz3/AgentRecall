import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { loadDefaultSessions } from "./session-loader";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function home(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-kimi-v1-")); homes.push(value); return value; }
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
    expect(loaded.session.rawId).toBe("work/session-1");
    expect(loaded.messages.map((message) => message.content)).toEqual(["hello Kimi", "hello"]);
  });

  it("falls back to the main wire file when context is absent", () => {
    const root = home();
    write(path.join(root, ".kimi-code", "sessions", "work", "session-2", "wire.jsonl"), [
      { event: { role: "user", content: "new layout" } },
      { data: { message: { role: "assistant", content: "works" } } },
    ]);
    const [loaded] = loadDefaultSessions({ homeDir: root, includeKimiCli: true });
    expect(loaded.session.rawId).toBe("work/session-2");
    expect(loaded.messages.map((message) => message.content)).toEqual(["new layout", "works"]);
  });

  it("keeps work-directory identities distinct and prefers main context over wire and subagents", () => {
    const root = home();
    write(path.join(root, ".kimi-code", "sessions", "work-a", "same", "context.jsonl"), [{ role: "user", content: "main context" }]);
    write(path.join(root, ".kimi-code", "sessions", "work-a", "same", "wire.jsonl"), [{ role: "user", content: "main wire" }]);
    write(path.join(root, ".kimi-code", "sessions", "work-a", "same", "subagents", "worker", "wire.jsonl"), [{ role: "user", content: "subagent" }]);
    write(path.join(root, ".kimi-code", "sessions", "work-b", "same", "context.jsonl"), [{ role: "user", content: "b" }]);
    const loaded = loadDefaultSessions({ homeDir: root, includeKimiCli: true });
    expect(loaded.map((item) => item.session.rawId)).toEqual(["work-a/same", "work-b/same"]);
    expect(loaded[0].session.filePath).toBe(path.join(root, ".kimi-code", "sessions", "work-a", "same", "context.jsonl"));
    expect(loaded[0].messages.map((message) => message.content)).toEqual(["main context"]);
  });

  it("maps the official work-directory hash through kimi.json", () => {
    const root = home();
    const projectPath = "D:/official-kimi-project";
    const workDirHash = createHash("md5").update(projectPath, "utf8").digest("hex");
    fs.mkdirSync(path.join(root, ".kimi"), { recursive: true });
    fs.writeFileSync(path.join(root, ".kimi", "kimi.json"), JSON.stringify({ work_dirs: [{ path: projectPath }] }), "utf8");
    write(path.join(root, ".kimi", "sessions", workDirHash, "session-mapped", "context.jsonl"), [
      { role: "user", content: "mapped project" },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeKimiCli: true });
    expect(loaded.session.projectPath).toBe(projectPath);
  });
});
