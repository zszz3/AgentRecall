import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../shared/types";
import { writeNodeCliLauncher } from "../platform/test-cli-fixtures";
import { HermesRunner } from "./hermes-runner";

describe("HermesRunner", () => {
  test("streams Hermes JSON lines into AgentEvent values", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-hermes-runner-"));
    const executable = await writeNodeCliLauncher(
      dir,
      "hermes-fake",
      `process.stdout.write(JSON.stringify({ type: "delta", content: "Hello" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "completed", content: "Hello", sessionId: "hermes-session-1" }) + "\\n");
`,
    );

    const emitted: AgentEvent[] = [];
    const runner = new HermesRunner({
      executable,
      cwd: dir,
      prompt: "hello",
      modelId: "default",
      onEvent: (event) => emitted.push(event),
      onExit: () => undefined,
    });

    await runner.start();

    expect(emitted).toEqual([
      { type: "delta", content: "Hello" },
      {
        type: "runtime_conversation",
        runtimeConversation: {
          runtimeId: "hermes",
          codecVersion: "v1",
          payload: { sessionId: "hermes-session-1" },
        },
      },
      { type: "completed", content: "Hello" },
    ]);
  });
});
