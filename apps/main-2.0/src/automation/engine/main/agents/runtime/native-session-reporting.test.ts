import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../shared/types";

const cli = vi.hoisted(() => ({ spawnCli: vi.fn() }));

vi.mock("../../platform/cli-launcher", () => ({ spawnCli: cli.spawnCli }));

import { HermesRunner } from "../hermes/hermes-runner";
import { OpenClawRunner } from "../openclaw/openclaw-runner";
import { OpenCodeRunner } from "../opencode/opencode-runner";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

function createProcess(): FakeChildProcess {
  const process = new FakeChildProcess();
  cli.spawnCli.mockReturnValue(process as unknown as ChildProcess);
  return process;
}

describe("native Runtime Session reporting", () => {
  beforeEach(() => {
    cli.spawnCli.mockReset();
  });

  it("reports OpenCode's sessionID once before completion", async () => {
    const process = createProcess();
    const events: AgentEvent[] = [];
    const runner = new OpenCodeRunner({
      executable: "opencode",
      cwd: "/repo",
      prompt: "Review",
      onEvent: (event) => events.push(event),
      onExit: vi.fn(),
    });

    const started = runner.start();
    process.stdout.write(`${JSON.stringify({ type: "step_start", sessionID: "session-open-code", part: {} })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "text", sessionID: "session-open-code", part: { type: "text", text: "Done" } })}\n`);
    process.emit("exit", 0);
    await started;

    expect(events.filter((event) => event.type === "runtime_conversation")).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "runtime_conversation",
      runtimeConversation: {
        runtimeId: "opencode",
        payload: { native: { sessionId: "session-open-code" } },
      },
    });
    expect(events.at(-1)).toEqual({ type: "completed", content: "Done" });
  });

  it("selects and reports an explicit OpenClaw session id", async () => {
    const process = createProcess();
    const events: AgentEvent[] = [];
    const runner = new OpenClawRunner({
      executable: "openclaw",
      cwd: "/repo",
      prompt: "Review",
      sessionId: "invocation-1",
      onEvent: (event) => events.push(event),
      onExit: vi.fn(),
    });

    const started = runner.start();
    expect(cli.spawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: ["agent", "--session-id", "invocation-1", "--message", "Review", "--json"],
    }));
    process.stdout.write(JSON.stringify({ status: "ok", payloads: [{ text: "Done" }] }));
    process.emit("exit", 0);
    await started;

    expect(events[0]).toMatchObject({
      type: "runtime_conversation",
      runtimeConversation: {
        runtimeId: "openclaw",
        payload: { native: { sessionId: "invocation-1" } },
      },
    });
    expect(events[1]).toEqual({ type: "completed", content: "Done" });
  });

  it("reports the session id from Hermes' quiet machine-readable output", async () => {
    const process = createProcess();
    const events: AgentEvent[] = [];
    const runner = new HermesRunner({
      executable: "hermes",
      cwd: "/repo",
      prompt: "Review",
      onEvent: (event) => events.push(event),
      onExit: vi.fn(),
    });

    const started = runner.start();
    expect(cli.spawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: ["chat", "--quiet", "--query", "Review", "--source", "tool"],
    }));
    process.stdout.write("Done\n");
    process.stderr.write("\nsession_id: session-hermes\n");
    process.emit("exit", 0);
    await started;

    expect(events[0]).toMatchObject({
      type: "runtime_conversation",
      runtimeConversation: {
        runtimeId: "hermes",
        payload: { native: { sessionId: "session-hermes" } },
      },
    });
    expect(events[1]).toEqual({ type: "completed", content: "Done" });
  });

  it("reports Hermes' session id before a non-zero exit", async () => {
    const process = createProcess();
    const events: AgentEvent[] = [];
    const runner = new HermesRunner({
      executable: "hermes",
      cwd: "/repo",
      prompt: "Review",
      onEvent: (event) => events.push(event),
      onExit: vi.fn(),
    });

    const started = runner.start();
    process.stderr.write("session_id: session-hermes-failed\n");
    process.stderr.write("provider failed\n");
    process.emit("exit", 1);
    await started;

    expect(events[0]).toMatchObject({
      type: "runtime_conversation",
      runtimeConversation: {
        runtimeId: "hermes",
        payload: { native: { sessionId: "session-hermes-failed" } },
      },
    });
    expect(events[1]).toMatchObject({ type: "error" });
  });

  it("does not bind a partial Hermes session id split across stderr chunks", async () => {
    const process = createProcess();
    const events: AgentEvent[] = [];
    const runner = new HermesRunner({
      executable: "hermes",
      cwd: "/repo",
      prompt: "Review",
      onEvent: (event) => events.push(event),
      onExit: vi.fn(),
    });

    const started = runner.start();
    process.stderr.write("session_id: session-part");
    expect(events).toEqual([]);
    process.stderr.write("-complete\n");
    process.stdout.write("Done\n");
    process.emit("exit", 0);
    await started;

    expect(events.filter((event) => event.type === "runtime_conversation")).toEqual([
      expect.objectContaining({
        runtimeConversation: {
          runtimeId: "hermes",
          codecVersion: "v1",
          payload: expect.objectContaining({ native: { sessionId: "session-part-complete" } }),
        },
      }),
    ]);
  });
});
