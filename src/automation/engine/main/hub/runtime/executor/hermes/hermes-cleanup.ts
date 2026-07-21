import { execCli } from "../../../../platform/cli-launcher";
import type { RuntimeSessionCleanupContext } from "../../../../agents/runtime/runtime-driver";
import { hermesRuntimeStateCodec } from "../../../../agents/hermes/hermes-runtime-state-codec";

export async function deleteHermesSessionArtifacts(
  executable: string,
  input: RuntimeSessionCleanupContext,
): Promise<void> {
  const sessionId = hermesRuntimeStateCodec.decodeConversation(input.runtimeConversation)?.native.sessionId;
  if (!sessionId) return;
  await execCli({
    executable,
    args: ["sessions", "delete", sessionId, "--yes"],
    cwd: input.workDir,
    env: process.env,
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 1024 * 64,
  });
}
