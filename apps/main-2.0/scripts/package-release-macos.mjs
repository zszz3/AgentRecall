#!/usr/bin/env node
// Local release candidate only: no installation, publication, or Apple credentials.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleMacosApp } from "./macos-app-bundle.mjs";
import { auditMacosRelease } from "./macos-release-audit.mjs";
import { createMacosDmg } from "./macos-dmg.mjs";
const sourceRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
export async function packageReleaseMacosApp(packageRoot = sourceRoot) {
  const bundle = await assembleMacosApp(packageRoot);
  try {
    const audit = await auditMacosRelease(bundle.appPath);
    const dmg = await createMacosDmg(bundle);
    const result = { ...bundle, audit, dmg, status: "LOCAL_RELEASE_CANDIDATE", signingApproval: "AWAITING_TEAM_APPROVAL",
      visualPolish: "GUIDED_DRAG_INSTALL: fixed Finder layout, arrow background and native auto-open metadata; no build-time GUI scripting" };
    // Reports are siblings, never inside the App or DMG.
    await fs.writeFile(path.join(bundle.outputRoot, "release-candidate.json"), JSON.stringify(result, null, 2) + "\n");
    return result;
  } catch (error) {
    // Retain the backing image if macOS refused to detach its owned mount.
    if (!error.mountRetained) await fs.rm(bundle.outputRoot, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await packageReleaseMacosApp(), null, 2));
