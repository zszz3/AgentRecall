import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packageReleaseMacosApp } from "./package-release-macos.mjs";

test("release packaging rejects incomplete input without modifying the source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-release-input-"));
  try {
    await fs.writeFile(path.join(root, "package.json"), '{"name":"fixture"}');
    await assert.rejects(packageReleaseMacosApp(root), process.platform === "darwin" ? /ENOENT/ : /requires macOS/);
    assert.deepEqual(await fs.readdir(root), ["package.json"]);
    assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), '{"name":"fixture"}');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
