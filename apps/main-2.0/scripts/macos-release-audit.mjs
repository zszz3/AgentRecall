// Audit the staged release artifact, never source/home data. No secret values
// are included in errors: only the offending artifact-relative path is emitted.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isReleaseContentPath } from "./macos-runtime-dependencies.mjs";

export async function auditMacosRelease(appPath) {
  const root = await fs.realpath(appPath);
  const realHome = os.userInfo().homedir;
  const forbiddenHome = [realHome, realHome.replace(/^\/Users\//, "/System/Volumes/Data/Users/")].map(value => Buffer.from(value));
  const sizes = { electron: 0, dependencies: 0, appResources: 0, other: 0, total: 0 };
  let files = 0;
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(file);
        if (!target.startsWith(root + path.sep)) throw new Error(`Artifact link escapes app: ${relative}`);
        continue;
      }
      const inApp = relative.startsWith("Contents/Resources/app/");
      if (inApp && !isReleaseContentPath(relative.slice("Contents/Resources/app/".length))) throw new Error(`Unwanted release content: ${relative}`);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile()) throw new Error(`Unexpected artifact entry: ${relative}`);
      files++;
      const stat = await fs.stat(file);
      sizes.total += stat.size;
      const category = relative.startsWith("Contents/Frameworks/") || relative.startsWith("Contents/MacOS/") ? "electron"
        : relative.startsWith("Contents/Resources/app/node_modules/") ? "dependencies"
        : relative.startsWith("Contents/Resources/app/") ? "appResources" : "other";
      sizes[category] += stat.size;
      // Streaming scans also cover native binaries and large generated bundles.
      const handle = await fs.open(file, "r");
      try {
        let tail = Buffer.alloc(0);
        const buffer = Buffer.alloc(1024 * 1024);
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          const content = Buffer.concat([tail, buffer.subarray(0, bytesRead)]);
          if (forbiddenHome.some(value => content.includes(value))) throw new Error(`Build-host home path in artifact: ${relative}`);
          const text = content.toString("utf8");
          if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{32,}/.test(text)
            || /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|sk-proj-[A-Za-z0-9_-]{40,})\b/.test(text)) {
            throw new Error(`Credential-like material in artifact: ${relative}`);
          }
          tail = content.subarray(Math.max(0, content.length - 512));
        }
      } finally { await handle.close(); }
    }
  }
  await visit(root);
  return { status: "PASS", files, sizes, checks: ["closed app symlinks", "no excluded test/source artifacts", "no build-host home paths", "no private keys or recognized token patterns"],
    boundary: "Allowlisted build inputs plus content checks; not proof against every possible secret format." };
}
