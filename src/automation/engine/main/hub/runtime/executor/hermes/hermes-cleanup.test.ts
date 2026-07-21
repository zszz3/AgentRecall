import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { hermesRuntimeStateCodec } from "../../../../agents/hermes/hermes-runtime-state-codec";
import { writeNodeCliLauncher } from "../../../../platform/test-cli-fixtures";
import { deleteHermesSessionArtifacts } from "./hermes-cleanup";

describe("deleteHermesSessionArtifacts", () => {
  test("uses the documented non-interactive session delete command", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-hermes-cleanup-"));
    const argsPath = path.join(dir, "args.json");
    const executable = await writeNodeCliLauncher(
      dir,
      "hermes-cleanup-fake",
      `require("node:fs").writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
    );

    await deleteHermesSessionArtifacts(executable, {
      workDir: dir,
      runtimeConversation: hermesRuntimeStateCodec.encodeConversation({
        native: { sessionId: "hermes-session-1" },
        appContext: { cwd: dir, modelId: "default", transport: "acp" },
      }),
    });

    expect(JSON.parse(await readFile(argsPath, "utf8"))).toEqual([
      "sessions",
      "delete",
      "hermes-session-1",
      "--yes",
    ]);
  });
});
