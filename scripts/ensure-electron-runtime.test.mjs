import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { electronDownloadUrls, electronRuntimeDetails, ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

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

test("retries transient Windows lock errors when swapping and cleaning Electron runtime", async (t) => {
  const fixture = await temporaryRepository(t);
  const appDirectory = path.join(fixture.directory, "apps", "main-2.0");
  const electronDirectory = path.join(appDirectory, "node_modules", "electron");
  const { fileName, executable } = electronRuntimeDetails({ version: "42.9.2" });
  const archivePayload = Buffer.from("synthetic-electron-zip");
  const archiveSha = createHash("sha256").update(archivePayload).digest("hex");
  await mkdir(path.join(electronDirectory, "dist"), { recursive: true });
  await Promise.all([
    writeFile(path.join(electronDirectory, "package.json"), JSON.stringify({ version: "42.9.2" })),
    writeFile(path.join(electronDirectory, "checksums.json"), JSON.stringify({ [fileName]: archiveSha })),
    writeFile(path.join(electronDirectory, "dist", "version"), "0.0.0\n"),
  ]);

  let renameAttempts = 0;
  let rmAttempts = 0;
  await ensureElectronRuntime(appDirectory, {
    retryDelayMs: 1,
    download: async (_urls, destination) => {
      await writeFile(destination, archivePayload);
    },
    extract: async (_archive, { dir }) => {
      await mkdir(path.join(dir, path.dirname(executable)), { recursive: true });
      await writeFile(path.join(dir, "version"), "42.9.2\n");
      await writeFile(path.join(dir, executable), "synthetic runtime\n");
    },
    renameImpl: async (source, destination) => {
      renameAttempts += 1;
      if (renameAttempts <= 2) {
        const code = renameAttempts === 1 ? "EPERM" : "EBUSY";
        throw Object.assign(new Error(`transient ${code}`), { code });
      }
      return rename(source, destination);
    },
    rmImpl: async (targetPath, options) => {
      rmAttempts += 1;
      if (rmAttempts === 1) {
        throw Object.assign(new Error("transient EBUSY"), { code: "EBUSY" });
      }
      return rm(targetPath, options);
    },
  });

  assert.ok(renameAttempts >= 4);
  assert.ok(rmAttempts >= 2);
  assert.equal(await readFile(path.join(electronDirectory, "path.txt"), "utf8"), executable);
  assert.equal((await readFile(path.join(electronDirectory, "dist", "version"), "utf8")).trim(), "42.9.2");
});

test("reuses a checksum-verified local Electron cache archive for V1 without network download", async (t) => {
  const fixture = await temporaryRepository(t);
  const appDirectory = path.join(fixture.directory, "apps", "main-1.0");
  const electronDirectory = path.join(appDirectory, "node_modules", "electron");
  const cacheDirectory = path.join(fixture.directory, "electron-cache", "hash-entry");
  const stagingSource = path.join(fixture.directory, "zip-source");
  const { fileName, executable } = electronRuntimeDetails({ version: "42.3.0" });
  await mkdir(appDirectory, { recursive: true });
  await mkdir(electronDirectory, { recursive: true });
  await mkdir(cacheDirectory, { recursive: true });
  await mkdir(path.join(stagingSource, path.dirname(executable)), { recursive: true });

  await writeFile(path.join(appDirectory, "package.json"), JSON.stringify({ name: "agent-recall" }));
  await writeFile(path.join(electronDirectory, "package.json"), JSON.stringify({ version: "42.3.0" }));
  await writeFile(path.join(stagingSource, "version"), "42.3.0\n");
  await writeFile(path.join(stagingSource, executable), "cached runtime\n");

  const cachedZip = path.join(cacheDirectory, fileName);
  let archivePayload;
  if (process.platform === "win32") {
    await execFileAsync("tar.exe", ["-a", "-cf", cachedZip, "-C", stagingSource, "."]);
    archivePayload = await readFile(cachedZip);
  } else {
    archivePayload = Buffer.from("synthetic-cached-zip");
    await writeFile(cachedZip, archivePayload);
  }
  const archiveSha = createHash("sha256").update(archivePayload).digest("hex");
  await writeFile(path.join(electronDirectory, "checksums.json"), JSON.stringify({ [fileName]: archiveSha }));

  await ensureElectronRuntime(appDirectory, {
    env: { ...process.env, electron_config_cache: path.join(fixture.directory, "electron-cache") },
    homeDir: fixture.homeDirectory,
    ...(process.platform === "win32"
      ? {}
      : {
          extract: async (_archive, { dir }) => {
            await mkdir(path.join(dir, path.dirname(executable)), { recursive: true });
            await writeFile(path.join(dir, "version"), "42.3.0\n");
            await writeFile(path.join(dir, executable), "cached runtime\n");
          },
        }),
  });

  assert.equal(await readFile(path.join(electronDirectory, "path.txt"), "utf8"), executable);
  assert.equal((await readFile(path.join(electronDirectory, "dist", "version"), "utf8")).trim(), "42.3.0");
  assert.equal(await readFile(path.join(electronDirectory, "dist", executable), "utf8"), "cached runtime\n");
});
