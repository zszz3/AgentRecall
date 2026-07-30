import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadRemoteLiveSessions } from "./remote-session-activity";
import type { SessionEnvironment } from "./types";

function environment(overrides: Partial<SessionEnvironment> = {}): SessionEnvironment {
  return {
    id: "ssh-devbox",
    kind: "ssh",
    label: "devbox",
    hostAlias: "devbox",
    host: null,
    user: null,
    port: null,
    authMode: "none",
    identityFile: null,
    enabled: true,
    syncState: "watching",
    lastSyncedAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("remote live session detection", () => {
  it("queries enabled SSH environments and isolates malformed or failed responses", async () => {
    const runner = vi.fn(async (remoteEnvironment: SessionEnvironment) => {
      if (remoteEnvironment.id === "ssh-broken") throw new Error("offline");
      return [
        '{"family":"codex","rawId":"remote-codex","pid":42}',
        '{"family":"codex","rawId":"remote-codex","pid":42}',
        '{"family":"claude","rawId":"ignored","pid":43}',
        "not-json",
      ].join("\n");
    });

    const sessions = await loadRemoteLiveSessions([
      environment(),
      environment({ id: "ssh-disabled", enabled: false }),
      environment({ id: "local", kind: "local", hostAlias: null }),
      environment({ id: "ssh-broken" }),
    ], runner);

    expect(runner.mock.calls.map(([remoteEnvironment]) => remoteEnvironment.id)).toEqual(["ssh-devbox", "ssh-broken"]);
    expect(sessions).toEqual([
      { family: "codex", rawId: "remote-codex", pid: 42, environmentId: "ssh-devbox" },
    ]);
  });

  it.skipIf(process.platform === "win32")("detects active Codex App sessions from a synthetic remote process tree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-remote-live-"));
    const home = path.join(root, "home");
    const procRoot = path.join(root, "proc");
    const sessionsDir = path.join(home, ".codex", "sessions", "2026", "07", "29");
    const activeId = "019fad24-234a-7013-bbd3-662513771e3d";
    const completeId = "019fad24-234a-7013-bbd3-662513771e3e";
    const abortedId = "019fad24-234a-7013-bbd3-662513771e3f";
    const staleId = "019fad24-234a-7013-bbd3-662513771e40";
    fs.mkdirSync(sessionsDir, { recursive: true });

    const activeFile = path.join(sessionsDir, `rollout-active-${activeId}.jsonl`);
    const completeFile = path.join(sessionsDir, `rollout-complete-${completeId}.jsonl`);
    const abortedFile = path.join(sessionsDir, `rollout-aborted-${abortedId}.jsonl`);
    const staleFile = path.join(sessionsDir, `rollout-stale-${staleId}.jsonl`);
    fs.writeFileSync(activeFile, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "response_item", payload: { text: `${"x".repeat(70_000)} task_complete` } }),
    ].join("\n") + "\n");
    fs.writeFileSync(completeFile, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ].join("\n") + "\n");
    fs.writeFileSync(abortedFile, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted" } }),
    ].join("\n") + "\n");
    fs.writeFileSync(staleFile, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n");
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(staleFile, staleTime, staleTime);

    const appServerProc = path.join(procRoot, "701");
    const resumeProc = path.join(procRoot, "702");
    fs.mkdirSync(path.join(appServerProc, "fd"), { recursive: true });
    fs.mkdirSync(path.join(resumeProc, "fd"), { recursive: true });
    fs.writeFileSync(
      path.join(appServerProc, "cmdline"),
      Buffer.from("/usr/bin/node\0/usr/bin/codex\0-c\0features.code_mode_host=true\0app-server\0--listen\0unix://\0"),
    );
    fs.writeFileSync(path.join(resumeProc, "cmdline"), Buffer.from("/usr/bin/codex\0resume\0remote-resume-id\0"));
    for (const [index, sessionFile] of [activeFile, completeFile, abortedFile, staleFile].entries()) {
      fs.symlinkSync(sessionFile, path.join(appServerProc, "fd", String(index + 10)));
    }

    try {
      const sessions = await loadRemoteLiveSessions([environment()], (_remoteEnvironment, remoteCommand) =>
        executeRemoteCommand(remoteCommand, { HOME: home, AGENT_RECALL_PROC_ROOT: procRoot }));

      expect(sessions).toEqual([
        { family: "codex", rawId: activeId, pid: 701, environmentId: "ssh-devbox" },
        { family: "codex", rawId: "remote-resume-id", pid: 702, environmentId: "ssh-devbox" },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function executeRemoteCommand(remoteCommand: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("sh", ["-lc", remoteCommand], { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
