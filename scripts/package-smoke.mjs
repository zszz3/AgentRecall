import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-recall-package-smoke-"));
const packDir = path.join(tempRoot, "pack");
const prefix = path.join(tempRoot, "prefix");
const home = path.join(tempRoot, "home");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  AGENT_RECALL_TEST_HOME: home,
  AGENT_RECALL_SKIP_STATUSLINE_INSTALL: "1",
  AGENT_RECALL_NO_UPDATE_CHECK: "1",
};

try {
  await Promise.all([packDir, prefix, home].map((directory) => mkdir(directory, { recursive: true })));
  const { stdout } = await execFileAsync(npm, ["pack", "--json", "--pack-destination", packDir], {
    cwd: root,
    env: environment,
    shell: process.platform === "win32",
    maxBuffer: 8 * 1024 * 1024,
  });
  const json = stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/)?.[1];
  if (!json) throw new Error("npm pack did not emit a trailing JSON result.");
  const [packed] = JSON.parse(json);
  if (!packed?.filename) throw new Error("npm pack did not return an archive name.");
  const archive = path.join(packDir, packed.filename);
  await execFileAsync(npm, ["install", "--global", archive, "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: root,
    env: environment,
    shell: process.platform === "win32",
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const packageRoots = process.platform === "win32"
    ? [path.join(prefix, "node_modules", "agent-recall")]
    : [path.join(prefix, "lib", "node_modules", "agent-recall"), path.join(prefix, "node_modules", "agent-recall")];
  let installedRoot = null;
  for (const candidate of packageRoots) {
    try { await access(path.join(candidate, "package.json")); installedRoot = candidate; break; } catch { /* try the next npm layout */ }
  }
  if (!installedRoot) throw new Error("Could not locate the package installed into the temporary npm prefix.");
  await access(path.join(installedRoot, "out", "main", "index.js"));
  await access(path.join(installedRoot, "bin", "uninstall.cjs"));
  const { stdout: version } = await execFileAsync(process.execPath, [path.join(installedRoot, "bin", "agent-recall.cjs"), "--version"], { env: environment });
  const packageVersion = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).version;
  if (version.trim() !== packageVersion) throw new Error(`Packaged CLI reported ${version.trim()} instead of ${packageVersion}.`);
  process.stdout.write(`Package smoke test passed for v${packageVersion} (${process.platform}).\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
