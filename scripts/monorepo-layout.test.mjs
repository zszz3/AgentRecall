import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = JSON.parse(await readFile("package.json", "utf8"));
const v1 = JSON.parse(await readFile("apps/main-1.0/package.json", "utf8"));
const v2 = JSON.parse(await readFile("apps/main-2.0/package.json", "utf8"));

test("keeps V1 and V2 as independent app packages", () => {
  assert.equal(root.private, true);
  assert.equal(root.workspaces, undefined);
  assert.equal(v1.name, "agent-recall");
  assert.equal(v2.name, "agent-recall-v2");
  assert.notEqual(v1.productName, v2.productName);
});

test("exposes explicit root commands for both apps", () => {
  assert.match(root.scripts["setup:v1"], /setup-app\.mjs apps\/main-1\.0/);
  assert.match(root.scripts["setup:v2"], /setup-app\.mjs apps\/main-2\.0/);
  assert.match(root.scripts["dev:v1"], /apps\/main-1\.0/);
  assert.match(root.scripts["dev:v2"], /apps\/main-2\.0/);
  assert.match(root.scripts.test, /test:repo/);
  assert.match(root.scripts.test, /test:v1/);
  assert.match(root.scripts.test, /test:v2/);
  assert.match(root.scripts["package:smoke:all"], /run-package-smokes\.mjs/);
});

test("runs independent V1 and V2 package smokes concurrently", async () => {
  const smokeRunner = await readFile("scripts/run-package-smokes.mjs", "utf8");
  assert.match(smokeRunner, /directory:\s*"apps\/main-1\.0"/);
  assert.match(smokeRunner, /directory:\s*"apps\/main-2\.0"/);
  assert.match(smokeRunner, /Promise\.allSettled\(applications\.map\(runPackageSmoke\)\)/);
});

test("installs app dependencies without changing the user's Claude statusline", async () => {
  const setupScript = await readFile("scripts/setup-app.mjs", "utf8");
  assert.match(setupScript, /AGENT_RECALL_SKIP_STATUSLINE_INSTALL:\s*"1"/);
  assert.doesNotMatch(setupScript, /--ignore-scripts/);
});
