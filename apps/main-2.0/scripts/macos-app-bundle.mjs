// Shared bundle assembly. Only newly allocated temporary output is mutated.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isReleaseContentPath, stageProductionDependencies } from "./macos-runtime-dependencies.mjs";
import { generateIcnsFile } from "../bin/install-macos-app.cjs";
import { restoreEmbeddedPostgresNativeLinks } from "../bin/staged-package-dependencies.cjs";

export const MACOS_REVIEW_BUNDLE_ID = "dev.zszz3.agent-recall-v2.local-review";
const machOMagic = new Set(["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
async function isMachO(file) {
  const handle = await fs.open(file, "r");
  try { const header = Buffer.alloc(4); await handle.read(header, 0, 4, 0); return machOMagic.has(header.toString("hex")); }
  finally { await handle.close(); }
}
async function walk(root, visit) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(file, visit);
    await visit(file, entry);
  }
}

// Explicit inside-out ad-hoc phase. A future approved release signer belongs
// here, before verification/DMG creation; this implementation accepts no identity
// or credentials and never invokes notarytool, stapler, or a timestamp service.
export async function signMacosAppAdHoc(appPath) {
  const nested = [];
  await walk(path.join(appPath, "Contents"), async (file, entry) => {
    if (entry.isFile() && await isMachO(file)) nested.push(file);
    else if (entry.isDirectory() && /\.(app|framework|xpc)$/.test(file)) nested.push(file);
  });
  for (const file of nested) execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", file], { stdio: "pipe" });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", appPath], { stdio: "pipe" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
  return { mode: "ad-hoc", nestedItems: nested.length, developerId: "NOT PERFORMED", notarization: "NOT PERFORMED", stapling: "NOT PERFORMED" };
}

export async function verifyMacosApp(appPath) {
  const contents = path.join(appPath, "Contents");
  const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(contents, "Info.plist")], { encoding: "utf8" }));
  for (const key of ["CFBundleName", "CFBundleDisplayName", "CFBundleExecutable"]) assert.equal(plist[key], "AgentRecall", key);
  assert.equal(plist.CFBundleIdentifier, MACOS_REVIEW_BUNDLE_ID);
  assert.equal(plist.CFBundlePackageType, "APPL");
  assert.equal(path.basename(plist.CFBundleIconFile), plist.CFBundleIconFile);
  const iconFile = await fs.readFile(path.join(contents, "Resources", plist.CFBundleIconFile));
  assert.equal(iconFile.subarray(0, 4).toString("ascii"), "icns");
  assert.ok(iconFile.length > 8, "App icon must contain image data");
  for (const leftover of ["default_app.asar", "electron.icns"]) await assert.rejects(fs.access(path.join(contents, "Resources", leftover)), { code: "ENOENT" });
  await fs.access(path.join(contents, "Frameworks/Electron Framework.framework"));
  const executable = path.join(contents, "MacOS/AgentRecall");
  await fs.access(executable, fs.constants.X_OK);
  assert.ok(await isMachO(executable), "AgentRecall executable must be Mach-O");
  await assert.rejects(fs.access(path.join(contents, "MacOS/Electron")), { code: "ENOENT" });
  const appRoot = path.join(contents, "Resources/app");
  const manifest = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "agent-recall-v2");
  assert.equal(manifest.productName, "AgentRecall");
  for (const file of [manifest.main, "out/preload/index.mjs", "out/renderer/index.html", "out/mcp/skill-entry.js"]) await fs.access(path.join(appRoot, file));
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
  return { status: "PASS", plist, executable: "Mach-O", signature: "ad-hoc verified" };
}

export async function assembleMacosApp(packageRoot) {
  if (process.platform !== "darwin") throw new Error("Local macOS packaging requires macOS.");
  packageRoot = await fs.realpath(packageRoot);
  for (const file of ["package.json", "out/main/index.js", "out/preload/index.mjs", "out/renderer/index.html", "out/mcp/skill-entry.js", "assets/app-icon.png"]) await fs.access(path.join(packageRoot, file));
  const runtime = path.join(packageRoot, "node_modules/electron/dist/Electron.app");
  await fs.access(path.join(runtime, "Contents/MacOS/Electron"));
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-release-app-"));
  const appPath = path.join(outputRoot, "AgentRecall.app");
  try {
    await fs.cp(runtime, appPath, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
    const contents = path.join(appPath, "Contents");
    const resources = path.join(contents, "Resources");
    const appRoot = path.join(resources, "app");
    await fs.mkdir(appRoot);
    for (const entry of ["out", "bin", "assets", "THIRD_PARTY_NOTICES.md"]) {
      await fs.cp(path.join(packageRoot, entry), path.join(appRoot, entry), {
        recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE,
        filter: source => isReleaseContentPath(path.relative(packageRoot, source)),
      });
    }
    // npm/CLI/update identity is intentionally independent of macOS branding.
    const runtimeManifest = Object.fromEntries(Object.entries(manifest).filter(([key]) => !["scripts", "devDependencies"].includes(key)));
    await fs.writeFile(path.join(appRoot, "package.json"), JSON.stringify({ ...runtimeManifest, productName: "AgentRecall" }, null, 2));
    const dependencies = await stageProductionDependencies(packageRoot, path.join(appRoot, "node_modules"));
    await restoreEmbeddedPostgresNativeLinks(path.join(appRoot, "node_modules"));
    const executable = path.join(contents, "MacOS/AgentRecall");
    await fs.rename(path.join(contents, "MacOS/Electron"), executable);
    const plist = path.join(contents, "Info.plist");
    for (const [key, value] of Object.entries({
      CFBundleName: "AgentRecall", CFBundleDisplayName: "AgentRecall", CFBundleIdentifier: MACOS_REVIEW_BUNDLE_ID,
      CFBundleExecutable: "AgentRecall", CFBundleIconFile: "AppIcon.icns",
      CFBundleVersion: manifest.version, CFBundleShortVersionString: manifest.version,
    })) execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
    execFileSync("/usr/bin/plutil", ["-remove", "ElectronAsarIntegrity", plist]);
    await fs.rm(path.join(resources, "default_app.asar"));
    await fs.rm(path.join(resources, "electron.icns"));
    const icon = generateIcnsFile(path.join(packageRoot, "assets/app-icon.png"), outputRoot);
    if (!icon) throw new Error("Could not generate the app icon.");
    await fs.copyFile(icon, path.join(resources, "AppIcon.icns"));
    const signing = await signMacosAppAdHoc(appPath);
    const verification = await verifyMacosApp(appPath);
    const cliPath = path.join(outputRoot, "agent-recall-v2-local");
    await fs.writeFile(cliPath, '#!/bin/sh\nexec "$(dirname "$0")/AgentRecall.app/Contents/MacOS/AgentRecall" "$@"\n', { mode: 0o755 });
    return { outputRoot, appPath, executable, cliPath, dependencies, signing, verification,
      bundleIdentifierDecision: "TEAM_DECISION_REQUIRED: retained existing local-review ID; no formal native-app ID established" };
  } catch (error) {
    await fs.rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
}
