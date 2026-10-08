import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeMacosFinderLayout, verifyMacosFinderLayout } from "./macos-finder-layout.mjs";
import { createDmgBackgroundAlias } from "./macos-finder-alias.mjs";

const macos = { skip: process.platform !== "darwin" };
// Alias resolution is checked independently against the mounted DMG. This
// fixture tests binary-data preservation without reaching Finder/user folders.
const syntheticAlias = Buffer.from("synthetic:AgentRecall:.background:background.png");

test("background aliases describe the final read-only image rather than the writable staging media", () => {
  const alias = createDmgBackgroundAlias({ volumeCreatedAtMs: 1_700_000_000_000, parentId: 19, targetId: 20 });
  // These are Alias v2 media fields. Native NULL-context resolution rejected
  // writable-media type 4 after the final DMG was opened by Finder.
  assert.equal(alias.readUInt16BE(44), 5);
  assert.equal(alias.readUInt32BE(134), 0x0902);
  assert.equal(alias.toString("ascii", 42, 44), "H+");
  assert.ok(alias.includes(Buffer.from("AgentRecall:.background:background.png")));
  assert.throws(() => createDmgBackgroundAlias({ parentId: -1 }), /catalog node ID/);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentrecall-finder-layout-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, ".background"));
  await fs.writeFile(path.join(directory, ".background/background.png"), "synthetic PNG input");
  return directory;
}

test("writes identical fixed layouts in different staging directories and decodes native binary plists", macos, async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const layout = await writeMacosFinderLayout(first, { backgroundImageAlias: syntheticAlias });
  await writeMacosFinderLayout(second, { backgroundImageAlias: syntheticAlias });
  assert.deepEqual(await fs.readFile(path.join(first, ".DS_Store")), await fs.readFile(path.join(second, ".DS_Store")));
  assert.deepEqual(layout.iconPositions, { "AgentRecall.app": [180, 212], Applications: [540, 212] });
  assert.deepEqual(layout.canvas, [720, 440]);
  assert.equal(layout.iconSize, 96);
  assert.equal(layout.textSize, 13);
  assert.equal(layout.background, ".background/background.png");
  assert.deepEqual(layout.backgroundImageAlias, syntheticAlias);
  assert.equal((await fs.readFile(path.join(first, ".DS_Store"))).includes(Buffer.from(first)), false);
});

test("rejects missing or escaped backgrounds and does not overwrite an existing layout", macos, async t => {
  const directory = await fixture(t);
  await assert.rejects(writeMacosFinderLayout(directory), /background alias is required/);
  const background = path.join(directory, ".background/background.png");
  await fs.unlink(background);
  await assert.rejects(writeMacosFinderLayout(directory, { backgroundImageAlias: syntheticAlias }), { code: "ENOENT" });
  const outside = path.join(directory, "outside.png");
  await fs.writeFile(outside, "synthetic outside background");
  await fs.symlink(outside, background);
  await assert.rejects(writeMacosFinderLayout(directory, { backgroundImageAlias: syntheticAlias }), /regular staged PNG/);
  await fs.unlink(background);
  await fs.writeFile(background, "synthetic PNG input");
  await writeMacosFinderLayout(directory, { backgroundImageAlias: syntheticAlias });
  const before = await fs.readFile(path.join(directory, ".DS_Store"));
  await assert.rejects(writeMacosFinderLayout(directory, { backgroundImageAlias: syntheticAlias }), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(path.join(directory, ".DS_Store")), before);
});

test("verification detects changed icon coordinates and broken allocator metadata", macos, async t => {
  const directory = await fixture(t);
  await writeMacosFinderLayout(directory, { backgroundImageAlias: syntheticAlias });
  const file = path.join(directory, ".DS_Store");
  const original = await fs.readFile(file);
  const changed = Buffer.from(original);
  const position = Buffer.from("000000b4000000d4ffffffffffff0000", "hex");
  const offset = changed.indexOf(position);
  assert.ok(offset > 0);
  changed.writeUInt32BE(181, offset);
  await fs.writeFile(file, changed);
  await assert.rejects(verifyMacosFinderLayout(directory));
  const invalid = Buffer.from(original);
  invalid.writeUInt32BE(0, 8);
  await fs.writeFile(file, invalid);
  await assert.rejects(verifyMacosFinderLayout(directory));
});

test("refuses a layout too large for the bounded leaf before writing a file", macos, async t => {
  const directory = await fixture(t);
  await assert.rejects(writeMacosFinderLayout(directory, { backgroundImageAlias: Buffer.alloc(8192) }), /single B-tree leaf/);
  await assert.rejects(fs.access(path.join(directory, ".DS_Store")), { code: "ENOENT" });
});

test("rewrites only a generated regular layout in place while preserving its catalog identity", macos, async t => {
  const directory = await fixture(t);
  await writeMacosFinderLayout(directory, { backgroundImageAlias: createDmgBackgroundAlias() });
  const file = path.join(directory, ".DS_Store");
  const before = await fs.stat(file);
  const alias = createDmgBackgroundAlias({ volumeCreatedAtMs: 1_700_000_000_000, parentId: 19, targetId: 20 });
  await writeMacosFinderLayout(directory, { backgroundImageAlias: alias, replaceExisting: true });
  assert.equal((await fs.stat(file)).ino, before.ino);
  assert.deepEqual((await verifyMacosFinderLayout(directory)).backgroundImageAlias, alias);
  assert.equal(alias.includes(Buffer.from(directory)), false);
  const saved = path.join(directory, "saved-layout");
  await fs.rename(file, saved);
  await fs.symlink(saved, file);
  await assert.rejects(writeMacosFinderLayout(directory, { backgroundImageAlias: alias, replaceExisting: true }), /regular file/);
  await fs.unlink(file);
  await fs.writeFile(file, "unrelated file");
  await assert.rejects(writeMacosFinderLayout(directory, { backgroundImageAlias: alias, replaceExisting: true }), /unexpected size/);
  assert.equal(await fs.readFile(file, "utf8"), "unrelated file");
});
