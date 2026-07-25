import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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
const appData = path.join(tempRoot, "app-data");
const localAppData = path.join(tempRoot, "local-app-data");
const xdgConfig = path.join(tempRoot, "xdg-config");
const xdgCache = path.join(tempRoot, "xdg-cache");
const npmCache = path.join(tempRoot, "npm-cache");
const electronCache = path.join(tempRoot, "electron-cache");
const npmUserConfig = path.join(tempRoot, "npmrc");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_CACHE_HOME: xdgCache,
  CODEX_HOME: path.join(home, ".codex"),
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  AGENT_RECALL_TEST_HOME: home,
  AGENT_RECALL_CONFIG: path.join(home, ".agent-recall", "config.json"),
  AGENT_RECALL_DB: path.join(home, ".agent-recall", "session-search.sqlite"),
  AGENT_RECALL_SYNC_QUEUE: path.join(home, ".agent-recall", "session-sync-queue"),
  AGENT_RECALL_CLAUDE_STATUSLINE: path.join(home, ".claude", "statusline-snapshot.json"),
  AGENT_RECALL_SKILL_USAGE: path.join(home, ".claude", "skill-usage.jsonl"),
  AGENT_RECALL_NO_UPDATE_CHECK: "1",
  ELECTRON_CACHE: electronCache,
  npm_config_prefix: prefix,
  npm_config_cache: npmCache,
  npm_config_userconfig: npmUserConfig,
  npm_config_ignore_scripts: "false",
  CI: "",
};
for (const key of Object.keys(environment)) {
  const normalized = key.toLowerCase();
  if (
    normalized === "agent_recall_skip_statusline_install"
    || (key !== "CI" && normalized === "ci")
    || (key !== "npm_config_prefix" && normalized === "npm_config_prefix")
    || (key !== "npm_config_cache" && normalized === "npm_config_cache")
    || (key !== "npm_config_userconfig" && normalized === "npm_config_userconfig")
    || (key !== "npm_config_ignore_scripts" && normalized === "npm_config_ignore_scripts")
  ) {
    delete environment[key];
  }
}

try {
  await Promise.all(
    [
      packDir,
      prefix,
      home,
      appData,
      localAppData,
      xdgConfig,
      xdgCache,
      npmCache,
      electronCache,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
  await writeFile(npmUserConfig, "registry=https://registry.npmjs.org/\n", "utf8");
  await seedProtectedConfiguration();
  const beforeInstall = await snapshotProtectedConfiguration();
  await assertNoInstallLifecycle(path.join(root, "package.json"));

  await execFileAsync(npm, ["run", "build"], {
    cwd: root,
    env: environment,
    shell: process.platform === "win32",
    timeout: 10 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  await assertSandboxedPreloadBundle();
  const { stdout } = await execFileAsync(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], {
    cwd: root,
    env: environment,
    shell: process.platform === "win32",
    timeout: 10 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const json = stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/)?.[1];
  if (!json) throw new Error("npm pack did not emit a trailing JSON result.");
  const [packed] = JSON.parse(json);
  if (!packed?.filename) throw new Error("npm pack did not return an archive name.");
  const archive = path.join(packDir, packed.filename);
  await execFileAsync(
    npm,
    [
      "install",
      "--global",
      archive,
      "--prefix",
      prefix,
      "--ignore-scripts=false",
      "--foreground-scripts",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: root,
      env: environment,
      shell: process.platform === "win32",
      timeout: 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const packageRoots = process.platform === "win32"
    ? [path.join(prefix, "node_modules", "agent-recall")]
    : [path.join(prefix, "lib", "node_modules", "agent-recall"), path.join(prefix, "node_modules", "agent-recall")];
  let installedRoot = null;
  for (const candidate of packageRoots) {
    try { await access(path.join(candidate, "package.json")); installedRoot = candidate; break; } catch { /* try the next npm layout */ }
  }
  if (!installedRoot) throw new Error("Could not locate the package installed into the temporary npm prefix.");
  await assertNoInstallLifecycle(path.join(installedRoot, "package.json"));
  await access(path.join(installedRoot, "out", "main", "index.js"));
  await access(path.join(installedRoot, "out", "preload", "index.cjs"));
  await access(path.join(installedRoot, "bin", "uninstall.cjs"));
  await access(
    process.platform === "win32"
      ? path.join(prefix, "agent-recall.cmd")
      : path.join(prefix, "bin", "agent-recall"),
  );
  const { stdout: version } = await execFileAsync(process.execPath, [path.join(installedRoot, "bin", "agent-recall.cjs"), "--version"], { env: environment });
  const packageVersion = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).version;
  if (version.trim() !== packageVersion) throw new Error(`Packaged CLI reported ${version.trim()} instead of ${packageVersion}.`);
  assert.deepEqual(
    await snapshotProtectedConfiguration(),
    beforeInstall,
    "Package build/install changed a protected Claude, Codex, or shell configuration fixture.",
  );
  process.stdout.write(`Package smoke test passed for v${packageVersion} (${process.platform}).\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function assertNoInstallLifecycle(packagePath) {
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    assert.equal(
      Object.hasOwn(manifest.scripts ?? {}, lifecycle),
      false,
      `${packagePath} must not define an automatic ${lifecycle} lifecycle.`,
    );
  }
}

async function assertSandboxedPreloadBundle() {
  const preloadDirectory = path.join(root, "out", "preload");
  const javaScriptFiles = (await readdir(preloadDirectory))
    .filter((fileName) => /\.(?:cjs|mjs|js)$/.test(fileName))
    .sort();
  assert.deepEqual(
    javaScriptFiles,
    ["index.cjs"],
    "Sandboxed production preload must be one CommonJS bundle.",
  );
  const source = await readFile(path.join(preloadDirectory, "index.cjs"), "utf8");
  const externalModules = [...source.matchAll(/\brequire\((["'])([^"']+)\1\)/g)]
    .map((match) => match[2])
    .filter((moduleName) => moduleName !== "electron");
  assert.deepEqual(
    [...new Set(externalModules)],
    [],
    `Sandboxed preload contains unsupported external modules: ${externalModules.join(", ")}`,
  );
  for (const channel of [
    "ai:assistant-chat",
    "mcp:status",
    "quota:get",
    "remote-session:",
    "skills:",
    "session:migrate",
    "codex-profile:",
  ]) {
    assert.equal(
      source.includes(channel),
      false,
      `Production preload unexpectedly contains advanced channel ${channel}.`,
    );
  }
}

async function seedProtectedConfiguration() {
  const fixtures = new Map([
    [
      path.join(home, ".claude", "settings.json"),
      `${JSON.stringify({ theme: "dark", statusLine: { type: "command", command: "keep-statusline" } }, null, 2)}\n`,
    ],
    [
      path.join(home, ".claude.json"),
      `${JSON.stringify({ mcpServers: { keep: { command: "keep-mcp" } } }, null, 2)}\n`,
    ],
    [path.join(home, ".codex", "config.toml"), '[mcp_servers.keep]\ncommand = "keep-mcp"\n'],
    [
      path.join(home, ".codex", "hooks.json"),
      `${JSON.stringify({ hooks: { Stop: [{ command: "keep-hook" }] } }, null, 2)}\n`,
    ],
    [
      path.join(home, ".codebuddy", "mcp.json"),
      `${JSON.stringify({ mcpServers: { keep: { command: "keep-mcp" } } }, null, 2)}\n`,
    ],
    [path.join(home, ".zshrc"), "# keep-zsh\n"],
    [path.join(home, ".bashrc"), "# keep-bash\n"],
    [path.join(home, ".bash_profile"), "# keep-bash-profile\n"],
    [path.join(home, ".profile"), "# keep-profile\n"],
    [
      path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
      "# keep-powershell\n",
    ],
    [
      path.join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
      "# keep-windows-powershell\n",
    ],
    [
      path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      `${JSON.stringify({ mcpServers: { keep: { command: "keep-desktop-mcp" } } }, null, 2)}\n`,
    ],
    [
      path.join(appData, "Claude", "claude_desktop_config.json"),
      `${JSON.stringify({ mcpServers: { keep: { command: "keep-desktop-mcp" } } }, null, 2)}\n`,
    ],
    [
      path.join(xdgConfig, "Claude", "claude_desktop_config.json"),
      `${JSON.stringify({ mcpServers: { keep: { command: "keep-desktop-mcp" } } }, null, 2)}\n`,
    ],
  ]);
  for (const [filePath, contents] of fixtures) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
}

async function snapshotProtectedConfiguration() {
  return {
    home: await snapshotTree(home),
    appData: await snapshotTree(appData),
    xdgConfig: await snapshotTree(xdgConfig),
  };
}

async function snapshotTree(rootDirectory) {
  const snapshot = {};
  await walk(rootDirectory, "");
  return snapshot;

  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${relativePath}${path.sep}`] = "directory";
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        snapshot[relativePath] = (await readFile(absolutePath)).toString("base64");
      } else {
        snapshot[relativePath] = "other";
      }
    }
  }
}
