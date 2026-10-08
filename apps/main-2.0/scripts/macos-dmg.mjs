import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeMacosFinderLayout, verifyMacosFinderLayout } from "./macos-finder-layout.mjs";
import { createDmgBackgroundAlias } from "./macos-finder-alias.mjs";

const VOLUME_NAME = "AgentRecall";
const VISIBLE_CONTENTS = ["AgentRecall.app", "Applications"];
const EXPECTED_CONTENTS = [".DS_Store", ".background", ...VISIBLE_CONTENTS];
const backgroundSource = fileURLToPath(new URL("./assets/dmg-background.svg", import.meta.url));

function requireMacos() {
  if (process.platform !== "darwin") throw new Error("macOS DMG packaging requires macOS.");
}

function plistResult(command, args) {
  const plist = execFileSync(command, args, { encoding: "utf8", timeout: 60_000 });
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: plist, encoding: "utf8", timeout: 10_000,
  }));
}

async function mountedBackgroundAlias(mountPoint) {
  const [volume, parent, target] = await Promise.all([
    fs.stat(mountPoint), fs.stat(path.join(mountPoint, ".background")),
    fs.stat(path.join(mountPoint, ".background/background.png")),
  ]);
  return createDmgBackgroundAlias({ volumeCreatedAtMs: volume.birthtimeMs, parentId: parent.ino, targetId: target.ino });
}

// Mount only at a fresh owned location. Verification failures must not leave a
// mounted image behind; removing a directory is never a substitute for ejecting.
async function withOwnedMount(dmgPath, readOnly, inspect) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agentrecall-dmg-mount-"));
  const mountPoint = path.join(scratch, "volume");
  await fs.mkdir(mountPoint);
  const parentDevice = (await fs.stat(mountPoint)).dev;
  const isMounted = async () => {
    try { return (await fs.stat(mountPoint)).dev !== parentDevice; }
    catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  };
  let mounted = false;
  let result;
  let failure;
  try {
    execFileSync("/usr/bin/hdiutil", ["attach", dmgPath, readOnly ? "-readonly" : "-readwrite", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint], {
      stdio: "pipe", timeout: 60_000,
    });
    mounted = true;
    result = await inspect(mountPoint);
  } catch (error) {
    failure = error;
  } finally {
    // attach may have mounted the volume before its subprocess failed/timed out.
    try {
      mounted ||= await isMounted();
    } catch (probeError) {
      const unknownMount = new AggregateError([failure, probeError].filter(Boolean), `Cannot establish mount state; backing image and owned mount retained at ${mountPoint}`);
      unknownMount.mountRetained = true;
      throw unknownMount;
    }
    if (mounted) {
      try {
        try {
          execFileSync("/usr/bin/hdiutil", ["detach", mountPoint], { stdio: "pipe", timeout: 30_000 });
        } catch {
          // Only the unique mount created above is eligible for a forced eject.
          execFileSync("/usr/bin/hdiutil", ["detach", "-force", mountPoint], { stdio: "pipe", timeout: 30_000 });
        }
        assert.equal(await isMounted(), false, "DMG mount remained after detach.");
        mounted = false;
      } catch (cleanupError) {
        failure = failure ? new AggregateError([failure, cleanupError], `DMG operation and detach failed; owned mount retained at ${mountPoint}`) : cleanupError;
        failure.mountRetained = true;
      }
    }
    if (!mounted) await fs.rm(scratch, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return result;
}

export async function verifyMacosDmg(dmgPath) {
  requireMacos();
  dmgPath = await fs.realpath(dmgPath);
  assert.ok((await fs.stat(dmgPath)).isFile(), "DMG input must be a file.");
  execFileSync("/usr/bin/hdiutil", ["verify", dmgPath], { stdio: "pipe", timeout: 120_000 });
  const verification = await withOwnedMount(dmgPath, true, async mountPoint => {
    const volume = plistResult("/usr/sbin/diskutil", ["info", "-plist", mountPoint]);
    assert.equal(volume.VolumeName, VOLUME_NAME);
    assert.equal(volume.WritableVolume, false);
    assert.equal(volume.WritableMedia, false);
    const contents = (await fs.readdir(mountPoint)).sort();
    assert.deepEqual(contents, EXPECTED_CONTENTS, "DMG root must contain only the App, Applications shortcut and generated Finder presentation metadata.");
    const app = await fs.lstat(path.join(mountPoint, "AgentRecall.app"));
    assert.ok(app.isDirectory() && !app.isSymbolicLink(), "DMG must contain the App bundle, not a reference to it.");
    const applicationsPath = path.join(mountPoint, "Applications");
    assert.ok((await fs.lstat(applicationsPath)).isSymbolicLink(), "Applications must be a symlink, never a copied directory.");
    assert.equal(await fs.readlink(applicationsPath), "/Applications");
    await fs.access(path.join(mountPoint, "AgentRecall.app/Contents/Info.plist"));
    await fs.access(path.join(mountPoint, "AgentRecall.app/Contents/MacOS/AgentRecall"), fs.constants.X_OK);
    const background = path.join(mountPoint, ".background");
    assert.deepEqual(await fs.readdir(background), ["background.png"]);
    const png = await fs.readFile(path.join(background, "background.png"));
    assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.equal(png.readUInt32BE(16), 720);
    assert.equal(png.readUInt32BE(20), 440);
    const layout = await verifyMacosFinderLayout(mountPoint);
    assert.deepEqual(layout.backgroundImageAlias, await mountedBackgroundAlias(mountPoint), "DMG background alias must reference this volume and PNG.");
    const finderInfo = plistResult("/usr/sbin/bless", ["--info", mountPoint, "--plist"])["Finder Info"];
    assert.equal(finderInfo[2]["Directory ID"], 2, "HFS root must be the auto-open folder");
    assert.equal(finderInfo[2]["Relative Path"], "/");
    // makehybrid can drop arbitrary xattrs; verify the embedded signature of
    // the actual mounted copy instead of assuming the input signature survived.
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", path.join(mountPoint, "AgentRecall.app")], { stdio: "pipe", timeout: 60_000 });
    return { verified: true, mountedReadOnly: true, volumeName: volume.VolumeName,
      contents, visibleContents: VISIBLE_CONTENTS, applicationsTarget: "/Applications",
      autoOpenRoot: true, mountedAppSignature: "PASS", layout };
  });
  return { ...verification, detached: true };
}

// The packaging owner validates App contents and identity. This helper owns
// the drag-install container and never signs, installs, or launches its App.
export async function createMacosDmg({ appPath, outputRoot }) {
  requireMacos();
  [appPath, outputRoot] = await Promise.all([fs.realpath(appPath), fs.realpath(outputRoot)]);
  assert.equal(path.basename(appPath), "AgentRecall.app");
  assert.equal(path.dirname(appPath), outputRoot, "App must belong to the supplied packaging output directory.");
  assert.ok(outputRoot !== "/Applications" && !outputRoot.startsWith("/Applications/"), "Packaging cannot write inside /Applications.");
  assert.ok((await fs.stat(appPath)).isDirectory());
  await fs.access(path.join(appPath, "Contents/Info.plist"));
  await fs.access(path.join(appPath, "Contents/MacOS/AgentRecall"), fs.constants.X_OK);
  const dmgPath = path.join(outputRoot, "AgentRecall.dmg");
  try {
    await fs.lstat(dmgPath);
    throw new Error(`Refusing to overwrite existing DMG: ${dmgPath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const scratch = await fs.mkdtemp(path.join(outputRoot, ".agentrecall-dmg-"));
  let retainMountedImage = false;
  try {
    const stage = path.join(scratch, "stage");
    await fs.mkdir(stage);
    await fs.cp(appPath, path.join(stage, "AgentRecall.app"), { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
    await fs.symlink("/Applications", path.join(stage, "Applications"));
    await fs.mkdir(path.join(stage, ".background"));
    execFileSync("/usr/bin/sips", ["-s", "format", "png", backgroundSource, "--out", path.join(stage, ".background/background.png")], { stdio: "pipe", timeout: 30_000 });
    await writeMacosFinderLayout(stage, { backgroundImageAlias: createDmgBackgroundAlias() });
    const intermediate = path.join(scratch, "layout.dmg");
    const writableImage = path.join(scratch, "layout-writable.dmg");
    const temporaryImage = path.join(scratch, "AgentRecall.dmg");
    // Persist the HFS root open-folder ID without changing Finder preferences,
    // scripting GUI timing, or requiring privileged bless mutations.
    execFileSync("/usr/bin/hdiutil", ["makehybrid", "-hfs", "-hfs-volume-name", VOLUME_NAME,
      "-hfs-openfolder", stage, "-o", intermediate, stage], { stdio: "pipe", timeout: 300_000 });
    execFileSync("/usr/bin/hdiutil", ["convert", intermediate, "-format", "UDRW", "-o", writableImage], {
      stdio: "pipe", timeout: 300_000,
    });
    await withOwnedMount(writableImage, false, async mountPoint => {
      await writeMacosFinderLayout(mountPoint, { backgroundImageAlias: await mountedBackgroundAlias(mountPoint), replaceExisting: true });
      const mountedApp = path.join(mountPoint, "AgentRecall.app");
      assert.ok((await fs.lstat(mountedApp)).isDirectory());
      // makehybrid adds Finder attributes which invalidate strict signatures.
      // Only remove those attributes from our image copy; -s never follows
      // symlinks to external targets. App bytes and embedded signatures remain.
      execFileSync("/usr/bin/xattr", ["-r", "-s", "-d", "com.apple.FinderInfo", mountedApp], { stdio: "pipe", timeout: 60_000 });
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", mountedApp], { stdio: "pipe", timeout: 60_000 });
    });
    execFileSync("/usr/bin/hdiutil", ["convert", writableImage, "-format", "UDZO", "-o", temporaryImage], {
      stdio: "pipe", timeout: 300_000,
    });
    const verification = await verifyMacosDmg(temporaryImage);
    // An exclusive hard link publishes the completed same-filesystem image
    // atomically, and cannot overwrite an artifact created concurrently.
    await fs.link(temporaryImage, dmgPath);
    return { dmgPath, volumeName: VOLUME_NAME, verification, sizeBytes: (await fs.stat(dmgPath)).size };
  } catch (error) {
    retainMountedImage = error.mountRetained === true;
    throw error;
  } finally {
    // Preserve the backing image if the OS refused even a forced eject.
    if (!retainMountedImage) await fs.rm(scratch, { recursive: true, force: true });
  }
}
