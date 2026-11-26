import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = JSON.parse(await readFile("package.json", "utf8"));
const app = JSON.parse(await readFile("apps/main-2.0/package.json", "utf8"));

test("ships a single unified desktop and CLI application package", async () => {
  assert.equal(root.private, true);
  assert.equal(root.workspaces, undefined);
  assert.equal(app.name, "agent-recall");
  assert.equal(app.productName, "AgentRecall");
  assert.equal(app.bin["agent-recall"], "bin/agent-recall.cjs");
  assert.equal(app.bin.agentrecall, "bin/agent-recall.cjs");
  assert.ok(app.files.includes("out/cli/*.js"));
  assert.equal(app.scripts.postinstall, "node bin/embedded-postgres-runtime.cjs");
  await assert.rejects(access("apps/main-1.0"), { code: "ENOENT" });
  await assert.rejects(access("apps/cli"), { code: "ENOENT" });
});

test("exposes unified root commands for the desktop app and CLI", () => {
  assert.match(root.scripts.setup, /setup-app\.mjs apps\/main-2\.0/);
  assert.match(root.scripts.dev, /apps\/main-2\.0/);
  assert.match(root.scripts.test, /test:repo/);
  assert.match(root.scripts.test, /apps\/main-2\.0/);
  assert.match(root.scripts["test:cli"], /apps\/main-2\.0 run test:cli/);
  assert.match(root.scripts["build:cli"], /apps\/main-2\.0 run build:cli/);
  assert.match(root.scripts["package:smoke"], /apps\/main-2\.0/);
  assert.match(root.scripts["release:preflight"], /release-note:check && npm run package:smoke/);
});

test("installs app dependencies without changing the user's Claude statusline", async () => {
  const setupScript = await readFile("scripts/setup-app.mjs", "utf8");
  assert.match(setupScript, /AGENT_RECALL_SKIP_STATUSLINE_INSTALL:\s*"1"/);
  assert.doesNotMatch(setupScript, /--ignore-scripts/);
});

test("hydrates and validates the Electron runtime after installing app dependencies", async () => {
  const setupScript = await readFile("scripts/setup-app.mjs", "utf8");
  assert.match(setupScript, /restoreEmbeddedPostgresNativeLinks/);
  assert.match(setupScript, /path\.join\(normalizedDirectory, "node_modules", "electron", "cli\.js"\)/);
  assert.match(setupScript, /process\.platform === "linux"/);
  assert.match(setupScript, /\[electronCli, "--no-sandbox", "--version"\]/);
  assert.match(setupScript, /runCommand\(process\.execPath, electronArguments/);
});
