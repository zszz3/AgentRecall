import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  electronDownloadUrls,
  electronRuntimeDetails,
  ensureElectronRuntime,
} from "./ensure-electron-runtime.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./ensure-electron-runtime.mjs", import.meta.url));

async function temporaryRepository(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-recall-electron-dev-"));
  const homeDirectory = path.join(directory, "home");
  const appDirectory = path.join(directory, "apps", "main-2.0");
  await mkdir(homeDirectory);
  await mkdir(appDirectory, { recursive: true });
  await writeFile(path.join(appDirectory, "package.json"), JSON.stringify({ name: "agent-recall-v2" }));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, homeDirectory };
}

test("derives checksum artifact names and executable paths for supported platforms", () => {
  assert.deepEqual(
    electronRuntimeDetails({ version: "42.9.2", platform: "darwin", arch: "arm64" }),
    {
      fileName: "electron-v42.9.2-darwin-arm64.zip",
      executable: "Electron.app/Contents/MacOS/Electron",
    },
  );
  assert.equal(
    electronRuntimeDetails({ version: "42.9.2", platform: "win32", arch: "x64" }).executable,
    "electron.exe",
  );
  assert.equal(
    electronRuntimeDetails({ version: "42.9.2", platform: "linux", arch: "x64" }).executable,
    "electron",
  );
});

test("uses a configured mirror first and keeps verified fallback sources", () => {
  assert.deepEqual(
    electronDownloadUrls("42.9.2", "electron-v42.9.2-linux-x64.zip", "https://mirror.example/electron"),
    [
      "https://mirror.example/electron/42.9.2/electron-v42.9.2-linux-x64.zip",
      "https://github.com/electron/electron/releases/download/v42.9.2/electron-v42.9.2-linux-x64.zip",
      "https://npmmirror.com/mirrors/electron/42.9.2/electron-v42.9.2-linux-x64.zip",
    ],
  );
});

test("V2 development startup repairs Electron without disabling TLS verification", async () => {
  const [packageJson, source] = await Promise.all([
    readFile("apps/main-2.0/package.json", "utf8").then(JSON.parse),
    readFile("scripts/ensure-electron-runtime.mjs", "utf8"),
  ]);
  assert.equal(packageJson.scripts.predev, "node ../../scripts/ensure-electron-runtime.mjs .");
  assert.match(source, /"--proto-redir", "=https"/);
  assert.match(source, /checksums\[fileName\]/);
  assert.doesNotMatch(source, /NODE_TLS_REJECT_UNAUTHORIZED/);
});

test("keeps a complete V2 Electron runtime unchanged in an isolated checkout", async (t) => {
  const fixture = await temporaryRepository(t);
  const electronDirectory = path.join(fixture.directory, "apps", "main-2.0", "node_modules", "electron");
  const { executable } = electronRuntimeDetails({ version: "42.9.2" });
  await mkdir(path.join(electronDirectory, "dist", path.dirname(executable)), { recursive: true });
  await Promise.all([
    writeFile(path.join(electronDirectory, "package.json"), JSON.stringify({ version: "42.9.2" })),
    writeFile(path.join(electronDirectory, "checksums.json"), "{}\n"),
    writeFile(path.join(electronDirectory, "path.txt"), executable),
    writeFile(path.join(electronDirectory, "dist", "version"), "42.9.2\n"),
    writeFile(path.join(electronDirectory, "dist", executable), "synthetic runtime\n"),
  ]);

  const result = await execFileAsync(process.execPath, [scriptPath, "apps/main-2.0"], {
    cwd: fixture.directory,
    env: { ...process.env, HOME: fixture.homeDirectory, USERPROFILE: fixture.homeDirectory },
  });

  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("repairs an incomplete Electron runtime when the system temp directory is on another device", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await mkdtemp(path.join(path.dirname(scriptPath), ".electron-runtime-cross-device-"));
  const appDirectory = path.join(directory, "apps", "main-2.0");
  const electronDirectory = path.join(appDirectory, "node_modules", "electron");
  const extractDirectory = path.join(appDirectory, "node_modules", "@electron-internal", "extract-zip");
  const fakeBinDirectory = path.join(directory, "bin");
  const archiveSource = path.join(directory, "synthetic-electron.zip");
  const version = "42.9.2";
  const { fileName, executable } = electronRuntimeDetails({ version });
  const archiveContent = "synthetic Electron archive\n";
  const checksum = createHash("sha256").update(archiveContent).digest("hex");
  t.after(() => rm(directory, { recursive: true, force: true }));

  await Promise.all([
    mkdir(path.join(electronDirectory, "dist"), { recursive: true }),
    mkdir(extractDirectory, { recursive: true }),
    mkdir(fakeBinDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(appDirectory, "package.json"), JSON.stringify({ name: "agent-recall-v2" })),
    writeFile(path.join(electronDirectory, "package.json"), JSON.stringify({ version })),
    writeFile(path.join(electronDirectory, "checksums.json"), JSON.stringify({ [fileName]: checksum })),
    writeFile(path.join(electronDirectory, "path.txt"), "stale-electron"),
    writeFile(path.join(electronDirectory, "dist", "stale-runtime"), "old runtime\n"),
    writeFile(archiveSource, archiveContent),
    writeFile(path.join(extractDirectory, "package.json"), JSON.stringify({
      name: "@electron-internal/extract-zip",
      main: "index.cjs",
    })),
    writeFile(path.join(extractDirectory, "index.cjs"), `
      const fs = require("node:fs/promises");
      const path = require("node:path");
      exports.extract = async (_archive, { dir }) => {
        const executablePath = path.join(dir, process.env.AGENT_RECALL_TEST_ELECTRON_EXECUTABLE);
        await fs.mkdir(path.dirname(executablePath), { recursive: true });
        await fs.writeFile(path.join(dir, "version"), process.env.AGENT_RECALL_TEST_ELECTRON_VERSION);
        await fs.writeFile(executablePath, "new runtime\\n", { mode: 0o755 });
      };
    `),
    writeFile(path.join(fakeBinDirectory, "curl"), `#!/usr/bin/env node
      const fs = require("node:fs");
      const outputIndex = process.argv.indexOf("--output");
      fs.copyFileSync(process.env.AGENT_RECALL_TEST_ELECTRON_ARCHIVE, process.argv[outputIndex + 1]);
    `),
  ]);
  await chmod(path.join(fakeBinDirectory, "curl"), 0o755);

  const environment = {
    PATH: `${fakeBinDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    AGENT_RECALL_TEST_ELECTRON_ARCHIVE: archiveSource,
    AGENT_RECALL_TEST_ELECTRON_EXECUTABLE: executable,
    AGENT_RECALL_TEST_ELECTRON_VERSION: version,
  };
  const previousEnvironment = new Map(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await ensureElectronRuntime(appDirectory);

  assert.equal(await readFile(path.join(electronDirectory, "path.txt"), "utf8"), executable);
  assert.equal(await readFile(path.join(electronDirectory, "dist", "version"), "utf8"), version);
  assert.equal(await readFile(path.join(electronDirectory, "dist", executable), "utf8"), "new runtime\n");
});

test("explains how to install missing V2 dependencies", async (t) => {
  const fixture = await temporaryRepository(t);

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "apps/main-2.0"], {
      cwd: fixture.directory,
      env: { ...process.env, HOME: fixture.homeDirectory, USERPROFILE: fixture.homeDirectory },
    }),
    (error) => {
      assert.match(error.stderr, /Electron dependencies are missing/);
      assert.match(error.stderr, /npm run setup:v2/);
      return true;
    },
  );
});
