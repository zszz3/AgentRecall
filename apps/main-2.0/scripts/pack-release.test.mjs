import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packReleaseArchive } from "./pack-release.mjs";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(new URL("./pack-release.mjs", import.meta.url));

test("release installs use the same exact pi-ai version as the build", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const name = "@earendil-works/pi-ai";
  const version = lock.packages[`node_modules/${name}`].version;
  assert.equal(manifest.dependencies[name], version);
  assert.equal(lock.packages[""].dependencies[name], version);
});

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

test("prints the package filename when invoked from the release workflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-recall-pack-release-cli-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "agent-recall-pack-fixture",
      version: "1.0.0",
      files: ["index.js"],
    }, null, 2) + "\n", "utf8");
    await writeFile(path.join(root, "index.js"), "module.exports = true;\n", "utf8");
    const environment = {
      ...process.env,
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      npm_config_cache: path.join(root, "npm-cache"),
      npm_config_prefix: path.join(root, "npm-prefix"),
    };

    const { stdout } = await execFile(process.execPath, [
      scriptPath,
      "--pack-destination",
      "release",
    ], {
      cwd: root,
      env: environment,
    });

    assert.equal(stdout.trim(), "agent-recall-pack-fixture-1.0.0.tgz");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects MCP source maps from the release archive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-recall-pack-release-mcp-map-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "agent-recall-pack-fixture",
      version: "1.0.0",
      files: ["out"],
    }, null, 2) + "\n", "utf8");
    const mcpOutput = path.join(root, "out", "mcp");
    await mkdir(mcpOutput, { recursive: true });
    await writeFile(path.join(mcpOutput, "migration-entry.js"), "export {};\n", "utf8");
    await writeFile(path.join(mcpOutput, "migration-entry.js.map"), "{}\n", "utf8");

    await assert.rejects(
      packReleaseArchive({
        root,
        destination: path.join(root, "archives"),
        environment: {
          ...process.env,
          HOME: path.join(root, "home"),
          USERPROFILE: path.join(root, "home"),
          npm_config_cache: path.join(root, "npm-cache"),
        },
      }),
      /must not include MCP source maps: out\/mcp\/migration-entry\.js\.map/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports release packaging failures without an unhandled rejection stack", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-recall-pack-release-cli-error-"));
  try {
    await assert.rejects(
      execFile(process.execPath, [scriptPath, "--pack-destination", "release"], {
        cwd: root,
        env: {
          ...process.env,
          HOME: path.join(root, "home"),
          USERPROFILE: path.join(root, "home"),
          npm_config_cache: path.join(root, "npm-cache"),
          npm_config_prefix: path.join(root, "npm-prefix"),
        },
      }),
      (error) => {
        assert.match(error.stderr, /npm(?:\.cmd)? pack/);
        assert.doesNotMatch(error.stderr, /node:internal\/errors|Node\.js v/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
