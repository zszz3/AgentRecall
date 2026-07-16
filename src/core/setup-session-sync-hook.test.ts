import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface SessionHookSetup {
  installSessionSyncHooks(options: { homeDir: string; scriptPath: string; nodePath?: string }): { status: string };
  uninstallSessionSyncHooks(options: { homeDir: string }): { status: string };
  sessionSyncHookStatus(options: { homeDir: string }): { installed: boolean; claude: boolean; codex: boolean };
}

const require = createRequire(import.meta.url);
const setup = require(path.resolve("bin", "setup-session-sync-hook.cjs")) as SessionHookSetup;

function freshHome(): string {
  const homeDir = path.join(tmpdir(), `session-sync-hook-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  return homeDir;
}

describe("session sync hook setup", () => {
  it("installs Claude and Codex Stop hooks without replacing existing configuration", () => {
    const homeDir = freshHome();
    const claudePath = path.join(homeDir, ".claude", "settings.json");
    const codexPath = path.join(homeDir, ".codex", "hooks.json");
    writeFileSync(claudePath, JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-claude" }] }] } }));
    writeFileSync(codexPath, JSON.stringify({ version: 1, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "keep-codex" }] }] } }));
    try {
      expect(setup.installSessionSyncHooks({ homeDir, scriptPath: "/opt/app/bin/session-sync-record.cjs" }).status).toBe("installed");

      const claude = JSON.parse(readFileSync(claudePath, "utf8"));
      expect(claude.theme).toBe("dark");
      expect(claude.hooks.Stop).toHaveLength(2);
      expect(claude.hooks.Stop[1].hooks[0]).toEqual({
        type: "command",
        command: 'node "/opt/app/bin/session-sync-record.cjs" --agent claude',
        async: true,
      });

      const codex = JSON.parse(readFileSync(codexPath, "utf8"));
      expect(codex.version).toBe(1);
      expect(codex.hooks.SessionStart).toHaveLength(1);
      expect(codex.hooks.Stop).toEqual([{ hooks: [{
        type: "command",
        command: 'node "/opt/app/bin/session-sync-record.cjs" --agent codex',
        timeout: 10,
        statusMessage: "Queueing session sync",
      }] }]);
      expect(setup.sessionSyncHookStatus({ homeDir })).toMatchObject({ installed: true, claude: true, codex: true });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("is idempotent and removes only AgentRecall hooks", () => {
    const homeDir = freshHome();
    const scriptPath = "/opt/app/bin/session-sync-record.cjs";
    try {
      expect(setup.installSessionSyncHooks({ homeDir, scriptPath }).status).toBe("installed");
      expect(setup.installSessionSyncHooks({ homeDir, scriptPath }).status).toBe("already");
      expect(setup.uninstallSessionSyncHooks({ homeDir }).status).toBe("removed");
      expect(setup.sessionSyncHookStatus({ homeDir })).toMatchObject({ installed: false, claude: false, codex: false });

      const claude = JSON.parse(readFileSync(path.join(homeDir, ".claude", "settings.json"), "utf8"));
      const codex = JSON.parse(readFileSync(path.join(homeDir, ".codex", "hooks.json"), "utf8"));
      expect(claude.hooks).toBeUndefined();
      expect(codex.hooks).toBeUndefined();
      expect(setup.uninstallSessionSyncHooks({ homeDir }).status).toBe("absent");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
