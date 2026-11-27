import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createInMemoryStore } from "./postgres/test-session-store";
import {
  buildRemoteInteractiveSshArgs,
  buildRemoteSyncSshArgs,
  fetchRemoteSessionMessagePage,
  syncRemoteEnvironment,
} from "./remote-sync";
import type { SessionEnvironment } from "./types";

function decodeCollectorScript(command: string): string {
  const encoded = command.match(/b64decode\("([^"]+)"\)/)?.[1] ?? "";
  return inflateRawSync(Buffer.from(encoded, "base64")).toString("utf8");
}

function executePythonScript(
  script: string,
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number; args?: string[] } = {},
): string {
  const { args = [], maxBuffer = 128 * 1024 * 1024, env, ...execOptions } = options;
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env, PYTHONIOENCODING: "utf-8" };
  if (process.platform === "win32" && env?.HOME) {
    mergedEnv.USERPROFILE = env.HOME;
    mergedEnv.HOMEDRIVE = "";
    mergedEnv.HOMEPATH = env.HOME;
  }
  return execFileSync(process.platform === "win32" ? "python" : "python3", ["-", ...args], {
    ...execOptions,
    maxBuffer,
    env: mergedEnv,
    input: script,
    encoding: "utf8",
  });
}

describe("remote sync", () => {
  it("keeps polling visible after a successful WSL sync", async () => {
    const store = createInMemoryStore();
    const environment = await store.upsertEnvironment({
      id: "wsl-ubuntu",
      kind: "wsl",
      label: "WSL · Ubuntu",
      wslDistribution: "Ubuntu",
      enabled: true,
    });
    await store.updateEnvironmentSyncState(environment.id, "polling", { lastError: "temporary watcher failure" });
    try {
      await syncRemoteEnvironment(store, environment, { runSsh: async () => "" });
      await expect(store.getEnvironment(environment.id)).resolves.toMatchObject({ syncState: "polling", lastError: null });
    } finally {
      await store.close();
    }
  });

  it("separates interactive SSH PTY args from machine-readable sync args", () => {
    const environment = {
      id: "ssh:test",
      kind: "ssh",
      label: "test",
      hostAlias: "devbox",
      host: null,
      user: null,
      port: null,
      authMode: "none",
      identityFile: null,
      enabled: true,
    } as SessionEnvironment;
    expect(buildRemoteSyncSshArgs(environment, "echo ok")).not.toContain("-tt");
    const args = buildRemoteInteractiveSshArgs(environment, "echo ok");
    expect(args.filter((arg) => arg === "-tt")).toHaveLength(1);
    expect(args).not.toContain("BatchMode=yes");
    expect(args).toContain("ConnectTimeout=10");
    expect(args.indexOf("-tt")).toBeLessThan(args.indexOf("--"));
    expect(args.slice(args.indexOf("--"))).toEqual(["--", "devbox", "echo ok"]);

    const passwordArgs = buildRemoteInteractiveSshArgs({
      ...environment,
      hostAlias: null,
      host: "devbox.example.com",
      authMode: "password",
    }, "echo ok");
    expect(passwordArgs).toContain("PreferredAuthentications=password,keyboard-interactive");
    expect(passwordArgs).not.toContain("BatchMode=yes");
  });

  it("keeps Codex parent and child sessions distinct when a child rollout contains inherited parent metadata", async () => {
    const store = createInMemoryStore();
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-remote-codex-"));
    const parentId = "parent-session";
    const childId = "child-session";
    const guardianId = "guardian-review-session";
    const parentPath = path.join(tempHome, ".codex", "sessions", "2026", "08", "20", "parent.jsonl");
    const childPath = path.join(tempHome, ".codex", "sessions", "2026", "08", "20", "child.jsonl");
    const guardianPath = path.join(tempHome, ".codex", "sessions", "2026", "08", "20", "guardian.jsonl");
    const sessionIdOnlyPath = path.join(tempHome, ".codex", "sessions", "2026", "08", "20", "session-id-only.jsonl");
    const writeJsonl = (filePath: string, rows: unknown[]) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
    };

    try {
      writeJsonl(parentPath, [
        {
          type: "session_meta",
          timestamp: "2026-08-20T06:31:06.970Z",
          payload: { id: parentId, cwd: "/workspace/parent", source: "user" },
        },
        {
          type: "response_item",
          timestamp: "2026-08-20T06:32:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "parent question" }],
          },
        },
      ]);
      writeJsonl(childPath, [
        {
          type: "session_meta",
          timestamp: "2026-08-20T06:33:00.000Z",
          payload: {
            id: childId,
            session_id: parentId,
            forked_from_id: parentId,
            cwd: "<local-workspace>",
            thread_source: "subagent",
            parent_thread_id: parentId,
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: parentId,
                  depth: 1,
                },
              },
            },
          },
        },
        {
          type: "session_meta",
          timestamp: "2026-08-20T06:33:30.000Z",
          payload: {
            id: childId,
            session_id: parentId,
            cwd: "/workspace/child",
          },
        },
        {
          type: "session_meta",
          timestamp: "2026-08-20T06:31:06.970Z",
          payload: {
            id: parentId,
            session_id: parentId,
            cwd: "/workspace/parent",
            thread_source: "user",
            source: "user",
          },
        },
        {
          type: "response_item",
          timestamp: "2026-08-20T06:34:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "child task" }],
          },
        },
      ]);
      writeJsonl(sessionIdOnlyPath, [
        {
          type: "session_meta",
          timestamp: "2026-08-20T06:35:00.000Z",
          payload: {
            session_id: "semantic-session-id",
            cwd: "/workspace/legacy",
          },
        },
        {
          type: "response_item",
          timestamp: "2026-08-20T06:36:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "legacy identity question" }],
          },
        },
      ]);
      writeJsonl(guardianPath, [
        {
          type: "session_meta",
          timestamp: "2026-08-20T06:37:00.000Z",
          payload: {
            id: guardianId,
            cwd: "/workspace/parent",
            title: "Guardian review",
            source: { subagent: { other: "guardian" } },
          },
        },
      ]);
      fs.utimesSync(parentPath, new Date(2_000), new Date(2_000));
      fs.utimesSync(childPath, new Date(1_000), new Date(1_000));

      const environment = await store.upsertEnvironment({
        id: "ssh-devbox",
        kind: "ssh",
        label: "devbox",
        hostAlias: "devbox",
        host: "devbox.example.com",
        authMode: "none",
        enabled: true,
      });
      await syncRemoteEnvironment(store, environment, {
        runSsh: async (_environment, command) => executePythonScript(
          decodeCollectorScript(command),
          { env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome } },
        ),
      });

      await expect(store.getSession(`ssh:${environment.id}:codex-cli:${parentId}`)).resolves.toMatchObject({
        rawId: parentId,
        projectPath: "/workspace/parent",
        isSubagent: false,
        parentSessionId: null,
      });
      await expect(store.getSession(`ssh:${environment.id}:codex-cli:${childId}`)).resolves.toMatchObject({
        rawId: childId,
        projectPath: "/workspace/child",
        isSubagent: true,
        parentSessionId: parentId,
        timestamp: Date.parse("2026-08-20T06:33:00.000Z"),
      });
      await expect(store.getSession(`ssh:${environment.id}:codex-cli:session-id-only`)).resolves.toMatchObject({
        rawId: "session-id-only",
        projectPath: "/workspace/legacy",
      });
      await expect(store.getSession(`ssh:${environment.id}:codex-cli:semantic-session-id`)).resolves.toBeNull();
      await expect(store.getSession(`ssh:${environment.id}:codex-cli:${guardianId}`)).resolves.toBeNull();
      const rootSessions = await store.searchSessions({
        environmentId: environment.id,
        excludeSubagents: true,
      });
      expect(rootSessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ rawId: parentId }),
        expect.objectContaining({ rawId: "session-id-only" }),
      ]));
      expect(rootSessions).toHaveLength(2);
    } finally {
      await store.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps CodeWiz subagent sessions linked to their parent during remote collection", async () => {
    const store = createInMemoryStore();
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-remote-codewiz-"));
    const codewizDir = path.join(tempHome, ".local", "share", "codewiz");
    fs.mkdirSync(codewizDir, { recursive: true });
    const codewizDbPath = path.join(codewizDir, "opencode.db");
    executePythonScript(String.raw`
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript('''
CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, parent_id TEXT);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
''')
db.execute("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)", ("codewiz-parent", "/repo/codewiz", "CodeWiz parent", 1780560000000, 1780560600000))
db.execute("INSERT INTO session (id, directory, title, time_created, time_updated, parent_id) VALUES (?, ?, ?, ?, ?, ?)", ("codewiz-child", "/repo/codewiz", "CodeWiz child", 1780560000000, 1780560600000, "codewiz-parent"))
db.execute("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)", ("cw-user", "codewiz-parent", "user", 1780560060000, json.dumps({"role": "user"})))
db.execute("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)", ("cw-user-part", "cw-user", "codewiz-parent", 1780560060000, json.dumps({"type": "text", "text": "codewiz parent question"})))
db.execute("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)", ("cw-child-user", "codewiz-child", "user", 1780560060000, json.dumps({"role": "user"})))
db.execute("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)", ("cw-child-user-part", "cw-child-user", "codewiz-child", 1780560060000, json.dumps({"type": "text", "text": "codewiz child question"})))
db.commit()
db.close()
`, { args: [codewizDbPath] });

    try {
      const environment = await store.upsertEnvironment({
        id: "ssh-devbox",
        kind: "ssh",
        label: "devbox",
        hostAlias: "devbox",
        host: "devbox.example.com",
        authMode: "none",
        enabled: true,
      });
      await syncRemoteEnvironment(store, environment, {
        runSsh: async (_environment, command) => executePythonScript(
          decodeCollectorScript(command),
          { env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome } },
        ),
      });

      await expect(store.getSession(`ssh:${environment.id}:codewiz:codewiz-parent`)).resolves.toMatchObject({
        rawId: "codewiz-parent",
        isSubagent: false,
        parentSessionId: null,
      });
      await expect(store.getSession(`ssh:${environment.id}:codewiz:codewiz-child`)).resolves.toMatchObject({
        rawId: "codewiz-child",
        isSubagent: true,
        parentSessionId: "codewiz-parent",
      });
      const rootSessions = await store.searchSessions({
        environmentId: environment.id,
        excludeSubagents: true,
      });
      expect(rootSessions).toHaveLength(1);
      expect(rootSessions[0]?.rawId).toBe("codewiz-parent");
    } finally {
      await store.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 20_000);

  it("collects Qoder project sessions from the remote collector when Qoder is enabled", async () => {
    const store = createInMemoryStore();
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-remote-qoder-"));
    const projectDir = path.join(tempHome, ".qoder", "cache", "projects", "repo-qoder-1a2b3c4d");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "qoder-session.jsonl"), [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "qoder remote question" }] }, timestamp: "2026-06-04T08:01:00.000Z" }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "qoder remote answer" }] }, timestamp: "2026-06-04T08:01:05.000Z" }),
    ].join("\n"));

    try {
      const environment = await store.upsertEnvironment({
        id: "ssh-devbox",
        kind: "ssh",
        label: "devbox",
        hostAlias: "devbox",
        host: "devbox.example.com",
        authMode: "none",
        enabled: true,
      });
      await syncRemoteEnvironment(store, environment, {
        enabledOptionalSources: ["qoder"],
        runSsh: async (_environment, command) => executePythonScript(
          decodeCollectorScript(command),
          { env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome } },
        ),
      });

      const sessions = await store.searchSessions({ environmentId: environment.id });
      expect(sessions).toEqual([
        expect.objectContaining({ source: "qoder", firstQuestion: "qoder remote question" }),
      ]);
    } finally {
      await store.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 20_000);

  it("collects OpenCode sessions from the remote opencode.db with subagent relations", async () => {
    const store = createInMemoryStore();
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-remote-opencode-"));
    const opencodeDir = path.join(tempHome, ".local", "share", "opencode");
    fs.mkdirSync(opencodeDir, { recursive: true });
    const opencodeDbPath = path.join(opencodeDir, "opencode.db");
    executePythonScript(String.raw`
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript('''
CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, parent_id TEXT);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
''')
db.execute("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)", ("opencode-parent", "/repo/opencode", "OpenCode parent", 1780560000000, 1780560600000))
db.execute("INSERT INTO session (id, directory, title, time_created, time_updated, parent_id) VALUES (?, ?, ?, ?, ?, ?)", ("opencode-child", "/repo/opencode", "OpenCode child", 1780560000000, 1780560600000, "opencode-parent"))
db.execute("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)", ("oc-user", "opencode-parent", "user", 1780560060000, json.dumps({"role": "user"})))
db.execute("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)", ("oc-user-part", "oc-user", "opencode-parent", 1780560060000, json.dumps({"type": "text", "text": "opencode parent question"})))
db.execute("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)", ("oc-child-user", "opencode-child", "user", 1780560060000, json.dumps({"role": "user"})))
db.execute("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)", ("oc-child-user-part", "oc-child-user", "opencode-child", 1780560060000, json.dumps({"type": "text", "text": "opencode child question"})))
db.commit()
db.close()
`, { args: [opencodeDbPath] });

    try {
      const environment = await store.upsertEnvironment({
        id: "ssh-devbox",
        kind: "ssh",
        label: "devbox",
        hostAlias: "devbox",
        host: "devbox.example.com",
        authMode: "none",
        enabled: true,
      });
      await syncRemoteEnvironment(store, environment, {
        runSsh: async (_environment, command) => executePythonScript(
          decodeCollectorScript(command),
          { env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome } },
        ),
      });

      await expect(store.getSession(`ssh:${environment.id}:opencode-cli:opencode-parent`)).resolves.toMatchObject({
        rawId: "opencode-parent",
        source: "opencode-cli",
        isSubagent: false,
        parentSessionId: null,
      });
      await expect(store.getSession(`ssh:${environment.id}:opencode-cli:opencode-child`)).resolves.toMatchObject({
        rawId: "opencode-child",
        source: "opencode-cli",
        isSubagent: true,
        parentSessionId: "opencode-parent",
      });
      const rootSessions = await store.searchSessions({
        environmentId: environment.id,
        excludeSubagents: true,
      });
      expect(rootSessions).toHaveLength(1);
      expect(rootSessions[0]?.rawId).toBe("opencode-parent");
    } finally {
      await store.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 20_000);

  it("collects omp sessions over SSH and WSL only when enabled, keeping header ids and subagent links", async () => {
    const store = createInMemoryStore();
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-remote-omp-"));
    const parentId = "01a00000-0000-7000-8000-00000000a001";
    const childId = "01a00000-0000-7000-8000-00000000c001";
    const stem = `2026-11-27T14-03-03-110Z_${parentId}`;
    const bucket = path.join(tempHome, ".omp", "agent", "sessions", "--repo--");
    const writeJsonl = (filePath: string, rows: unknown[]) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
    };
    const message = (id: string, parent: string | null, role: string, text: string, extra: Record<string, unknown> = {}) => ({
      type: "message", id, parentId: parent, timestamp: "2026-11-27T14:03:04.000Z",
      message: { role, content: [{ type: "text", text }], ...extra },
    });
    writeJsonl(path.join(bucket, `${stem}.jsonl`), [
      { type: "title", v: 1, title: "Fix the build", source: "auto", updatedAt: "2026-11-27T14:05:00.000Z", pad: "   " },
      { type: "session", version: 3, id: parentId, timestamp: "2026-11-27T14:03:03.110Z", cwd: "/repo" },
      message("u1", null, "user", "first question"),
      message("a1", "u1", "assistant", "first answer", { usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 } }),
      message("u2a", "a1", "user", "abandoned branch"),
      message("u2b", "a1", "user", "second question"),
      { type: "model_usage", id: "mu1", parentId: "u2b", timestamp: "2026-11-27T14:03:06.000Z", usage: { input: 2, output: 1 } },
      message("a2b", "mu1", "assistant", "second answer"),
    ]);
    writeJsonl(path.join(bucket, stem, "AgentX.jsonl"), [
      { type: "session", version: 3, id: childId, timestamp: "2026-11-27T14:04:00.000Z", cwd: "/repo" },
      message("c1", null, "user", "child task"),
      message("c2", "c1", "assistant", "child done"),
    ]);
    // Spills in the artifacts folder are not sessions.
    writeJsonl(path.join(bucket, stem, "local", "spill.jsonl"), [{ line: 1 }]);
    const runSsh = async (_environment: SessionEnvironment, command: string) => executePythonScript(
      decodeCollectorScript(command),
      { env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome } },
    );

    try {
      const ssh = await store.upsertEnvironment({
        id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "devbox", host: "devbox.example.com", authMode: "none", enabled: true,
      });
      await syncRemoteEnvironment(store, ssh, { runSsh });
      await expect(store.getSession(`ssh:${ssh.id}:omp-cli:${parentId}`)).resolves.toBeNull();

      await syncRemoteEnvironment(store, ssh, { runSsh, enabledOptionalSources: ["omp-cli"] });
      const parent = await store.getSession(`ssh:${ssh.id}:omp-cli:${parentId}`);
      expect(parent).toMatchObject({
        rawId: parentId,
        source: "omp-cli",
        projectPath: "/repo",
        originalTitle: "Fix the build",
        timestamp: Date.parse("2026-11-27T14:03:03.110Z"),
        messageCount: 4,
        isSubagent: false,
      });
      await expect(store.getSession(`ssh:${ssh.id}:omp-cli:${childId}`)).resolves.toMatchObject({
        rawId: childId,
        isSubagent: true,
        parentSessionId: parentId,
      });
      const rootSessions = await store.searchSessions({ environmentId: ssh.id, excludeSubagents: true });
      expect(rootSessions.map((session) => session.rawId)).toEqual([parentId]);
      const page = await fetchRemoteSessionMessagePage(ssh, parent!, 0, 10, { runSsh });
      expect(page.map((item) => item.content)).toEqual(["first question", "first answer", "second question", "second answer"]);

      const wsl = await store.upsertEnvironment({
        id: "wsl-ubuntu", kind: "wsl", label: "WSL · Ubuntu", wslDistribution: "Ubuntu", enabled: true,
      });
      await syncRemoteEnvironment(store, wsl, { runSsh, enabledOptionalSources: ["omp-cli"] });
      await expect(store.getSession(`wsl:${wsl.id}:omp-cli:${parentId}`)).resolves.toMatchObject({ rawId: parentId, environmentKind: "wsl" });
      await expect(store.getSession(`wsl:${wsl.id}:omp-cli:${childId}`)).resolves.toMatchObject({ parentSessionId: parentId });
    } finally {
      await store.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);
});
