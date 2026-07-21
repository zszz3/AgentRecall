import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../shared/types";
import { writeNodeCliLauncher } from "../../platform/test-cli-fixtures";
import { HermesRunner } from "./hermes-runner";

describe("HermesRunner", () => {
  test("uses the documented scripted one-shot command and emits final text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-hermes-runner-"));
    const argsPath = path.join(dir, "args.json");
    const executable = await writeNodeCliLauncher(
      dir,
      "hermes-fake",
      `require("node:fs").writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write("Hello from Hermes\\n");
`,
    );

    const emitted: AgentEvent[] = [];
    const runner = new HermesRunner({
      executable,
      cwd: dir,
      prompt: "hello",
      modelId: "nous/hermes-4",
      onEvent: (event) => emitted.push(event),
      onExit: () => undefined,
    });

    await runner.start();

    expect(JSON.parse(await readFile(argsPath, "utf8"))).toEqual([
      "-z",
      "hello",
      "--model",
      "nous/hermes-4",
    ]);
    expect(emitted).toEqual([{ type: "completed", content: "Hello from Hermes" }]);
  });

  test("reports a non-zero Hermes exit with bounded stderr context", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-hermes-runner-error-"));
    const executable = await writeNodeCliLauncher(
      dir,
      "hermes-fake-error",
      `process.stderr.write("authentication failed\\n");
process.exit(7);
`,
    );
    const emitted: AgentEvent[] = [];
    let exitCode: number | null | undefined;
    const runner = new HermesRunner({
      executable,
      cwd: dir,
      prompt: "hello",
      onEvent: (event) => emitted.push(event),
      onExit: (code) => {
        exitCode = code;
      },
    });

    await runner.start();

    expect(exitCode).toBe(7);
    expect(emitted).toEqual([
      { type: "error", error: "Hermes exited with 7: authentication failed" },
    ]);
  });
});
