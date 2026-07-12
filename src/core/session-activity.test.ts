import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createCachedLiveSessionSnapshotLoader, detectLiveSessionsFromProcessLines, loadLiveSessionSnapshot } from "./session-activity";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync };

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
      runner: async (command, args) => {
        if (command === "/bin/ps" && args[0] === "-axo") return "424 /opt/homebrew/bin/claude code";
        if (command === "/bin/ps" && args.join(" ") === "-o lstart= -p 424") return "Wed Jul  8 21:00:00 2026";
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

    const sessionTimes = [
      ["claude-plain-one", "2026-07-09T23:01:00Z"],
      ["claude-plain-two", "2026-07-09T23:06:00Z"],
      ["claude-resumed", "2026-07-09T23:10:00Z"],
    ] as const;
    for (const [rawId, timestamp] of sessionTimes) {
      const filePath = path.join(projectDir, `${rawId}.jsonl`);
      fs.writeFileSync(filePath, `{"type":"mode","sessionId":"${rawId}"}\n`);
      fs.utimesSync(filePath, new Date(timestamp), new Date(timestamp));
    }

    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      homeDir: home,
      runner: async (command, args) => {
        if (command === "/bin/ps" && args[0] === "-axo") {
          return [
            "501 /opt/homebrew/bin/claude --resume claude-resumed",
            "502 /opt/homebrew/bin/claude",
            "503 /opt/homebrew/bin/claude",
          ].join("\n");
        }
        if (command === "/bin/ps" && args.join(" ") === "-o lstart= -p 502") return "Thu Jul  9 23:00:00 2026";
        if (command === "/bin/ps" && args.join(" ") === "-o lstart= -p 503") return "Thu Jul  9 23:05:00 2026";
        if (command === "lsof") {
          return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nclaude 500 user cwd DIR 1,4 0 1 ${cwd}\n`;
        }
        return "";
      },
    });

    expect(snapshot.sessions).toHaveLength(3);
    expect(snapshot.sessions.map((session) => session.rawId).sort()).toEqual([
      "claude-plain-one",
      "claude-plain-two",
      "claude-resumed",
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not inspect Codex Desktop app helper processes as CLI sessions", async () => {
    let lsofCalls = 0;
    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      runner: async (command, args) => {
        if (command === "/bin/ps") {
          return [
            "601 /Applications/Codex.app/Contents/MacOS/Codex",
            "602 /Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer",
            "603 /Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled",
            "604 /opt/homebrew/bin/codex",
            "605 node /opt/homebrew/bin/codex",
            "606 /Users/test/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
          ].join("\n");
        }
        if (command === "lsof") {
          lsofCalls++;
          expect(args).toEqual(["-p", "604"]);
          return "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\ncodex 604 user cwd DIR 1,4 0 1 /work/app\n";
        }
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([]);
    expect(lsofCalls).toBe(1);
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
});
