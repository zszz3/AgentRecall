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

  it("maps omp processes to session ids via terminal breadcrumbs, --resume prefixes, and the cwd bucket", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-omp-live-"));
    try {
      const home = path.join(root, "home");
      const sessionsRoot = path.join(home, ".omp", "agent", "sessions");
      const breadcrumbsDir = path.join(home, ".omp", "agent", "terminal-sessions");
      fs.mkdirSync(breadcrumbsDir, { recursive: true });
      const now = new Date("2026-11-27T14:30:00.000Z");
      const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
      const bucketFor = (cwd: string) => `--${cwd.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-")}--`;
      const writeSession = (bucket: string, rawId: string, mtime: Date, cwd: string): string => {
        const filePath = path.join(sessionsRoot, bucket, `2026-11-27T14-00-00-000Z_${rawId}.jsonl`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify({ type: "title", v: 1, title: "", pad: "" })}\n${JSON.stringify({ type: "session", version: 3, id: rawId, cwd })}\n`);
        fs.utimesSync(filePath, mtime, mtime);
        return filePath;
      };
      const writeBreadcrumb = (terminalId: string, cwd: string, sessionFile: string, mtime: Date, fresh = false): void => {
        const filePath = path.join(breadcrumbsDir, terminalId);
        fs.writeFileSync(filePath, `${cwd}\n${sessionFile}\n${fresh ? "fresh\n" : ""}`);
        fs.utimesSync(filePath, mtime, mtime);
      };

      // Two terminals in one cwd: each breadcrumb belongs to the process started closest before it.
      const cwdA = path.join(root, "repo-a");
      const sessionA1 = writeSession(bucketFor(cwdA), "01a00000-0000-7000-8000-00000000a001", at(-50_000), cwdA);
      const sessionA2 = writeSession(bucketFor(cwdA), "01a00000-0000-7000-8000-00000000a002", at(-40_000), cwdA);
      writeBreadcrumb("wt-a1", cwdA, sessionA1, at(-600_000 + 1_000));
      writeBreadcrumb("wt-a2", cwdA, sessionA2, at(-5_000));
      // An explicit --resume prefix resolves across buckets.
      writeSession("--elsewhere--", "01b00000-0000-7000-8000-00000000b001", at(-3_600_000), "/elsewhere");
      // No breadcrumb and an unrecognized bucket name: the header cwd identifies the bucket.
      const cwdC = path.join(root, "repo-c");
      writeSession("renamed-bucket", "01c00000-0000-7000-8000-00000000c001", at(-7_200_000), cwdC);
      writeSession("renamed-bucket", "01c00000-0000-7000-8000-00000000c002", at(-1_000), cwdC);
      // A fresh breadcrumb (lazy session, no file yet) keeps an older recent session from looking live.
      const cwdD = path.join(root, "repo-d");
      writeSession(bucketFor(cwdD), "01d00000-0000-7000-8000-00000000d001", at(-1_000), cwdD);
      writeBreadcrumb("wt-d", cwdD, path.join(sessionsRoot, bucketFor(cwdD), "2026-11-27T14-29-00-000Z_missing.jsonl"), at(-2_000), true);

      const ompExe = "C:\\Users\\me\\AppData\\Local\\omp\\omp.exe";
      const processes = [
        { ProcessId: 301, CommandLine: `"${ompExe}"`, CreationDate: `/Date(${at(-600_000).getTime()})/` },
        { ProcessId: 302, CommandLine: `"${ompExe}"`, CreationDate: `/Date(${at(-6_000).getTime()})/` },
        { ProcessId: 303, CommandLine: `${ompExe} __omp_worker_daemon`, CreationDate: `/Date(${at(-6_000).getTime()})/` },
        { ProcessId: 304, CommandLine: `"${ompExe}" --model sonnet --resume 01b00000`, CreationDate: `/Date(${at(-6_000).getTime()})/` },
        { ProcessId: 305, CommandLine: `"${ompExe}" models`, CreationDate: `/Date(${at(-6_000).getTime()})/` },
        { ProcessId: 306, CommandLine: `"${ompExe}" --cwd "${cwdC}"`, CreationDate: `/Date(${at(-60_000).getTime()})/` },
        { ProcessId: 307, CommandLine: `"${ompExe}"`, CreationDate: `/Date(${at(-3_000).getTime()})/` },
      ].map((entry) => ({ ...entry, ParentProcessId: 10, Name: "omp.exe", ExecutablePath: ompExe }));
      const runner = async (_command: string, args: string[]) => {
        const script = args[args.length - 1] ?? "";
        if (script.includes("Win32_Process")) return JSON.stringify(processes);
        if (script.includes("WinProcCwd")) return JSON.stringify({ "301": cwdA, "302": cwdA, "304": cwdA, "307": cwdD });
        return "";
      };

      const snapshot = await loadLiveSessionSnapshot({ platform: "win32", homeDir: home, now, runner });
      expect(snapshot.sessions).toEqual([
        { family: "omp", rawId: "01a00000-0000-7000-8000-00000000a001", pid: 301 },
        { family: "omp", rawId: "01a00000-0000-7000-8000-00000000a002", pid: 302 },
        { family: "omp", rawId: "01b00000-0000-7000-8000-00000000b001", pid: 304 },
        { family: "omp", rawId: "01c00000-0000-7000-8000-00000000c002", pid: 306 },
      ]);
      expect((await loadLiveSessionSnapshot({ platform: "win32", homeDir: home, now, runner, includeOmp: false })).sessions).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps a Bun-launched omp process on macOS through lsof cwd and its terminal breadcrumb", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-omp-live-mac-"));
    try {
      const home = path.join(root, "home");
      const cwd = path.join(root, "proj");
      const now = new Date("2026-11-27T14:30:00.000Z");
      const sessionFile = path.join(home, ".omp", "agent", "sessions", "--proj--", "2026-11-27T14-29-00-000Z_01e00000-0000-7000-8000-00000000e001.jsonl");
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, "");
      const breadcrumb = path.join(home, ".omp", "agent", "terminal-sessions", "ttys003");
      fs.mkdirSync(path.dirname(breadcrumb), { recursive: true });
      fs.writeFileSync(breadcrumb, `${cwd}\n${sessionFile}\n`);
      fs.utimesSync(breadcrumb, now, now);

      const snapshot = await loadLiveSessionSnapshot({
        platform: "darwin",
        homeDir: home,
        now,
        runner: async (command, args) => {
          if (command === "/bin/ps" && args[0] === "-axo") {
            return "412 /Users/me/.bun/bin/bun /Users/me/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts";
          }
          if (command === "/bin/ps") return "01:00";
          if (command === "lsof") return `bun 412 me cwd DIR 1,4 640 123 ${cwd}`;
          return "";
        },
      });
      expect(snapshot.sessions).toEqual([{ family: "omp", rawId: "01e00000-0000-7000-8000-00000000e001", pid: 412 }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
