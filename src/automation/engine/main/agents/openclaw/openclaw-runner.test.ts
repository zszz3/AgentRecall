import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../shared/types";
import { writeNodeCliLauncher } from "../../platform/test-cli-fixtures";
import { OpenClawRunner, errorFromOpenClawResponse, textFromOpenClawResponse } from "./openclaw-runner";

describe("OpenClawRunner", () => {
  test("uses the documented JSON agent command with an isolated session key", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-runner-"));
    const argsPath = path.join(dir, "args.json");
    const executable = await writeNodeCliLauncher(
      dir,
      "runtime-fake",
      `require("node:fs").writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ status: "ok", payloads: [{ text: "Hello from OpenClaw" }], meta: { transport: "embedded" } }));`,
    );
    const emitted: AgentEvent[] = [];
    const runner = new OpenClawRunner({
      executable,
      cwd: dir,
      prompt: "hello world",
      sessionKey: "multi-agent-chat-run-1",
      modelId: "openai/gpt-5.4",
      onEvent: (event) => emitted.push(event),
      onExit: () => undefined,
    });
    await runner.start();
    expect(JSON.parse(await readFile(argsPath, "utf8"))).toEqual([
      "agent",
      "--session-key",
      "multi-agent-chat-run-1",
      "--message",
      "hello world",
      "--json",
      "--model",
      "openai/gpt-5.4",
    ]);
    expect(emitted).toEqual([{ type: "completed", content: "Hello from OpenClaw" }]);
  }, 15_000);

  test("parses direct and Gateway-wrapped payloads and explicit errors", () => {
    expect(textFromOpenClawResponse({ payloads: [{ text: "one" }, { text: "two" }] })).toBe("one\ntwo");
    expect(textFromOpenClawResponse({ result: { payloads: [{ text: "wrapped" }] } })).toBe("wrapped");
    expect(errorFromOpenClawResponse({ status: "error", error: { message: "denied" } })).toBe("denied");
    expect(errorFromOpenClawResponse({ status: "in_flight" })).toBe("OpenClaw returned status in_flight.");
  });

  test("reports malformed JSON instead of accepting console noise", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-error-"));
    const executable = await writeNodeCliLauncher(dir, "runtime-fake-error", `process.stdout.write("banner");`);
    const emitted: AgentEvent[] = [];
    const runner = new OpenClawRunner({
      executable,
      cwd: dir,
      prompt: "hello",
      sessionKey: "run-2",
      onEvent: (event) => emitted.push(event),
      onExit: () => undefined,
    });
    await runner.start();
    expect(emitted).toEqual([{ type: "error", error: "OpenClaw emitted invalid JSON: banner" }]);
  }, 15_000);
});
