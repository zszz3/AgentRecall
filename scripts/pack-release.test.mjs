import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { packReleaseArchive } from "./pack-release.mjs";

test("packs the source archive without injecting a legacy Electron bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-recall-pack-release-"));
  try {
    const packageSource = JSON.stringify({
      name: "agent-recall-pack-fixture",
      version: "1.0.0",
      files: ["index.js"],
      scripts: { prepack: "node -e \"console.log('fixture pack log')\"" },
    }, null, 2) + "\n";
    await writeFile(path.join(root, "package.json"), packageSource, "utf8");
    await writeFile(path.join(root, "index.js"), "module.exports = true;\n", "utf8");

    const archive = await packReleaseArchive({
      root,
      destination: path.join(root, "archives"),
      environment: {
        ...process.env,
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "home"),
        npm_config_cache: path.join(root, "npm-cache"),
      },
    });

    assert.match(path.basename(archive), /^agent-recall-pack-fixture-1\.0\.0\.tgz$/);
    assert.equal(await readFile(path.join(root, "package.json"), "utf8"), packageSource);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
