import { execCli } from "../../../../platform/cli-launcher";
import type { RuntimeSessionCleanupContext } from "../../../../agents/runtime/runtime-driver";
import { openCodeRuntimeStateCodec } from "../../../../agents/opencode/opencode-runtime-state-codec";

export async function deleteOpenCodeSessionArtifacts(
  executable: string,
  input: RuntimeSessionCleanupContext,
): Promise<void> {
  const sessionId = openCodeRuntimeStateCodec.decodeConversation(input.runtimeConversation)?.native.sessionId;
  if (!sessionId) return;
  await execCli({
    executable,
    args: ["session", "delete", sessionId],
    cwd: input.workDir,
    env: process.env,
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 1024 * 64,
  });
}
