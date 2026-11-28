import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { IslandTaskStore, LocalSessionActivityMonitor, type IslandSignalEvent } from "./island-monitor";

function zstdFrame(lines: unknown[]): Buffer {
  const payload = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  return zlib.zstdCompressSync(Buffer.from(payload, "utf8"));
}

describe("IslandTaskStore", () => {
  it("tracks running to completed transitions, computes duration and alerts once", () => {
    let clock = 1_000;
    const store = new IslandTaskStore({
      enabled: true,
      soundEnabled: true,
      suppressWhenFocused: true,
      autoCollapseSeconds: 6,
    }, () => clock);

    const started = store.ingest({
      source: "deepseek-cli",
      sessionId: "sess-1",
      status: "running",
      signalSource: "log",
      projectPath: "/tmp/agentrecall",
      title: "修复测试",
      activeTool: "bash",
    });
    expect(started.alertedTask).toBeNull();
    expect(started.snapshot.tasks).toHaveLength(1);
    expect(started.snapshot.tasks[0]?.status).toBe("running");
    expect(started.snapshot.tasks[0]?.appKind).toBe("desktop");

    clock = 16_000;
    const done = store.ingest({
      source: "deepseek-cli",
      sessionId: "sess-1",
      status: "completed",
      signalSource: "log",
      summary: "所有测试已通过",
    });
    expect(done.alertedTask?.id).toBe("deepseek-cli:sess-1");
    expect(done.alertedTask?.durationMs).toBe(15_000);
    expect(done.alertedTask?.unread).toBe(true);
    expect(done.snapshot.highlightedTaskId).toBe("deepseek-cli:sess-1");

    // Repeated terminal signal within dedupe window does not re-trigger alert.
    clock = 18_000;
    const duplicate = store.ingest({
      source: "deepseek-cli",
      sessionId: "sess-1",
      status: "completed",
      signalSource: "gateway",
      summary: "所有测试已通过",
    });
    expect(duplicate.alertedTask).toBeNull();
  });

  it("suppresses alert expansion when muted or frontmost suppression is requested", () => {
    const store = new IslandTaskStore({
      enabled: true,
      soundEnabled: true,
      suppressWhenFocused: true,
      autoCollapseSeconds: 6,
    });

    const suppressed = store.ingest({
      source: "deepseek-cli",
      sessionId: "sess-2",
      status: "completed",
      signalSource: "log",
      summary: "完成",
    }, { suppressAlert: true });
    expect(suppressed.alertedTask).toBeNull();
    expect(suppressed.snapshot.highlightedTaskId).toBeNull();
    expect(suppressed.snapshot.tasks[0]?.status).toBe("completed");
  });
});

describe("LocalSessionActivityMonitor", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  });

  it("baselines existing DeepSeek Harness logs on first scan and alerts only on new replies", async () => {
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "island-dsh-"));
    tempDirs.push(homeDir);
    const sessionDir = path.join(homeDir, ".dsh", "sessions", "proj-a", "dsh-sess-1");
    await fsp.mkdir(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, "session.v4.jsonl.zstd");

    const initial = Buffer.concat([
      zstdFrame([{ type: "session", version: 0, id: "dsh-sess-1", createdAt: Date.now() - 10_000, cwd: "/work/demo" }]),
      zstdFrame([
        { type: "turn/start", seq: 0, time: Date.now() - 9_000, data: { turn: 1 } },
        { type: "assistant/message", seq: 1, time: Date.now() - 8_000, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "旧回复" }] } } },
        { type: "turn/end", seq: 2, time: Date.now() - 7_000, data: { turn: 1, reason: { kind: "completed" } } },
      ]),
    ]);
    await fsp.writeFile(logPath, initial);

    const events: IslandSignalEvent[] = [];
    const monitor = new LocalSessionActivityMonitor({
      homeDir,
      onEvent: (event) => events.push(event),
    });

    // First scan establishes baseline only: no false alerts for historical turns.
    await monitor.scanOnce();
    expect(events).toHaveLength(0);

    // Append turn 2 start + tool call.
    await fsp.appendFile(logPath, zstdFrame([
      { type: "turn/start", seq: 3, time: Date.now(), data: { turn: 2 } },
      { type: "tool/call", seq: 4, time: Date.now(), data: { turn: 2, name: "bash", callId: "c1" } },
    ]));
    await monitor.scanOnce();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "deepseek-cli",
      sessionId: "dsh-sess-1",
      status: "running",
      activeTool: "bash",
      projectPath: "/work/demo",
    });

    // Append final assistant reply + turn/end.
    await fsp.appendFile(logPath, zstdFrame([
      {
        type: "assistant/message",
        seq: 5,
        time: Date.now(),
        data: {
          turn: 2,
          step: 2,
          message: { content: [{ type: "text", text: "重构已完成，构建通过。" }] },
          usage: { inputTokens: 1200, outputTokens: 250, cacheReadTokens: 800 },
        },
      },
      { type: "turn/end", seq: 6, time: Date.now(), data: { turn: 2, reason: { kind: "completed" } } },
    ]));
    await monitor.scanOnce();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      source: "deepseek-cli",
      sessionId: "dsh-sess-1",
      status: "completed",
      summary: "重构已完成，构建通过。",
      tokens: { input: 1200, output: 250, cached: 800 },
    });
  });

  it("detects new Claude Code assistant end_turn replies incrementally", async () => {
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "island-claude-"));
    tempDirs.push(homeDir);
    const projectDir = path.join(homeDir, ".claude", "projects", "demo");
    await fsp.mkdir(projectDir, { recursive: true });
    const logPath = path.join(projectDir, "claude-1.jsonl");
    await fsp.writeFile(logPath, `${JSON.stringify({ type: "user", sessionId: "claude-1", cwd: "/work/app", message: { content: "hello" }, timestamp: new Date().toISOString() })}\n`);

    const events: IslandSignalEvent[] = [];
    const monitor = new LocalSessionActivityMonitor({
      homeDir,
      onEvent: (event) => events.push(event),
    });

    await monitor.scanOnce();
    expect(events).toHaveLength(0);

    await fsp.appendFile(logPath, `${JSON.stringify({
      type: "assistant",
      sessionId: "claude-1",
      cwd: "/work/app",
      timestamp: new Date().toISOString(),
      message: {
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "已修复 lint 报错。" }],
        usage: { input_tokens: 500, output_tokens: 120, cache_read_input_tokens: 300 },
      },
    })}\n`);
    await monitor.scanOnce();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "claude-cli",
      sessionId: "claude-1",
      status: "completed",
      summary: "已修复 lint 报错。",
      model: "claude-sonnet-4-6",
    });
  });

  it("tails omp parent sessions past the title slot with Pi parsing and ignores subagent transcripts", async () => {
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "island-omp-"));
    tempDirs.push(homeDir);
    const sessionId = "01a21d51-1646-7278-bbd8-acf55f0ec704";
    const stem = `2026-11-27T14-03-03-110Z_${sessionId}`;
    const bucket = path.join(homeDir, ".omp", "agent", "sessions", "--work-omp--");
    const logPath = path.join(bucket, `${stem}.jsonl`);
    const subagentPath = path.join(bucket, stem, "Explore.jsonl");
    await fsp.mkdir(path.dirname(subagentPath), { recursive: true });
    const titleSlot = JSON.stringify({ type: "title", v: 1, title: "Fix the build", source: "auto", updatedAt: Date.now(), pad: "" });
    const line = (value: unknown) => `${JSON.stringify(value)}\n`;
    await fsp.writeFile(logPath, [
      `${titleSlot.slice(0, -2)}${" ".repeat(255 - titleSlot.length)}"}\n`,
      // A fork's `parentSession` must not hide the session the way Pi subagent headers do.
      line({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: "/work/omp", parentSession: "older-id" }),
      line({ type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "old prompt" }] } }),
    ].join(""));
    await fsp.writeFile(subagentPath, line({ type: "session", version: 3, id: "sub-1", cwd: "/work/omp" }));

    const events: IslandSignalEvent[] = [];
    const monitor = new LocalSessionActivityMonitor({ homeDir, onEvent: (event) => events.push(event) });
    await monitor.scanOnce();
    expect(events).toHaveLength(0);

    await fsp.appendFile(logPath, line({
      type: "message",
      id: "a2",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], stopReason: "toolUse" },
    }));
    await fsp.appendFile(subagentPath, line({
      type: "message",
      id: "s1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "subagent done" }], stopReason: "stop" },
    }));
    await monitor.scanOnce();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "omp-cli",
      sessionId,
      status: "running",
      activeTool: "bash",
      projectPath: "/work/omp",
      title: "Fix the build",
    });

    await fsp.appendFile(logPath, [
      line({ type: "title_change", id: "a3", timestamp: new Date().toISOString(), title: "Build fixed", source: "user" }),
      line({ type: "message", id: "a4", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "构建已修复。" }], stopReason: "stop" } }),
    ].join(""));
    await monitor.scanOnce();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ source: "omp-cli", sessionId, status: "completed", summary: "构建已修复。", title: "Build fixed" });
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
    "detects appended and brand-new session logs via OS fs.watch without waiting for fallback polling, and stops cleanly",
    async () => {
      const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "island-watch-"));
      tempDirs.push(homeDir);
      const claudeProjects = path.join(homeDir, ".claude", "projects");
      const projectDir = path.join(claudeProjects, "demo");
      await fsp.mkdir(projectDir, { recursive: true });
      const existingLog = path.join(projectDir, "claude-live.jsonl");
      await fsp.writeFile(
        existingLog,
        `${JSON.stringify({ type: "user", sessionId: "claude-live", cwd: "/work/live", message: { content: "hi" }, timestamp: new Date().toISOString() })}\n`,
      );

      const events: IslandSignalEvent[] = [];
      // 60s fallback interval guarantees detections come from OS fs.watch, not polling.
      const monitor = new LocalSessionActivityMonitor({
        homeDir,
        pollIntervalMs: 60_000,
        onEvent: (event) => events.push(event),
      });

      const waitForEvents = async (expectedCount: number, timeoutMs = 2500): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (events.length < expectedCount && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };

      try {
        monitor.start();
        // Wait briefly for initial baseline scan & OS watcher registration.
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(events).toHaveLength(0);

        // Append completion to an existing log file -> should fire via fs.watch in <1s.
        await fsp.appendFile(existingLog, `${JSON.stringify({
          type: "assistant",
          sessionId: "claude-live",
          cwd: "/work/live",
          timestamp: new Date().toISOString(),
          message: {
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "FSEvents 实时捕获完成。" }],
          },
        })}\n`);
        await waitForEvents(1);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          source: "claude-cli",
          sessionId: "claude-live",
          status: "completed",
          summary: "FSEvents 实时捕获完成。",
        });

        // Create a brand-new session file in a newly created subdirectory -> caught by recursive fs.watch.
        const newProjDir = path.join(claudeProjects, "brand-new");
        await fsp.mkdir(newProjDir, { recursive: true });
        await fsp.writeFile(path.join(newProjDir, "claude-new.jsonl"), `${JSON.stringify({
          type: "assistant",
          sessionId: "claude-new",
          cwd: "/work/new",
          timestamp: new Date().toISOString(),
          message: {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "新会话也直接捕获。" }],
          },
        })}\n`);
        await waitForEvents(2);
        expect(events).toHaveLength(2);
        expect(events[1]).toMatchObject({
          source: "claude-cli",
          sessionId: "claude-new",
          status: "completed",
          summary: "新会话也直接捕获。",
        });

        // After stop(), further writes must not emit any events.
        monitor.stop();
        await fsp.appendFile(existingLog, `${JSON.stringify({
          type: "assistant",
          sessionId: "claude-live",
          cwd: "/work/live",
          timestamp: new Date().toISOString(),
          message: {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "停止后的写入" }],
          },
        })}\n`);
        await new Promise((resolve) => setTimeout(resolve, 180));
        expect(events).toHaveLength(2);
      } finally {
        monitor.stop();
      }
    },
  );
});
