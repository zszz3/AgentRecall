import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyOpenVikingRuntimeAssets } from "./verify-openviking-runtime-assets.mjs";

test("verifies the complete macOS and Windows OpenViking runtime set", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-recall-openviking-release-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"]]) {
    const name = `openviking-runtime-0.4.11-${platform}-${arch}.tar.gz`;
    const content = Buffer.from(`${platform}-${arch}`);
    await writeFile(path.join(root, name), content);
    await writeFile(path.join(root, `${name}.json`), JSON.stringify({
      version: "0.4.11",
      platform,
      arch,
      sha256: createHash("sha256").update(content).digest("hex"),
      archiveType: "tar.gz",
      executablePath: platform === "win32" ? "Scripts/openviking-server.exe" : "bin/openviking-server",
      file: name,
    }));
  }

  await assert.doesNotReject(verifyOpenVikingRuntimeAssets(root, "0.4.11"));
  await rm(path.join(root, "openviking-runtime-0.4.11-win32-x64.tar.gz"));
  await assert.rejects(verifyOpenVikingRuntimeAssets(root, "0.4.11"), /Missing OpenViking runtime/);
});
