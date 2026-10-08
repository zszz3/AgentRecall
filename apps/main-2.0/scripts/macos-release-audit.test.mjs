import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditMacosRelease } from "./macos-release-audit.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-audit-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, "AgentRecall.app");
  await fs.mkdir(path.join(app, "Contents/Resources/app"), { recursive: true });
  return { app, resources: path.join(app, "Contents/Resources/app"), root };
}
test("release audit counts bytes while preserving runtime assets and internal links", async t => {
  const { app, resources } = await fixture(t);
  await fs.writeFile(path.join(resources, "package.json"), "{}");
  await fs.symlink("package.json", path.join(resources, "manifest-link"));
  const audit = await auditMacosRelease(app);
  assert.equal(audit.status, "PASS"); assert.equal(audit.sizes.total, 2); assert.equal(audit.files, 1);
});
for (const [name, file, text] of [
  ["environment file", ".env", "SYNTHETIC=1"],
  ["source map", "index.js.map", "{}"],
  ["private-key material", "key.txt", "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(64)],
  ["build-host path", "index.js", os.userInfo().homedir + "/synthetic-source.js"],
]) test(`release audit rejects ${name}`, async t => {
  const { app, resources } = await fixture(t);
  await fs.writeFile(path.join(resources, file), text);
  await assert.rejects(auditMacosRelease(app), /Unwanted release content|Credential-like material|Build-host home path/);
});
test("release audit rejects a link outside the app", async t => {
  const { app, resources, root } = await fixture(t);
  await fs.writeFile(path.join(root, "outside"), "synthetic");
  await fs.symlink(path.join(root, "outside"), path.join(resources, "escape"));
  await assert.rejects(auditMacosRelease(app), /escapes app/);
});
