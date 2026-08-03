import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createCachedLiveSessionSnapshotLoader, detectLiveSessionsFromProcessLines, loadLiveSessionSnapshot } from "./session-activity";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync };
const MINUTE_MS = 60 * 1000;

describe("live session detection", () => {
  it("detects Codex, Claude, and CodeBuddy resume commands without matching unrelated commands", () => {
    expect(
      detectLiveSessionsFromProcessLines([
        "123 /opt/homebrew/bin/codex resume codex-1",
        '124 /opt/homebrew/bin/codex resume "codex two"',
        "125 /opt/homebrew/bin/claude --resume claude-1",
        "126 /opt/homebrew/bin/claude --resume=claude-2",
        "127 /tmp/session-search-fixtures/.codebuddy/bin/codebuddy --resume codebuddy-1",
        "128 rg codex resume ignored",
      ]),
    ).toEqual([
      { family: "codex", rawId: "codex-1", pid: 123 },
      { family: "codex", rawId: "codex two", pid: 124 },
      { family: "claude", rawId: "claude-1", pid: 125 },
      { family: "claude", rawId: "claude-2", pid: 126 },
      { family: "codebuddy", rawId: "codebuddy-1", pid: 127 },
    ]);
  });

  it("detects tclaude and tcodex resume commands with their own families and resume syntaxes", () => {
    expect(
      detectLiveSessionsFromProcessLines([
        "201 /Users/dev/.nvm/versions/node/v22/bin/tclaude --resume tclaude-1",
        "202 /Users/dev/.nvm/versions/node/v22/bin/tcodex resume tcodex-1",
      ]),
    ).toEqual([
      { family: "tclaude", rawId: "tclaude-1", pid: 201 },
      { family: "tcodex", rawId: "tcodex-1", pid: 202 },
    ]);
  });

  it("maps plain Codex and Claude processes through their open session files during the default live snapshot", async () => {
    const lsofCalls: string[][] = [];
    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      runner: async (command, args) => {
        if (command === "/bin/ps") return "223 /opt/homebrew/bin/codex\n224 /opt/homebrew/bin/claude";
        if (command === "lsof") {
          lsofCalls.push(args);
          if (args.join(" ") === "-p 223") {
            return "codex 223 user 10r REG 1,4 0 1 /tmp/.codex/sessions/2026/06/01/rollout-2026-06-01T19-11-30-019e82e1-b60d-7b12-95c3-d33e1d05f0a9.jsonl\n";
          }
          if (args.join(" ") === "-p 224") {
            return "claude 224 user 10r REG 1,4 0 1 /tmp/.claude/projects/-work-app/claude-live-1.jsonl\n";
          }
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([
      { family: "codex", rawId: "019e82e1-b60d-7b12-95c3-d33e1d05f0a9", pid: 223 },
      { family: "claude", rawId: "claude-live-1", pid: 224 },
    ]);
    expect(lsofCalls).toEqual([
      ["-p", "223"],
      ["-p", "224"],
    ]);
  });

  it("guards unresolved Windows CLI families and preserves backslashes in command paths", async () => {
    const snapshot = await loadLiveSessionSnapshot({
      platform: "win32",
      runner: async (command) => {
        expect(command).toBe("powershell.exe");
        return [
          '321 "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe"',
          '322 "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"',
        ].join("\n");
      },
    });

    expect(snapshot.sessions).toEqual([
      { family: "claude", rawId: "*", pid: 321 },
      { family: "codex", rawId: "*", pid: 322 },
    ]);
  });

  it("maps a plain running Codex process through its open session file", () => {
    expect(
      detectLiveSessionsFromProcessLines(
        [
          "223 node /opt/homebrew/bin/codex",
          "224 /opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex",
          "225 /Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://",
        ],
        new Map([
          [
            224,
            "/tmp/session-search-fixtures/.codex/sessions/2026/06/01/rollout-2026-06-01T19-11-30-019e82e1-b60d-7b12-95c3-d33e1d05f0a9.jsonl",
          ],
        ]),
      ),
    ).toEqual([{ family: "codex", rawId: "019e82e1-b60d-7b12-95c3-d33e1d05f0a9", pid: 224 }]);
  });

  it("maps a plain Codex process to the active session when it keeps completed session files open", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-open-"));
    const sessionDir = path.join(root, ".codex", "sessions", "2026", "07", "31");
    const completedFile = path.join(
      sessionDir,
      "rollout-2026-07-31T10-00-00-11111111-1111-4111-8111-111111111111.jsonl",
    );
    const activeFile = path.join(
      sessionDir,
      "rollout-2026-07-31T10-01-00-22222222-2222-4222-8222-222222222222.jsonl",
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(completedFile, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    fs.writeFileSync(activeFile, '{"type":"event_msg","payload":{"type":"task_started"}}\n');

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      now: new Date(),
      runner: async (command) => {
        if (command === "/bin/ps") return "223 /opt/homebrew/bin/codex";
        if (command === "lsof") return `${completedFile}\n${activeFile}\n`;
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([
      { family: "codex", rawId: "22222222-2222-4222-8222-222222222222", pid: 223 },
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not treat Codex helper processes as independent sessions", () => {
    expect(
      detectLiveSessionsFromProcessLines(
        ["225 /opt/lib/node_modules/@openai/codex/vendor/bin/codex-code-mode-host"],
        new Map([
          [
            225,
            "/tmp/.codex/sessions/2026/07/31/rollout-2026-07-31T10-00-00-33333333-3333-4333-8333-333333333333.jsonl",
          ],
        ]),
      ),
    ).toEqual([]);
  });

  it("maps a plain running Claude process through its open session file", () => {
    expect(
      detectLiveSessionsFromProcessLines(
        [
          "323 node /opt/homebrew/bin/claude",
          "324 /opt/homebrew/bin/claude",
          "325 /opt/homebrew/bin/claude --resume claude-resumed",
        ],
        new Map(),
        new Map([[324, "/tmp/session-search-fixtures/.claude/projects/-work-app/claude-live-1.jsonl"]]),
      ),
    ).toEqual([
      { family: "claude", rawId: "claude-live-1", pid: 324 },
      { family: "claude", rawId: "claude-resumed", pid: 325 },
    ]);
  });

  it("infers a plain running Claude session from its cwd when lsof does not expose the session file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-live-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "work app");
    const projectDir = path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
    const sessionFile = path.join(projectDir, "claude-inferred-1.jsonl");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(sessionFile, '{"type":"mode","sessionId":"claude-inferred-1"}\n');
    fs.utimesSync(sessionFile, new Date("2026-07-09T23:00:00Z"), new Date("2026-07-09T23:00:00Z"));

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      homeDir: home,
      now: new Date("2026-07-09T23:30:00Z"),
      runner: async (command, args) => {
        if (command === "/bin/ps" && args[0] === "-axo") return "424 /opt/homebrew/bin/claude code";
        if (command === "/bin/ps" && args.join(" ") === "-o etime= -p 424") return "1-02:30:00";
        if (command === "lsof" && args.join(" ") === "-p 424") {
          return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nclaude 424 user cwd DIR 1,4 0 1 ${cwd}\n`;
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([{ family: "claude", rawId: "claude-inferred-1", pid: 424 }]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps concurrent Claude sessions in the same cwd uniquely mapped", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-concurrent-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "work app");
    const projectDir = path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
    fs.mkdirSync(projectDir, { recursive: true });

    // Stamping each session ahead of its own creation keeps the recorded creation time
    // identical on every filesystem: macOS pulls creation back to an earlier mtime,
    // while Linux and Windows leave it untouched. The pairing below therefore depends
    // only on the modification times this fixture controls.
    const baseMs = Date.now();
    const sessionOffsetMinutes = [
      ["claude-plain-one", 20],
      ["claude-plain-two", 31],
      ["claude-resumed", 40],
    ] as const;
    for (const [rawId, offsetMinutes] of sessionOffsetMinutes) {
      const filePath = path.join(projectDir, `${rawId}.jsonl`);
      fs.writeFileSync(filePath, `{"type":"mode","sessionId":"${rawId}"}\n`);
      const stamp = new Date(baseMs + offsetMinutes * MINUTE_MS);
      fs.utimesSync(filePath, stamp, stamp);
    }

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      homeDir: home,
      now: new Date(baseMs + 60 * MINUTE_MS),
      runner: async (command, args) => {
        if (command === "/bin/ps" && args[0] === "-axo") {
          return [
            "501 /opt/homebrew/bin/claude --resume claude-resumed",
            "502 /opt/homebrew/bin/claude",
            "503 /opt/homebrew/bin/claude",
          ].join("\n");
        }
        // 502 started when claude-plain-one was last written, 503 when claude-plain-two was.
        if (command === "/bin/ps" && args.join(" ") === "-o etime= -p 502") return "40:00";
        if (command === "/bin/ps" && args.join(" ") === "-o etime= -p 503") return "30:00";
        if (command === "lsof") {
          return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nclaude 500 user cwd DIR 1,4 0 1 ${cwd}\n`;
        }
        return "";
      },
    });

    // Each plain process must own the session written closest to its own start time.
    // Asserting the pairing rather than the set keeps a permuted mapping from passing.
    expect(snapshot.sessions).toEqual([
      { family: "claude", rawId: "claude-resumed", pid: 501 },
      { family: "claude", rawId: "claude-plain-one", pid: 502 },
      { family: "claude", rawId: "claude-plain-two", pid: 503 },
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads the process elapsed time independently of the system locale", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-elapsed-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "work app");
    const projectDir = path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
    const sessionFile = path.join(projectDir, "claude-existing-session.jsonl");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(sessionFile, '{"type":"mode","sessionId":"claude-existing-session"}\n');
    const baseMs = Date.now();
    const stamp = new Date(baseMs + 20 * MINUTE_MS);
    fs.utimesSync(sessionFile, stamp, stamp);

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      homeDir: home,
      now: new Date(baseMs + 60 * MINUTE_MS),
      runner: async (command, args) => {
        if (command === "/bin/ps" && args[0] === "-axo") {
          return ["601 /opt/homebrew/bin/claude", "602 /opt/homebrew/bin/claude"].join("\n");
        }
        // 601 started after the session was last written, 602 a day before it existed.
        // The day-prefixed form also covers the `dd-hh:mm:ss` variant of the format.
        if (command === "/bin/ps" && args.join(" ") === "-o etime= -p 601") return "05:00";
        if (command === "/bin/ps" && args.join(" ") === "-o etime= -p 602") return "1-00:35:00";
        if (command === "lsof") {
          return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nclaude 600 user cwd DIR 1,4 0 1 ${cwd}\n`;
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([
      { family: "claude", rawId: "claude-existing-session", pid: 602 },
      { family: "claude", rawId: "*", pid: 601 },
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("maps only recently active Codex Desktop sessions whose agents have unfinished tasks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-app-live-"));
    const now = new Date("2026-07-28T12:00:00.000Z");
    const sessionsDir = path.join(root, "Test User", ".codex", "sessions", "2026", "07", "27");
    const firstSessionId = "019e82e1-b60d-7b12-95c3-d33e1d05f0a9";
    const secondSessionId = "019e82e1-b60d-7b12-95c3-d33e1d05f0b0";
    const thirdSessionId = "019e82e1-b60d-7b12-95c3-d33e1d05f0b1";
    const fourthSessionId = "019e82e1-b60d-7b12-95c3-d33e1d05f0b2";
    const fifthSessionId = "019e82e1-b60d-7b12-95c3-d33e1d05f0b3";
    const firstSessionFile = path.join(sessionsDir, `rollout-2026-07-27T10-00-00-${firstSessionId}.jsonl`);
    const secondSessionFile = path.join(sessionsDir, `rollout-2026-07-27T10-05-00-${secondSessionId}.jsonl`);
    const thirdSessionFile = path.join(sessionsDir, `rollout-2026-07-27T10-10-00-${thirdSessionId}.jsonl`);
    const fourthSessionFile = path.join(sessionsDir, `rollout-2026-07-27T10-15-00-${fourthSessionId}.jsonl`);
    const fifthSessionFile = path.join(sessionsDir, `rollout-2026-07-27T10-20-00-${fifthSessionId}.jsonl`);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(firstSessionFile, [
      JSON.stringify({ type: "session_meta", payload: { id: firstSessionId } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", content: `${"x".repeat(70_000)} mentions "type":"task_complete" without completing` },
      }),
    ].join("\n") + "\n");
    fs.writeFileSync(secondSessionFile, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "完成".repeat(35_000) } }),
    ].join("\n") + "\n");
    fs.writeFileSync(thirdSessionFile, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    fs.writeFileSync(fourthSessionFile, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted" } }),
    ].join("\n") + "\n");
    fs.writeFileSync(fifthSessionFile, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const activeModifiedAt = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    const staleModifiedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    for (const sessionFile of [firstSessionFile, secondSessionFile, thirdSessionFile, fourthSessionFile]) {
      fs.utimesSync(sessionFile, activeModifiedAt, activeModifiedAt);
    }
    fs.utimesSync(fifthSessionFile, staleModifiedAt, staleModifiedAt);
    const lsofCalls: string[] = [];
    try {
      const snapshot = await loadLiveSessionSnapshot({
        platform: "darwin",
        runner: async (command, args) => {
          if (command === "/bin/ps") {
            return [
              "601 /Applications/Codex.app/Contents/MacOS/Codex",
              "602 /Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer",
              "603 /Applications/Codex.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
              "604 /opt/homebrew/bin/codex",
              "605 node /opt/homebrew/bin/codex",
              "606 /Users/test/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
            ].join("\n");
          }
          if (command === "lsof") {
            lsofCalls.push(args.join(" "));
            if (args.join(" ") === "-p 603") {
              return [
                "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
                `codex 603 user 21u REG 1,4 0 1 ${firstSessionFile}`,
                `codex 603 user 44u REG 1,4 0 1 ${secondSessionFile}`,
                `codex 603 user 47u REG 1,4 0 1 ${thirdSessionFile}`,
                `codex 603 user 48u REG 1,4 0 1 ${thirdSessionFile}`,
                `codex 603 user 49u REG 1,4 0 1 ${fourthSessionFile}`,
                `codex 603 user 50u REG 1,4 0 1 ${fifthSessionFile}`,
              ].join("\n");
            }
            return "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n";
          }
          return "";
        },
        now,
      });

      expect(snapshot.sessions).toEqual([
        { family: "codex", rawId: firstSessionId, pid: 603 },
        { family: "codex", rawId: thirdSessionId, pid: 603 },
        { family: "codex", rawId: "*", pid: 604 },
      ]);
      expect(lsofCalls.sort()).toEqual(["-p 603", "-p 604"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps a running Trae app process through its workspace state database", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-trae-live-"));
    const dbPath = path.join(root, "User", "workspaceStorage", "abc", "state.vscdb");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "memento/icube-ai-agent-storage",
      JSON.stringify({ currentSessionId: "trae-session-1" }),
    );
    db.close();

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      runner: async (command, args) => {
        if (command === "/bin/ps") {
          return "3456 /Applications/Trae CN.app/Contents/MacOS/Electron --user-data-dir=/tmp/Trae CN";
        }
        if (command === "lsof" && args.join(" ") === "-p 3456") {
          return `Electron 3456 user  txt REG 1,4 0 1 ${dbPath}\n`;
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([{ family: "trae", rawId: "session_memory_trae-session-1", pid: 3456 }]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips Trae workspace inspection when Trae monitoring is disabled", async () => {
    let lsofCalls = 0;
    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      includeTrae: false,
      runner: async (command) => {
        if (command === "/bin/ps") return "3456 /Applications/Trae CN.app/Contents/MacOS/Electron --user-data-dir=/tmp/Trae CN";
        if (command === "lsof") lsofCalls++;
        throw new Error("Trae lsof should not run");
      },
    });

    expect(snapshot).toMatchObject({ sessions: [] });
    expect(snapshot.error).toBeUndefined();
    expect(lsofCalls).toBe(0);
  });

  it("detects a running Qoder app session from lsof-extracted rawId", () => {
    expect(
      detectLiveSessionsFromProcessLines(
        ["4567 /Applications/Qoder.app/Contents/MacOS/Qoder --user-data-dir /tmp/qoder-data"],
        new Map(),
        new Map(),
        new Map(),
        new Map([[4567, "demo-app-1a2b3c4d/task-fe3"]]),
      ),
    ).toEqual([{ family: "qoder", rawId: "demo-app-1a2b3c4d/task-fe3", pid: 4567 }]);
  });

  it("detects a running Qoder session from lsof open file paths", async () => {
    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      includeTrae: false,
      includeQoder: true,
      runner: async (command, args) => {
        if (command === "/bin/ps") return "4567 /Applications/Qoder.app/Contents/MacOS/Qoder --user-data-dir /tmp/qoder-data";
        if (command === "lsof" && args[0] === "-p" && args[1] === "4567") {
          return "qoder  4567 user  txt REG 1,4 0 1 /home/me/.qoder/cache/projects/demo-app-1a2b3c4d/conversation-history/task-fe3/task-fe3.jsonl\n";
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([{ family: "qoder", rawId: "demo-app-1a2b3c4d/task-fe3", pid: 4567 }]);
  });

  it("skips Qoder detection when includeQoder is false", async () => {
    let lsofCalls = 0;
    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      includeTrae: false,
      includeQoder: false,
      runner: async (command) => {
        if (command === "/bin/ps") return "4567 /Applications/Qoder.app/Contents/MacOS/Qoder --user-data-dir /tmp/qoder-data";
        if (command === "lsof") lsofCalls++;
        throw new Error("Qoder lsof should not run");
      },
    });

    expect(snapshot).toMatchObject({ sessions: [] });
    expect(snapshot.error).toBeUndefined();
    expect(lsofCalls).toBe(0);
  });

  it("detects openclaw and cursor-agent resume commands", () => {
    expect(
      detectLiveSessionsFromProcessLines([
        "301 /opt/homebrew/bin/openclaw --resume openclaw-1",
        "302 /opt/homebrew/bin/openclaw --resume=openclaw-2",
        "303 /opt/homebrew/bin/cursor-agent --resume cursor-1",
        "304 /opt/homebrew/bin/cursor-agent --resume=cursor-2",
      ]),
    ).toEqual([
      { family: "openclaw", rawId: "openclaw-1", pid: 301 },
      { family: "openclaw", rawId: "openclaw-2", pid: 302 },
      { family: "cursor", rawId: "cursor-1", pid: 303 },
      { family: "cursor", rawId: "cursor-2", pid: 304 },
    ]);
  });

  it("maps plain openclaw, cursor, and codebuddy processes through their open files", async () => {
    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      includeTrae: false,
      includeQoder: false,
      runner: async (command, args) => {
        if (command === "/bin/ps") {
          return [
            "401 /opt/homebrew/bin/openclaw",
            "402 /opt/homebrew/bin/cursor-agent",
            "403 node /opt/homebrew/bin/codebuddy --add-dir /work -y",
          ].join("\n");
        }
        if (command === "lsof" && args.join(" ") === "-p 401") {
          return "openclaw 401 user 10r REG 1,4 0 1 /tmp/.openclaw/agents/main/sessions/openclaw-live-1.jsonl\n";
        }
        if (command === "lsof" && args.join(" ") === "-p 402") {
          return "cursor-agent 402 user 10r REG 1,4 0 1 /tmp/.cursor/projects/Users-me-repo/agent-transcripts/cursor-live-1/cursor-live-1.jsonl\n";
        }
        if (command === "lsof" && args.join(" ") === "-p 403") {
          return "codebuddy 403 user 24w REG 1,4 0 1 /Users/me/.codebuddy/projects/Users-me-work/1122eaf5-be65-4fe7-81a4-d3b751a788c5/tool-results/Bash_1.txt\n";
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([
      { family: "openclaw", rawId: "openclaw-live-1", pid: 401 },
      { family: "cursor", rawId: "cursor-live-1", pid: 402 },
      { family: "codebuddy", rawId: "1122eaf5-be65-4fe7-81a4-d3b751a788c5", pid: 403 },
    ]);
  });

  it("infers a codebuddy session from cwd when lsof hides the tool-results file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-live-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "work app");
    const projectDir = path.join(home, ".codebuddy", "projects", cwd.replace(/^\/+/, "").replace(/\//g, "-"));
    const sessionId = "1122eaf5-be65-4fe7-81a4-d3b751a788c5";
    const toolResultsDir = path.join(projectDir, sessionId, "tool-results");
    fs.mkdirSync(toolResultsDir, { recursive: true });

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      homeDir: home,
      includeTrae: false,
      includeQoder: false,
      includeCodeWiz: false,
      runner: async (command, args) => {
        if (command === "/bin/ps") return "403 node /opt/homebrew/bin/codebuddy --add-dir /work -y";
        if (command === "lsof" && args.join(" ") === "-p 403") {
          // Simulates Electron main / restricted environments where lsof cannot see
          // another process's open regular files, only its cwd.
          return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\ncodebuddy 403 user cwd DIR 1,4 0 1 ${cwd}\n`;
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([{ family: "codebuddy", rawId: sessionId, pid: 403 }]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("infers a codex session from cwd when lsof hides the session file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-live-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "work app");
    const sessionsDir = path.join(home, ".codex", "sessions", "2026", "07", "24");
    const sessionId = "019e82e1-b60d-7b12-95c3-d33e1d05f0a9";
    const sessionFile = path.join(sessionsDir, `rollout-2026-07-24T12-00-00-${sessionId}.jsonl`);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } }) + "\n",
    );
    fs.utimesSync(sessionFile, new Date("2026-07-24T12:00:00Z"), new Date("2026-07-24T12:00:00Z"));

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      homeDir: home,
      includeTrae: false,
      includeQoder: false,
      includeOpenClaw: false,
      includeCursor: false,
      includeCodeBuddy: false,
      runner: async (command, args) => {
        if (command === "/bin/ps") return "404 /opt/homebrew/bin/codex";
        if (command === "lsof" && args.join(" ") === "-p 404") {
          return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\ncodex 404 user cwd DIR 1,4 0 1 ${cwd}\n`;
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([{ family: "codex", rawId: sessionId, pid: 404 }]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("infers a cursor session from cwd when lsof hides the session file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-cursor-live-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "work app");
    const slug = cwd.replace(/^\/+/, "").replace(/\//g, "-").replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const sessionId = "cursor-live-1";
    const sessionFile = path.join(home, ".cursor", "projects", slug, "agent-transcripts", sessionId, `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n");
    fs.utimesSync(sessionFile, new Date("2026-07-24T12:00:00Z"), new Date("2026-07-24T12:00:00Z"));

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      homeDir: home,
      includeTrae: false,
      includeQoder: false,
      includeOpenClaw: false,
      includeCodeBuddy: false,
      runner: async (command, args) => {
        if (command === "/bin/ps") return "405 /opt/homebrew/bin/cursor-agent";
        if (command === "lsof" && args.join(" ") === "-p 405") {
          return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\ncursor-agent 405 user cwd DIR 1,4 0 1 ${cwd}\n`;
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([{ family: "cursor", rawId: sessionId, pid: 405 }]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("detects a running hermes session from its state database", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-hermes-live-"));
    const dbPath = path.join(root, ".hermes", "state.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at TEXT)");
    db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run("hermes-live-1", "2026-07-10T00:00:00Z");
    db.close();

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      includeTrae: false,
      includeQoder: false,
      includeOpenClaw: false,
      includeCursor: false,
      runner: async (command, args) => {
        if (command === "/bin/ps") return "501 /opt/homebrew/bin/hermes";
        if (command === "lsof" && args.join(" ") === "-p 501") {
          return `hermes 501 user 10r REG 1,4 0 1 ${dbPath}\n`;
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([{ family: "hermes", rawId: "hermes-live-1", pid: 501 }]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("detects a running opencode session from its database", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-opencode-live-"));
    const dbPath = path.join(root, ".local", "share", "opencode", "opencode.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, time_created TEXT, time_updated TEXT)");
    db.prepare("INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)").run(
      "opencode-live-1",
      "2026-07-10T00:00:00Z",
      "2026-07-10T01:00:00Z",
    );
    db.close();

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      includeTrae: false,
      includeQoder: false,
      includeOpenClaw: false,
      includeCursor: false,
      runner: async (command, args) => {
        if (command === "/bin/ps") return "601 /opt/homebrew/bin/opencode";
        if (command === "lsof" && args.join(" ") === "-p 601") {
          return `opencode 601 user 10r REG 1,4 0 1 ${dbPath}\n`;
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([{ family: "opencode", rawId: "opencode-live-1", pid: 601 }]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("detects a running zcode session from its database", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-zcode-live-"));
    const dbPath = path.join(root, ".zcode", "cli", "db", "db.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, time_created TEXT, time_updated TEXT)");
    db.prepare("INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)").run(
      "zcode-live-1",
      "2026-07-10T00:00:00Z",
      "2026-07-10T01:00:00Z",
    );
    db.close();

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      includeTrae: false,
      includeQoder: false,
      includeOpenClaw: false,
      includeCursor: false,
      runner: async (command, args) => {
        if (command === "/bin/ps") return "701 /opt/homebrew/bin/zcode";
        if (command === "lsof" && args.join(" ") === "-p 701") {
          return `zcode 701 user 10r REG 1,4 0 1 ${dbPath}\n`;
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([{ family: "zcode", rawId: "zcode-live-1", pid: 701 }]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips extra source detection when disabled", async () => {
    let lsofCalls = 0;
    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      includeTrae: false,
      includeQoder: false,
      includeOpenClaw: false,
      includeCursor: false,
      includeHermes: false,
      includeOpenCode: false,
      includeZcode: false,
      includeCodeBuddy: false,
      includeCodeWiz: false,
      runner: async (command) => {
        if (command === "/bin/ps") {
          return [
            "801 /opt/homebrew/bin/openclaw",
            "802 /opt/homebrew/bin/cursor-agent",
            "803 /opt/homebrew/bin/hermes",
            "804 /opt/homebrew/bin/opencode",
            "805 /opt/homebrew/bin/zcode",
          ].join("\n");
        }
        if (command === "lsof") lsofCalls++;
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([]);
    expect(lsofCalls).toBe(0);
  });

  it("reuses concurrent live session snapshot loads for the same options", async () => {
    let calls = 0;
    let resolveLoad: (value: Awaited<ReturnType<typeof loadLiveSessionSnapshot>>) => void = () => {
      throw new Error("resolveLoad was not initialized.");
    };
    const pending = new Promise<Awaited<ReturnType<typeof loadLiveSessionSnapshot>>>((resolve) => {
      resolveLoad = resolve;
    });
    const load = async () => {
      calls += 1;
      return pending;
    };
    const cached = createCachedLiveSessionSnapshotLoader({ load, ttlMs: 5000, nowMs: () => 1000 });

    const first = cached({ includeTrae: false });
    const second = cached({ includeTrae: false });
    resolveLoad({ generatedAt: "2026-07-06T00:00:00.000Z", sessions: [] });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(calls).toBe(1);
  });

  it("serves cached live session snapshots within the ttl and refreshes after expiry", async () => {
    let calls = 0;
    let now = 1000;
    const load = async () => {
      calls += 1;
      return { generatedAt: `snapshot-${calls}`, sessions: [] };
    };
    const cached = createCachedLiveSessionSnapshotLoader({ load, ttlMs: 5000, nowMs: () => now });

    await expect(cached({ includeTrae: false })).resolves.toMatchObject({ generatedAt: "snapshot-1" });
    await expect(cached({ includeTrae: false })).resolves.toMatchObject({ generatedAt: "snapshot-1" });
    expect(calls).toBe(1);

    now += 5001;
    await expect(cached({ includeTrae: false })).resolves.toMatchObject({ generatedAt: "snapshot-2" });
    expect(calls).toBe(2);
  });

  it("bypasses the live session cache for deletion preflight", async () => {
    let calls = 0;
    const load = async () => ({ generatedAt: `snapshot-${++calls}`, sessions: [] });
    const cached = createCachedLiveSessionSnapshotLoader({ load, ttlMs: 5000, nowMs: () => 1000 });

    await expect(cached()).resolves.toMatchObject({ generatedAt: "snapshot-1" });
    await expect(cached({ fresh: true })).resolves.toMatchObject({ generatedAt: "snapshot-2" });
    await expect(cached()).resolves.toMatchObject({ generatedAt: "snapshot-1" });
    expect(calls).toBe(2);
  });
});
