import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { assertEmbeddedPostgresRuntime } = require("../bin/embedded-postgres-runtime.cjs");
const execFile = promisify(execFileCallback);

async function createFixture() {
  const packagePath = await mkdtemp(path.join(os.tmpdir(), "agent-recall-postgres-runtime-"));
  await writeFile(
    path.join(packagePath, "package.json"),
    `${JSON.stringify({ dependencies: { "embedded-postgres": "18.4.0-beta.17" } })}\n`,
  );
  return packagePath;
}

async function installRuntimeFixture(packagePath, platform = "win32", arch = "x64") {
  const platformPackageName = platform === "win32" ? "windows-x64" : `${platform}-${arch}`;
  const packageName = `@embedded-postgres/${platformPackageName}`;
  const runtimeRoot = path.join(packagePath, "node_modules", "@embedded-postgres", platformPackageName);
  const executableSuffix = platform === "win32" ? ".exe" : "";
  await mkdir(path.join(runtimeRoot, "dist"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "native", "bin"), { recursive: true });
  await writeFile(
    path.join(runtimeRoot, "package.json"),
    `${JSON.stringify({ name: packageName, version: "18.4.0-beta.17", exports: "./dist/index.js" })}\n`,
  );
  await writeFile(path.join(runtimeRoot, "dist", "index.js"), "export {};\n");
  await Promise.all(
    ["initdb", "pg_ctl", "postgres"].map((name) =>
      writeFile(
        path.join(runtimeRoot, "native", "bin", `${name}${executableSuffix}`),
        "fixture\n",
        { mode: 0o755 },
      ),
    ),
  );
  return packageName;
}

test("accepts a complete platform PostgreSQL runtime", async () => {
  const packagePath = await createFixture();
  try {
    await installRuntimeFixture(packagePath);

    assert.equal(
      assertEmbeddedPostgresRuntime({ packagePath, platform: "win32", arch: "x64" }).packageName,
      "@embedded-postgres/windows-x64",
    );
  } finally {
    await rm(packagePath, { recursive: true, force: true });
  }
});

test("maps win32-arm64 to @embedded-postgres/windows-x64 for Prism emulation", async () => {
  const packagePath = await createFixture();
  try {
    await installRuntimeFixture(packagePath);

    assert.equal(
      assertEmbeddedPostgresRuntime({ packagePath, platform: "win32", arch: "arm64" }).packageName,
      "@embedded-postgres/windows-x64",
    );
  } finally {
    await rm(packagePath, { recursive: true, force: true });
  }
});

test("accepts a self-contained runtime through a canonicalized package path", async () => {
  const packagePath = await createFixture();
  const aliasPath = `${packagePath}-alias`;
  try {
    const packageName = await installRuntimeFixture(packagePath, process.platform, process.arch);
    await symlink(packagePath, aliasPath, process.platform === "win32" ? "junction" : "dir");
    assert.equal(
      assertEmbeddedPostgresRuntime({
        packagePath: aliasPath,
        requireSelfContained: true,
      }).packageName,
      packageName,
    );
  } finally {
    await unlink(aliasPath).catch(() => undefined);
    await rm(packagePath, { recursive: true, force: true });
  }
});

test("reports an actionable repair when the platform runtime is missing", async () => {
  const packagePath = await createFixture();
  try {
    assert.throws(
      () => assertEmbeddedPostgresRuntime({ packagePath, platform: "win32", arch: "x64" }),
      (error) => {
        assert.match(error.message, /AgentRecall 安装不完整/);
        assert.match(error.message, /@embedded-postgres\/windows-x64@18\.4\.0-beta\.17/);
        assert.match(error.message, /npm install -g/);
        assert.doesNotMatch(error.message, /--force/);
        return true;
      },
    );
  } finally {
    await rm(packagePath, { recursive: true, force: true });
  }
});

test("includes --force in repair command when win32-arm64 runtime is missing", async () => {
  const packagePath = await createFixture();
  try {
    assert.throws(
      () => assertEmbeddedPostgresRuntime({ packagePath, platform: "win32", arch: "arm64" }),
      (error) => {
        assert.match(error.message, /AgentRecall 安装不完整/);
        assert.match(error.message, /@embedded-postgres\/windows-x64@18\.4\.0-beta\.17/);
        assert.match(error.message, /npm install -g .*--force/);
        return true;
      },
    );
  } finally {
    await rm(packagePath, { recursive: true, force: true });
  }
});

test("rejects a platform runtime from a different embedded PostgreSQL version", async () => {
  const packagePath = await createFixture();
  const runtimeRoot = path.join(packagePath, "node_modules", "@embedded-postgres", "windows-x64");
  try {
    await mkdir(path.join(runtimeRoot, "dist"), { recursive: true });
    await writeFile(
      path.join(runtimeRoot, "package.json"),
      `${JSON.stringify({
        name: "@embedded-postgres/windows-x64",
        version: "18.4.0-beta.16",
        exports: "./dist/index.js",
      })}\n`,
    );
    await writeFile(path.join(runtimeRoot, "dist", "index.js"), "export {};\n");
    assert.throws(
      () => assertEmbeddedPostgresRuntime({ packagePath, platform: "win32", arch: "x64" }),
      /@embedded-postgres\/windows-x64@18\.4\.0-beta\.17/,
    );
  } finally {
    await rm(packagePath, { recursive: true, force: true });
  }
});

test("rejects platforms without an embedded PostgreSQL build", () => {
  assert.throws(
    () => assertEmbeddedPostgresRuntime({ platform: "win32", arch: "ia32" }),
    /AgentRecall 暂不支持 win32-ia32/,
  );
});

test("fails an npm installation whose platform runtime was omitted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-recall-postinstall-"));
  const fixtureRoot = path.join(directory, "fixture");
  const packRoot = path.join(directory, "pack");
  const prefix = path.join(directory, "prefix");
  const home = path.join(directory, "home");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: path.join(directory, "npm-cache"),
    npm_config_prefix: prefix,
    npm_config_userconfig: path.join(directory, ".npmrc"),
  };
  try {
    await Promise.all([
      mkdir(path.join(fixtureRoot, "bin"), { recursive: true }),
      mkdir(packRoot, { recursive: true }),
      mkdir(home, { recursive: true }),
    ]);
    await copyFile(
      new URL("../bin/embedded-postgres-runtime.cjs", import.meta.url),
      path.join(fixtureRoot, "bin", "embedded-postgres-runtime.cjs"),
    );
    await writeFile(path.join(directory, ".npmrc"), "audit=false\nfund=false\n");
    await writeFile(path.join(fixtureRoot, "package.json"), `${JSON.stringify({
      name: "agent-recall-postinstall-fixture",
      version: "1.0.0",
      scripts: { postinstall: "node bin/embedded-postgres-runtime.cjs" },
    })}\n`);
    await execFile(npm, ["pack", "--ignore-scripts", "--pack-destination", packRoot], {
      cwd: fixtureRoot,
      env: environment,
      shell: process.platform === "win32",
    });
    const archive = path.join(packRoot, (await readdir(packRoot))[0]);
    await assert.rejects(
      execFile(npm, ["install", "--global", archive, "--prefix", prefix, "--offline"], {
        cwd: fixtureRoot,
        env: environment,
        shell: process.platform === "win32",
      }),
      (error) => {
        const output = `${error.stdout || ""}\n${error.stderr || ""}`;
        assert.match(output, /AgentRecall 安装不完整/);
        assert.match(output, /@embedded-postgres\//);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
