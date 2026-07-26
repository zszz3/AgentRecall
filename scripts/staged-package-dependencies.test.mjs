import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { materializeStagedPackageDependencies } = require("../bin/staged-package-dependencies.cjs");

test("materializes hoisted staging dependencies inside the update package", async () => {
  const stageRoot = await mkdtemp(path.join(os.tmpdir(), "agent-recall-staged-dependencies-"));
  const packageRoot = path.join(stageRoot, "node_modules", "agent-recall");
  try {
    await mkdir(path.join(packageRoot, "bin"), { recursive: true });
    await mkdir(path.join(stageRoot, "node_modules", "electron-store"), { recursive: true });
    await mkdir(path.join(stageRoot, "node_modules", "@scope", "runtime-helper"), { recursive: true });
    await mkdir(path.join(stageRoot, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(stageRoot, "node_modules", "electron-store", "package.json"), '{"name":"electron-store"}\n');
    await writeFile(path.join(stageRoot, "node_modules", "@scope", "runtime-helper", "package.json"), '{"name":"@scope/runtime-helper"}\n');
    await writeFile(path.join(stageRoot, "node_modules", ".bin", "ignored"), "ignored\n");

    const result = await materializeStagedPackageDependencies({ stageRoot, packagePath: packageRoot });

    assert.deepEqual(result.copied, ["@scope", "electron-store"]);
    assert.equal(
      await readFile(path.join(packageRoot, "node_modules", "electron-store", "package.json"), "utf8"),
      '{"name":"electron-store"}\n',
    );
    assert.equal(
      await readFile(path.join(packageRoot, "node_modules", "@scope", "runtime-helper", "package.json"), "utf8"),
      '{"name":"@scope/runtime-helper"}\n',
    );
    await assert.rejects(readFile(path.join(packageRoot, "node_modules", ".bin", "ignored"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
});
