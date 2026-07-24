import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSafeBuildDirectory,
  buildRuntimePlan,
  runtimeArtifactName,
} from "./build-openviking-runtime.mjs";

test("runtime artifact names pin OpenViking and target platform", () => {
  assert.equal(
    runtimeArtifactName({ version: "0.4.11", platform: "darwin", arch: "arm64" }),
    "openviking-runtime-0.4.11-darwin-arm64.tar.gz",
  );
});

test("runtime builds require explicit isolated HOME and output directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-runtime-build-"));
  try {
    const buildHome = path.join(root, "home");
    const outputDir = path.join(root, "output");
    const plan = buildRuntimePlan({
      version: "0.4.11",
      platform: "darwin",
      arch: "arm64",
      buildHome,
      outputDir,
      pythonArchive: path.join(root, "cpython.tar.gz"),
    });

    assert.equal(plan.env.HOME, buildHome);
    assert.equal(plan.env.PIP_CACHE_DIR, path.join(buildHome, ".cache", "pip"));
    assert.equal(plan.outputPath, path.join(outputDir, "openviking-runtime-0.4.11-darwin-arm64.tar.gz"));
    assert.deepEqual(plan.pipArgs, [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "openviking[local-embed]==0.4.11",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime build refuses broad or unresolved output paths", () => {
  for (const unsafe of ["/", homedir(), process.cwd(), ".", ""]) {
    assert.throws(
      () => assertSafeBuildDirectory(unsafe, "output"),
      /safe explicit output directory/,
    );
  }
});
