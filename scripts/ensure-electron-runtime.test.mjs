import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { electronDownloadUrls, electronRuntimeDetails } from "./ensure-electron-runtime.mjs";

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
  assert.match(source, /mkdtemp\(path\.join\(electronDirectory, "\.agent-recall-electron-"\)\)/);
  assert.doesNotMatch(source, /NODE_TLS_REJECT_UNAUTHORIZED/);
});

test("keeps a complete V2 Electron runtime unchanged and removes only stale staging", async (t) => {
  const fixture = await temporaryRepository(t);
  const electronDirectory = path.join(fixture.directory, "apps", "main-2.0", "node_modules", "electron");
  const { executable } = electronRuntimeDetails({ version: "42.9.2" });
  const staleStaging = path.join(electronDirectory, ".agent-recall-electron-stale");
  const recentStaging = path.join(electronDirectory, ".agent-recall-electron-recent");
  await mkdir(path.join(electronDirectory, "dist", path.dirname(executable)), { recursive: true });
  await Promise.all([mkdir(staleStaging), mkdir(recentStaging)]);
  const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await utimes(staleStaging, staleTime, staleTime);
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
  await assert.rejects(access(staleStaging), (error) => error?.code === "ENOENT");
  await access(recentStaging);
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
