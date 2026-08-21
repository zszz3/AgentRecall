import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { loadDefaultSessions } from "./session-loader";

const homes: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
afterEach(() => {
  delete process.env.KIMI_CODE_HOME;
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function home(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-kimi-v2-")); homes.push(value); return value; }
function write(filePath: string, rows: unknown[]): void { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8"); }
function writeJson(filePath: string, value: unknown): void { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(value), "utf8"); }
function writeKimiCodeSession(root: string, workDirKey: string, sessionId: string, options: {
  title?: string;
  workDir?: string;
  custom?: Record<string, unknown>;
  indexed?: boolean;
  truncatedTail?: boolean;
} = {}): string {
  const sessionDir = path.join(root, "sessions", workDirKey, sessionId);
  const wirePath = path.join(sessionDir, "agents", "main", "wire.jsonl");
  writeJson(path.join(sessionDir, "state.json"), {
    title: options.title ?? "Official Kimi title",
    updatedAt: 1_700_000_010_000,
    ...(options.workDir ? { workDir: options.workDir } : {}),
    ...(options.custom ? { custom: options.custom } : {}),
  });
  write(wirePath, [
    { type: "metadata", protocol_version: "1.5", created_at: 1_700_000_000_000 },
    { type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "Hello Kimi Code" }] }, time: 1_700_000_001_000 },
    { type: "context.append_loop_event", event: { type: "step.begin", uuid: "step-1", turnId: "turn-1", step: 0 }, time: 1_700_000_002_000 },
    { type: "context.append_loop_event", event: { type: "content.part", stepUuid: "step-1", part: { type: "text", text: "Hello from the new engine" } }, time: 1_700_000_003_000 },
    { type: "context.append_loop_event", event: { type: "step.end", uuid: "step-1", turnId: "turn-1", step: 0 }, time: 1_700_000_004_000 },
  ]);
  if (options.truncatedTail) fs.appendFileSync(wirePath, "\n{\"type\":\"context.append_message\"", "utf8");
  if (options.indexed !== false) {
    const indexPath = path.join(root, "session_index.jsonl");
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.appendFileSync(indexPath, `${JSON.stringify({ sessionId, sessionDir, workDir: options.workDir ?? "D:/indexed-project" })}\n`, "utf8");
  }
  return wirePath;
}

describe("Kimi Code session loading", () => {
  it("loads legacy context.jsonl read-only", () => {
    const root = home();
    const sessionDir = path.join(root, ".kimi", "sessions", "work", "session-1");
    writeJson(path.join(sessionDir, "state.json"), { custom_title: "Renamed legacy session" });
    write(path.join(sessionDir, "context.jsonl"), [
      { type: "session", id: "session-1", cwd: "D:/demo" },
      { role: "user", content: "hello Kimi" },
      { role: "assistant", content: "hello" },
    ]);
    const [loaded] = loadDefaultSessions({ homeDir: root, includeKimiCli: true });
    expect(loaded.session.source).toBe("kimi-cli");
    expect(loaded.session.rawId).toBe("work/session-1");
    expect(loaded.session.originalTitle).toBe("Renamed legacy session");
    expect(loaded.messages.map((message) => message.content)).toEqual(["hello Kimi", "hello"]);
  });

  it("loads the legacy flat session layout", () => {
    const root = home();
    write(path.join(root, ".kimi", "sessions", "work", "flat-session.jsonl"), [
      { role: "user", content: "flat legacy session" },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir: root, includeKimiCli: true });
    expect(loaded.session.rawId).toBe("work/flat-session");
    expect(loaded.messages.map((message) => message.content)).toEqual(["flat legacy session"]);
  });

  it("loads the official Kimi Code layout, metadata, and event stream", () => {
    const root = home();
    const codeRoot = path.join(root, ".kimi-code");
    const wirePath = writeKimiCodeSession(codeRoot, "wd_demo_123456789abc", "session-2", {
      title: "Renamed Kimi session",
      workDir: "D:/new-kimi-project",
      truncatedTail: true,
    });
    write(path.join(codeRoot, "sessions", "wd_demo_123456789abc", "session-2", "agents", "agent-0", "wire.jsonl"), [
      { type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "subagent must not appear" }] } },
    ]);
    const [loaded] = loadDefaultSessions({ homeDir: root, includeKimiCli: true });
    expect(loaded.session.rawId).toBe("session-2");
    expect(loaded.session.filePath).toBe(wirePath);
    expect(loaded.session.originalTitle).toBe("Renamed Kimi session");
    expect(loaded.session.projectPath).toBe("D:/new-kimi-project");
    expect(loaded.messages.map((message) => message.content)).toEqual(["Hello Kimi Code", "Hello from the new engine"]);
  });

  it("falls back to filesystem discovery and the indexed work directory", () => {
    const root = home();
    const codeRoot = path.join(root, ".kimi-code");
    writeKimiCodeSession(codeRoot, "wd_a_123456789abc", "indexed-session");
    writeKimiCodeSession(codeRoot, "wd_b_123456789abc", "scanned-session", { indexed: false, workDir: "D:/state-project" });
    const loaded = loadDefaultSessions({ homeDir: root, includeKimiCli: true });
    expect(loaded.map((item) => item.session.rawId)).toEqual(["indexed-session", "scanned-session"]);
    expect(loaded[0].session.projectPath).toBe("D:/indexed-project");
    expect(loaded[1].session.projectPath).toBe("D:/state-project");
  });

  it("uses the legacy .kimi source as authority over a migrated Kimi Code copy", () => {
    const root = home();
    const official = path.join(root, ".kimi", "sessions", "work", "legacy-id", "context.jsonl");
    write(official, [{ role: "user", content: "authoritative" }]);
    writeKimiCodeSession(path.join(root, ".kimi-code"), "wd_demo_123456789abc", "ses_legacy-id", {
      custom: { imported_from_kimi_cli: true, kimi_cli_session_id: "legacy-id" },
    });

    const [loaded] = loadDefaultSessions({ homeDir: root, includeKimiCli: true });
    expect(loaded.session.filePath).toBe(official);
    expect(loaded.messages.map((message) => message.content)).toEqual(["authoritative"]);
  });

  it("does not fall back to a lower-priority root when the authority is skipped", () => {
    const root = home();
    const official = path.join(root, ".kimi", "sessions", "work", "legacy-id", "context.jsonl");
    write(official, [{ role: "user", content: "authoritative" }]);
    writeKimiCodeSession(path.join(root, ".kimi-code"), "wd_demo_123456789abc", "ses_legacy-id", {
      custom: { imported_from_kimi_cli: true, kimi_cli_session_id: "legacy-id" },
    });

    const loaded = loadDefaultSessions({
      homeDir: root,
      includeKimiCli: true,
      shouldSkipFile: (filePath) => filePath === official,
    });
    expect(loaded).toHaveLength(0);
  });

  it("uses KIMI_CODE_HOME for the default local home", () => {
    const root = home();
    const customRoot = path.join(root, "custom-kimi-home");
    writeKimiCodeSession(customRoot, "wd_env_123456789abc", "env-session", { workDir: "D:/env-project" });
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.KIMI_CODE_HOME = customRoot;

    const loaded = loadDefaultSessions({ includeKimiCli: true });
    expect(loaded.map((item) => item.session.rawId)).toEqual(["env-session"]);
    expect(loaded[0].session.projectPath).toBe("D:/env-project");
  });

  it("rejects session index entries outside the Kimi Code sessions root", () => {
    const root = home();
    const codeRoot = path.join(root, ".kimi-code");
    const outsideWire = writeKimiCodeSession(path.join(root, "outside-kimi"), "wd_outside_123456789abc", "outside-session", { indexed: false });
    const outsideSessionDir = path.dirname(path.dirname(path.dirname(outsideWire)));
    write(path.join(codeRoot, "session_index.jsonl"), [
      { sessionId: "outside-session", sessionDir: outsideSessionDir, workDir: "D:/outside" },
    ]);

    expect(loadDefaultSessions({ homeDir: root, includeKimiCli: true })).toHaveLength(0);
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
