import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { openCodeRuntimeStateCodec } from "../../../../agents/opencode/opencode-runtime-state-codec";
import { writeNodeCliLauncher } from "../../../../platform/test-cli-fixtures";
import { deleteOpenCodeSessionArtifacts } from "./opencode-cleanup";

describe("deleteOpenCodeSessionArtifacts", () => {
  test("uses the documented session delete command", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-opencode-cleanup-"));
    const argsPath = path.join(dir, "args.json");
    const executable = await writeNodeCliLauncher(
      dir,
      "opencode-cleanup-fake",
      `require("node:fs").writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
    );
    await deleteOpenCodeSessionArtifacts(executable, {
      workDir: dir,
      runtimeConversation: openCodeRuntimeStateCodec.encodeConversation({
        native: { sessionId: "ses_opencode_1" },
        appContext: { cwd: dir, modelId: "default", transport: "acp" },
      }),
    });
    expect(JSON.parse(await readFile(argsPath, "utf8"))).toEqual(["session", "delete", "ses_opencode_1"]);
  }, 15_000);
});
