import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { detectLiveSessionsFromProcessLines, loadLiveSessionSnapshot } from "./session-activity";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync };

describe("live session deletion guards", () => {
  it("does not invent live session ids for unresolved Windows CLI families", async () => {
    const snapshot = await loadLiveSessionSnapshot({
      platform: "win32",
      runner: async () => [
        '321 "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe"',
        '322 "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"',
      ].join("\n"),
    });

    expect(snapshot.sessions).toEqual([]);
  });

  it("does not invent live session ids when macOS cannot map plain CLI processes", async () => {
    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      homeDir: path.join(os.tmpdir(), "agent-recall-missing-live-session-fixtures"),
      runner: async (command) => {
        if (command === "/bin/ps") return "321 /opt/homebrew/bin/claude\n322 /opt/homebrew/bin/codex";
        if (command === "lsof") return "";
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([]);
  });

  it("detects Windows resume commands with backslashes, .cmd/.exe, UNC paths, and O'Brien paths", () => {
    expect(
      detectLiveSessionsFromProcessLines(
        [
          '101 "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\O\'Brien\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" resume -c model=o3 codex-win-1',
          '102 "C:\\Users\\dev\\AppData\\Local\\codex.exe" -C "D:\\Projects\\中文项目" resume codex-win-2',
          '103 "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd" --resume claude-win-1',
          '104 "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd" -r claude-win-short',
          '105 "C:\\Users\\dev\\AppData\\Roaming\\npm\\tcodex.cmd" resume tcodex-win-1',
          '106 "C:\\Users\\dev\\AppData\\Roaming\\npm\\tclaude.cmd" --resume=tclaude-win-1',
          '107 "C:\\Users\\dev\\AppData\\Roaming\\npm\\codebuddy.cmd" --resume cb-win-1',
          '108 "\\\\server\\share\\tools\\codewiz.exe" --session cw-win-1',
          '109 "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex-code-mode-host.exe"',
        ],
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        "win32",
      ),
    ).toEqual([
      { family: "codex", rawId: "codex-win-1", pid: 101 },
      { family: "codex", rawId: "codex-win-2", pid: 102 },
      { family: "claude", rawId: "claude-win-1", pid: 103 },
      { family: "claude", rawId: "claude-win-short", pid: 104 },
      { family: "tcodex", rawId: "tcodex-win-1", pid: 105 },
      { family: "tclaude", rawId: "tclaude-win-1", pid: 106 },
      { family: "codebuddy", rawId: "cb-win-1", pid: 107 },
      { family: "codewiz", rawId: "cw-win-1", pid: 108 },
    ]);
  });

  it("maps Windows live CLI processes via Win32_Process JSON, session pid files, DBs, and CWD fallback", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-v2-win32-live-"));
    try {
      const home = path.join(root, "home");
      const codexCwdA = path.join(root, "repo-alpha");
      const codexCwdB = path.join(root, "中文工作区");
      const claudeCwd = path.join(root, "claude-proj");
      const cursorCwd = path.join(root, "cursor-proj");
      const codebuddyCwd = path.join(root, "cb work");
      const opencodeCwdA = path.join(root, "opencode-a");
      const opencodeCwdB = path.join(root, "opencode-b");

      const codexSessionA = "11111111-1111-4111-8111-111111111111";
      const codexSessionB = "22222222-2222-4222-8222-222222222222";
      const codexFileA = path.join(home, ".codex", "sessions", "2026", "09", "01", `rollout-2026-09-01T10-00-00-${codexSessionA}.jsonl`);
      const codexFileB = path.join(home, ".codex", "sessions", "2026", "09", "01", `rollout-2026-09-01T10-05-00-${codexSessionB}.jsonl`);
      fs.mkdirSync(path.dirname(codexFileA), { recursive: true });
      fs.writeFileSync(codexFileA, JSON.stringify({ type: "session_meta", payload: { id: codexSessionA, cwd: codexCwdA } }) + "\n");
      fs.writeFileSync(codexFileB, JSON.stringify({ type: "session_meta", payload: { id: codexSessionB, cwd: codexCwdB } }) + "\n");

      const claudeSessionMetaDir = path.join(home, ".claude", "sessions");
      fs.mkdirSync(claudeSessionMetaDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeSessionMetaDir, "202.json"),
        JSON.stringify({ pid: 202, sessionId: "claude-pidfile-1", cwd: claudeCwd }),
      );

      const claudeProjectDir = path.join(home, ".claude", "projects", claudeCwd.replace(/[^a-zA-Z0-9-]/g, "-"));
      fs.mkdirSync(claudeProjectDir, { recursive: true });
      const claudePlainFile = path.join(claudeProjectDir, "claude-win-cwd-1.jsonl");
      fs.writeFileSync(claudePlainFile, '{"type":"mode","sessionId":"claude-win-cwd-1"}\n');
      const now = new Date("2026-09-01T10:15:00.000Z");
      fs.utimesSync(claudePlainFile, now, now);

      const cursorSlug = cursorCwd
        .replace(/\\/g, "/")
        .replace(/^[A-Za-z]:\//, (m) => `${m[0]}-`)
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const cursorTranscript = path.join(home, ".cursor", "projects", cursorSlug, "agent-transcripts", "cursor-win-1", "cursor-win-1.jsonl");
      fs.mkdirSync(path.dirname(cursorTranscript), { recursive: true });
      fs.writeFileSync(cursorTranscript, '{"role":"user"}\n');

      const cbSessionId = "33333333-3333-4333-8333-333333333333";
      const cbSlug = codebuddyCwd.replace(/^[/\\]+/, "").replace(/[:/\\]/g, "-");
      fs.mkdirSync(path.join(home, ".codebuddy", "projects", cbSlug, cbSessionId, "tool-results"), { recursive: true });

      const opencodeDbPath = path.join(home, ".local", "share", "opencode", "opencode.db");
      fs.mkdirSync(path.dirname(opencodeDbPath), { recursive: true });
      const opencodeDb = new DatabaseSync(opencodeDbPath);
      opencodeDb.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created TEXT, time_updated TEXT)");
      opencodeDb.prepare("INSERT INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)").run(
        "opencode-win-a",
        opencodeCwdA.replace(/\//g, "\\"),
        "2026-09-01T10:00:00Z",
        "2026-09-01T10:10:00Z",
      );
      opencodeDb.prepare("INSERT INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)").run(
        "opencode-win-b",
        opencodeCwdB,
        "2026-09-01T10:00:00Z",
        "2026-09-01T10:05:00Z",
      );
      opencodeDb.close();

      const runnerCalls: Array<{ command: string; args: string[] }> = [];
      const snapshot = await loadLiveSessionSnapshot({
        platform: "win32",
        homeDir: home,
        now,
        runner: async (command, args) => {
          runnerCalls.push({ command, args });
          const script = args[args.length - 1] ?? "";
          if (script.includes("Win32_Process")) {
            return JSON.stringify([
              {
                ProcessId: 200,
                ParentProcessId: 10,
                Name: "node.exe",
                ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
                CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"',
                CreationDate: `/Date(${now.getTime()})/`,
              },
              {
                ProcessId: 201,
                ParentProcessId: 200,
                Name: "codex.exe",
                ExecutablePath: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex.exe",
                CommandLine: '"C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex.exe"',
                CreationDate: `/Date(${now.getTime()})/`,
              },
              {
                ProcessId: 209,
                ParentProcessId: 10,
                Name: "node.exe",
                ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
                CommandLine: `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" -C "${codexCwdA}"`,
                CreationDate: `/Date(${now.getTime()})/`,
              },
              {
                ProcessId: 202,
                ParentProcessId: 10,
                Name: "claude.exe",
                ExecutablePath: "C:\\Users\\me\\.local\\bin\\claude.exe",
                CommandLine: '"C:\\Users\\me\\.local\\bin\\claude.exe"',
                CreationDate: `/Date(${now.getTime()})/`,
              },
              {
                ProcessId: 203,
                ParentProcessId: 10,
                Name: "node.exe",
                ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
                CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"',
                CreationDate: `/Date(${now.getTime() - 10_000})/`,
              },
              {
                ProcessId: 204,
                ParentProcessId: 10,
                Name: "claude.exe",
                ExecutablePath: "C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-0.9.3\\claude.exe",
                CommandLine: '"C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-0.9.3\\claude.exe" --type=renderer',
                CreationDate: `/Date(${now.getTime()})/`,
              },
              {
                ProcessId: 205,
                ParentProcessId: 10,
                Name: "cursor-agent.cmd",
                ExecutablePath: null,
                CommandLine: '"C:\\Users\\me\\AppData\\Roaming\\npm\\cursor-agent.cmd"',
                CreationDate: null,
              },
              {
                ProcessId: 206,
                ParentProcessId: 10,
                Name: "codebuddy.cmd",
                ExecutablePath: null,
                CommandLine: '"C:\\Users\\me\\AppData\\Roaming\\npm\\codebuddy.cmd"',
                CreationDate: null,
              },
              {
                ProcessId: 207,
                ParentProcessId: 10,
                Name: "opencode.exe",
                ExecutablePath: "C:\\Tools\\opencode.exe",
                CommandLine: '"C:\\Tools\\opencode.exe"',
                CreationDate: null,
              },
            ]);
          }
          if (script.includes("WinProcCwd")) {
            return JSON.stringify({
              "201": codexCwdB,
              "203": claudeCwd,
              "205": cursorCwd,
              "206": codebuddyCwd,
              "207": opencodeCwdA,
            });
          }
          return "";
        },
      });

      expect(runnerCalls.length).toBe(2);
      expect(runnerCalls[0].command).toBe("powershell.exe");
      expect(runnerCalls[0].args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
      expect(runnerCalls[0].args[3]).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
      expect(runnerCalls[1].args[3]).toContain("WinProcCwd");

      expect(snapshot.sessions).toEqual([
        { family: "codex", rawId: codexSessionB, pid: 201 },
        { family: "codex", rawId: codexSessionA, pid: 209 },
        { family: "claude", rawId: "claude-pidfile-1", pid: 202 },
        { family: "claude", rawId: "claude-win-cwd-1", pid: 203 },
        { family: "cursor", rawId: "cursor-win-1", pid: 205 },
        { family: "codebuddy", rawId: cbSessionId, pid: 206 },
        { family: "opencode", rawId: "opencode-win-a", pid: 207 },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
