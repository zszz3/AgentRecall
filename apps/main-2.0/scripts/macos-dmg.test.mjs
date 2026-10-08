import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createMacosDmg, verifyMacosDmg } from "./macos-dmg.mjs";

async function syntheticApp(root) {
  assert.equal(process.platform, "darwin");
  const appPath = path.join(root, "AgentRecall.app");
  await fs.mkdir(path.join(appPath, "Contents/MacOS"), { recursive: true });
  await fs.writeFile(path.join(appPath, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.agentrecall.dmg-test</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleName</key><string>AgentRecall</string><key>CFBundleExecutable</key><string>AgentRecall</string></dict></plist>');
  // Match the real App's embedded Mach-O signature. A signed shell fixture
  // relies on executable xattrs, which makehybrid does not preserve.
  execFileSync("/usr/bin/cc", ["-x", "c", "-", "-o", path.join(appPath, "Contents/MacOS/AgentRecall")], {
    input: "int main(void) { return 0; }\n", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000,
  });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", appPath], { stdio: "pipe", timeout: 30_000 });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe", timeout: 30_000 });
  return appPath;
}

test("DMG packaging rejects missing inputs without leaving artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentrecall-dmg-input-"));
  try {
    await assert.rejects(createMacosDmg({ appPath: path.join(root, "AgentRecall.app"), outputRoot: root }),
      process.platform === "darwin" ? /ENOENT/ : /requires macOS/);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("DMG packaging preserves an existing artifact and input App", { skip: process.platform !== "darwin" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentrecall-dmg-existing-"));
  try {
    const appPath = await syntheticApp(root);
    const executable = path.join(appPath, "Contents/MacOS/AgentRecall");
    const originalHash = createHash("sha256").update(await fs.readFile(executable)).digest("hex");
    const dmgPath = path.join(root, "AgentRecall.dmg");
    await fs.writeFile(dmgPath, "existing artifact");
    await assert.rejects(createMacosDmg({ appPath, outputRoot: root }), /Refusing to overwrite/);
    assert.equal(await fs.readFile(dmgPath, "utf8"), "existing artifact");
    assert.equal(createHash("sha256").update(await fs.readFile(executable)).digest("hex"), originalHash);
    assert.deepEqual((await fs.readdir(root)).sort(), ["AgentRecall.app", "AgentRecall.dmg"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("native DMG preserves its visible drag-install pair and hidden Finder presentation", { skip: process.platform !== "darwin", timeout: 120_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentrecall-dmg-native-"));
  try {
    const appPath = await syntheticApp(root);
    const original = await fs.readFile(path.join(appPath, "Contents/Info.plist"), "utf8");
    const result = await createMacosDmg({ appPath, outputRoot: root });
    assert.equal(result.dmgPath, path.join(await fs.realpath(root), "AgentRecall.dmg"));
    assert.equal(result.volumeName, "AgentRecall");
    assert.ok(result.sizeBytes > 0);
    assert.equal(result.verification.verified, true);
    assert.equal(result.verification.mountedReadOnly, true);
    assert.equal(result.verification.volumeName, "AgentRecall");
    assert.deepEqual(result.verification.visibleContents, ["AgentRecall.app", "Applications"]);
    assert.deepEqual(result.verification.contents, [".DS_Store", ".background", "AgentRecall.app", "Applications"]);
    assert.equal(result.verification.applicationsTarget, "/Applications");
    assert.equal(result.verification.autoOpenRoot, true);
    assert.equal(result.verification.mountedAppSignature, "PASS");
    assert.equal(result.verification.detached, true);
    assert.deepEqual(await verifyMacosDmg(result.dmgPath), result.verification);
    assert.equal(await fs.readFile(path.join(appPath, "Contents/Info.plist"), "utf8"), original);
    assert.deepEqual((await fs.readdir(root)).sort(), ["AgentRecall.app", "AgentRecall.dmg"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("DMG content validation rejects unexpected files and detaches its failed mount", { skip: process.platform !== "darwin", timeout: 120_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentrecall-dmg-invalid-"));
  try {
    const stage = path.join(root, "stage");
    await fs.mkdir(stage);
    await syntheticApp(stage);
    await fs.symlink("/Applications", path.join(stage, "Applications"));
    await fs.writeFile(path.join(stage, "unexpected-review-data.txt"), "Synthetic fixture, never user data.");
    const dmgPath = path.join(root, "invalid.dmg");
    execFileSync("/usr/bin/hdiutil", ["create", "-volname", "AgentRecall", "-srcfolder", stage, "-fs", "HFS+", "-format", "UDZO", dmgPath], { stdio: "pipe", timeout: 60_000 });
    await assert.rejects(verifyMacosDmg(dmgPath), /only the App, Applications shortcut/);
    const info = execFileSync("/usr/bin/hdiutil", ["info", "-plist"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(info.includes(dmgPath), false, "Rejected image must not remain attached.");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
