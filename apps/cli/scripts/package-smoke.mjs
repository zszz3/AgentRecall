import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isolatedEnvironment } from "./isolated-environment.mjs";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-cli-package-"));
try {
  const env = isolatedEnvironment(testHome);
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this check with npm run package:smoke:cli.");
  const run = (file, args, cwd = testHome) => {
    const result = spawnSync(file, args, { cwd, env, encoding: "utf8", timeout: 60_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd);
  // npm 10/11 return an array; npm 12 keys this result by package name.
  const [packed] = Object.values(JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--workspaces=false", "--pack-destination", testHome], process.cwd())));
  assert.ok(packed.files.some((file) => file.path === "THIRD_PARTY_NOTICES.md"));
  assert.ok(packed.files.some((file) => file.path === "LICENSE"));
  assert.ok(!packed.files.some((file) => file.path.startsWith("src/") || file.path.startsWith("test/")));
  const archive = path.join(testHome, packed.filename);
  const prefix = env.npm_config_prefix;
  const install = () => npm(["install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", archive]);
  install();
  const packageDirectory = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "agentrecall-cli");
  const bin = path.join(packageDirectory, "bin", "agentrecall.mjs");
  const shim = process.platform === "win32" ? path.join(prefix, "agentrecall.cmd") : path.join(prefix, "bin", "agentrecall");
  assert.ok(fs.existsSync(shim));
  const command = (args, cwd) => JSON.parse(run(process.execPath, [bin, ...args, "--json"], cwd)).data;
  assert.equal(command(["init"]).config.teamEnabled, false);
  const project = path.join(testHome, "business repo");
  fs.mkdirSync(project);
  run("git", ["init", "-q", project]);
  run("git", ["-C", project, "remote", "add", "origin", "git@github.com:example/business.git"]);
  command(["team", "add", "example", "--repo", "https://github.com/example/assets"]);
  command(["project", "add", "business", "--path", project, "--team", "example"]);
  command(["team", "enable"]);
  assert.equal(command(["team", "current"], project).team.id, "example");
  assert.equal(command(["status", "--project", "business"]).project.id, "business");
  const config = path.join(env.AGENTRECALL_HOME, "config.json");
  const before = fs.readFileSync(config, "utf8");
  // Reinstall exercises the update path without publishing or contacting a registry.
  install();
  assert.equal(command(["doctor"], project).project.id, "business");
  assert.equal(fs.readFileSync(config, "utf8"), before);
  npm(["uninstall", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "agentrecall-cli"]);
  assert.ok(!fs.existsSync(packageDirectory));
  assert.ok(!fs.existsSync(shim));
  assert.equal(fs.readFileSync(config, "utf8"), before);
  console.log("Standalone CLI pack/install/reinstall/uninstall passed in an isolated HOME and npm prefix.");
} finally { fs.rmSync(testHome, { recursive: true, force: true }); }
