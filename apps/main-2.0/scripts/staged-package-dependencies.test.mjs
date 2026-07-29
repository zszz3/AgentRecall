import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { materializeStagedPackageDependencies } = require("../bin/staged-package-dependencies.cjs");

test("materializes hoisted staging dependencies inside the update package", async () => {
  const stageRoot = await mkdtemp(path.join(os.tmpdir(), "agent-recall-staged-dependencies-"));
  const packageRoot = path.join(stageRoot, "node_modules", "agent-recall-v2");
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

test("restores embedded PostgreSQL native links in the staged update package", async () => {
  const stageRoot = await mkdtemp(path.join(os.tmpdir(), "agent-recall-staged-postgres-"));
  const packageRoot = path.join(stageRoot, "node_modules", "agent-recall-v2");
  const nativePackageRoot = path.join(
    stageRoot,
    "node_modules",
    "@embedded-postgres",
    "darwin-arm64",
  );
  const sourceRelativePath = path.join("native", "lib", "libicudata.77.1.dylib");
  const targetRelativePath = path.join("native", "lib", "libicudata.77.dylib");
  try {
    await mkdir(path.join(packageRoot, "bin"), { recursive: true });
    await mkdir(path.join(nativePackageRoot, "native", "lib"), { recursive: true });
    await writeFile(path.join(nativePackageRoot, sourceRelativePath), "icu-data\n");
    await writeFile(
      path.join(nativePackageRoot, "native", "pg-symlinks.json"),
      `${JSON.stringify([{
        source: sourceRelativePath,
        target: targetRelativePath,
      }])}\n`,
    );

    await materializeStagedPackageDependencies({ stageRoot, packagePath: packageRoot });

    const stagedNativeRoot = path.join(
      packageRoot,
      "node_modules",
      "@embedded-postgres",
      "darwin-arm64",
    );
    const stagedTarget = path.join(stagedNativeRoot, targetRelativePath);
    assert.equal(await readFile(stagedTarget, "utf8"), "icu-data\n");
    if (process.platform !== "win32") {
      assert.equal((await lstat(stagedTarget)).isSymbolicLink(), true);
      assert.equal(await readlink(stagedTarget), "libicudata.77.1.dylib");
    }
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
});
