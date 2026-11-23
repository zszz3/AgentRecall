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
});
