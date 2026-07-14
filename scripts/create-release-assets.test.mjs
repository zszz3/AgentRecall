import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createReleaseAssets, LATEST_PACKAGE_NAME } from "./create-release-assets.mjs";

test("creates a structured update manifest, checksum, and release notes from one source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-session-release-"));
  const notePath = path.join(root, "note.md");
  const packagePath = path.join(root, "agent-session-search-0.2.0.tgz");
  const outputDirectory = path.join(root, "release");
  await writeFile(notePath, "# 自动更新\n\n## 新增功能\n\n- 终端显示更新。\n", "utf8");
  await writeFile(packagePath, "package bytes", "utf8");

  const manifest = await createReleaseAssets({
    notePath,
    version: "0.2.0",
    packagePath,
    repository: "zszz3/agent-session-search",
    outputDirectory,
    publishedAt: "2026-07-14T00:00:00.000Z",
  });

  assert.equal(manifest.version, "0.2.0");
  assert.deepEqual(manifest.notes.features, ["终端显示更新。"]);
  assert.match(manifest.package.url, /releases\/download\/v0\.2\.0\/agent-session-search-0\.2\.0\.tgz$/);
  assert.equal(JSON.parse(await readFile(path.join(outputDirectory, "update.json"), "utf8")).package.sha256, manifest.package.sha256);
  assert.match(await readFile(path.join(outputDirectory, `${manifest.package.name}.sha256`), "utf8"), new RegExp(`^${manifest.package.sha256}`));
  assert.equal(await readFile(path.join(outputDirectory, LATEST_PACKAGE_NAME), "utf8"), "package bytes");
  assert.match(await readFile(path.join(outputDirectory, `${LATEST_PACKAGE_NAME}.sha256`), "utf8"), new RegExp(`^${manifest.package.sha256}`));
  assert.match(await readFile(path.join(outputDirectory, "release-notes.md"), "utf8"), /# 自动更新/);
});
