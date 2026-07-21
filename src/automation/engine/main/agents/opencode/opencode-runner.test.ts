import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../shared/types";
import { writeNodeCliLauncher } from "../../platform/test-cli-fixtures";
import { OpenCodeRunner, agentEventsFromOpenCodeJson } from "./opencode-runner";

describe("OpenCodeRunner", () => {
  test("uses documented NDJSON one-shot mode and normalizes records", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-opencode-runner-"));
    const argsPath = path.join(dir, "args.json");
    const executable = await writeNodeCliLauncher(
      dir,
      "opencode-fake",
      `require("node:fs").writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } });
send({ type: "text", sessionID: "ses_1", part: { type: "text", text: "Hello from OpenCode" } });
send({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", reason: "stop" } });
`,
    );
    const emitted: AgentEvent[] = [];
    const runner = new OpenCodeRunner({
      executable,
      cwd: dir,
      prompt: "hello world",
      modelId: "openai/gpt-5",
      onEvent: (event) => emitted.push(event),
      onExit: () => undefined,
    });

    await runner.start();

    expect(JSON.parse(await readFile(argsPath, "utf8"))).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "openai/gpt-5",
      "hello world",
    ]);
    expect(emitted).toEqual([
      expect.objectContaining({ type: "meta" }),
      { type: "delta", content: "Hello from OpenCode" },
      expect.objectContaining({ type: "meta" }),
      { type: "completed", content: "Hello from OpenCode" },
    ]);
  }, 15_000);

  test("maps reasoning, tools, and errors without trusting unknown shapes", () => {
    expect(agentEventsFromOpenCodeJson({
      type: "reasoning",
      part: { type: "reasoning", text: "thinking" },
    })).toEqual([{ type: "meta", content: "thinking" }]);
    expect(agentEventsFromOpenCodeJson({
      type: "tool_use",
      part: { type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", output: "ok" } },
    })).toEqual([expect.objectContaining({ type: "tool_result", name: "bash", content: "ok" })]);
    expect(agentEventsFromOpenCodeJson({ type: "error", error: { name: "AuthError" } })).toEqual([
      { type: "error", error: '{"name":"AuthError"}' },
    ]);
  });

  test("reports malformed stdout and non-zero exits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-opencode-error-"));
    const executable = await writeNodeCliLauncher(
      dir,
      "opencode-fake-error",
      `process.stdout.write("not-json\\n"); process.stderr.write("failed\\n"); process.exit(2);`,
    );
    const emitted: AgentEvent[] = [];
    const runner = new OpenCodeRunner({
      executable,
      cwd: dir,
      prompt: "hello",
      onEvent: (event) => emitted.push(event),
      onExit: () => undefined,
    });

    await runner.start();

    expect(emitted).toEqual([
      { type: "error", error: "OpenCode emitted invalid JSON: not-json" },
    ]);
  }, 15_000);
});
