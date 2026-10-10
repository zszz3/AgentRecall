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

async function symlinkFixture(t, target, link) {
  try {
    await fs.symlink(target, link, "file");
    return true;
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error?.code)) throw error;
    t.skip("This Windows environment does not permit creating file symlinks.");
    return false;
  }
}

test("symlink fixtures skip only Windows permission errors", async t => {
  const skip = t.mock.fn();
  const context = { skip };
  const symlink = t.mock.method(fs, "symlink", async () => {});
  assert.equal(await symlinkFixture(context, "target", "link"), true);
  assert.equal(skip.mock.callCount(), 0);

  for (const code of ["EPERM", "EACCES", "EIO", "ENOENT"]) {
    skip.mock.resetCalls();
    const error = Object.assign(new Error("synthetic symlink failure"), { code });
    symlink.mock.mockImplementation(async () => { throw error; });
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(code)) {
      assert.equal(await symlinkFixture(context, "target", "link"), false);
      assert.equal(skip.mock.callCount(), 1);
    } else {
      await assert.rejects(symlinkFixture(context, "target", "link"), actual => actual === error);
      assert.equal(skip.mock.callCount(), 0);
    }
  }
});

test("release audit counts bytes while preserving runtime assets", async t => {
  const { app, resources } = await fixture(t);
  await fs.writeFile(path.join(resources, "package.json"), "{}");
  const audit = await auditMacosRelease(app);
  assert.equal(audit.status, "PASS"); assert.equal(audit.sizes.total, 2); assert.equal(audit.files, 1);
});
test("release audit does not count internal symlink targets twice", async t => {
  const { app, resources } = await fixture(t);
  await fs.writeFile(path.join(resources, "package.json"), "{}");
  if (!await symlinkFixture(t, "package.json", path.join(resources, "manifest-link"))) return;
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
  if (!await symlinkFixture(t, path.join(root, "outside"), path.join(resources, "escape"))) return;
  await assert.rejects(auditMacosRelease(app), /escapes app/);
});
