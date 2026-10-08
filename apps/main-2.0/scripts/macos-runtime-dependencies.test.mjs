import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { isReleaseContentPath, stageProductionDependencies } from "./macos-runtime-dependencies.mjs";

async function fixture(t, manifest) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-runtime-deps-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "node_modules");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", ...manifest }));
  const lock = { lockfileVersion: 3, packages: { "": manifest } };
  const add = async (relative, manifest, files = { "index.js": "module.exports = 'runtime';" }) => {
    const directory = path.join(source, relative);
    await fs.mkdir(directory, { recursive: true });
    const metadata = { name: relative.split("node_modules/").at(-1), version: "1.0.0", ...manifest };
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify(metadata));
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(directory, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    }
    lock.packages[relative] = { ...metadata };
    await fs.writeFile(path.join(source, "package-lock.json"), JSON.stringify(lock));
    return directory;
  };
  await fs.writeFile(path.join(source, "package-lock.json"), JSON.stringify(lock));
  return { root, source, destination, add, lock };
}

async function missing(file) {
  await assert.rejects(fs.access(file), { code: "ENOENT" });
}

test("stages the production closure with nested versions, peers and optional runtime packages", async t => {
  const f = await fixture(t, {
    dependencies: { app: "1.0.0", shared: "2.0.0", electron: "42.0.0", "@fontsource-variable/source-serif-4": "5.3.0" },
    optionalDependencies: { absent: "1.0.0" }, devDependencies: { builder: "1.0.0" },
  });
  await f.add("node_modules/app", { dependencies: { shared: "1.0.0" }, peerDependencies: { peer: "1.0.0", absentPeer: "1.0.0" },
    peerDependenciesMeta: { absentPeer: { optional: true } }, optionalDependencies: { optional: "1.0.0" } },
  { "index.js": "module.exports = [require('shared'), require('peer'), require('optional')];" });
  await f.add("node_modules/app/node_modules/shared", {}, { "index.js": "module.exports = 'nested';" });
  await f.add("node_modules/shared", { version: "2.0.0" }, { "index.js": "module.exports = 'hoisted';" });
  await f.add("node_modules/peer", {}, { "index.js": "module.exports = 'peer';" });
  await f.add("node_modules/optional", {}, { "index.js": "module.exports = 'optional';" });
  await f.add("node_modules/builder", { dependencies: { unused: "1.0.0" } });
  await f.add("node_modules/unused", {});
  await f.add("node_modules/electron", {});
  const result = await stageProductionDependencies(f.source, f.destination);
  assert.equal(result.packageCount, 5);
  assert.deepEqual(result.omittedOptional, ["absent", "absentPeer"]);
  assert.deepEqual(result.providedSeparately, ["@fontsource-variable/source-serif-4", "electron"]);
  const require = createRequire(path.join(f.destination, "app", "package.json"));
  assert.deepEqual(require("./index.js"), ["nested", "peer", "optional"]);
  assert.equal(require(path.join(f.destination, "shared")), "hoisted");
  for (const name of ["builder", "unused", "electron", "@fontsource-variable"]) await missing(path.join(f.destination, name));
  assert.ok(result.bytes > 0 && result.fileCount > 0);
  await fs.access(path.join(f.source, "node_modules", "builder", "index.js"));
});

test("keeps runtime assets and licenses while excluding fixture keys, maps, settings and local evidence", async t => {
  const f = await fixture(t, { dependencies: { runtime: "1.0.0" } });
  const directory = await f.add("node_modules/runtime", {}, {
    "index.js": "module.exports = require('./src/runtime.js');", "src/runtime.js": "module.exports = 42;",
    "native/tool": "synthetic executable", "ca.pem": "public CA fixture", "LICENSE": "fixture license",
    "tests/key.pem": "synthetic private fixture", "fixtures/config.json": "{}", "index.js.map": "source map",
    ".env": "SYNTHETIC_VALUE=secret", ".env.local": "SYNTHETIC_VALUE=secret", ".npmrc": "synthetic credential",
    ".git/config": "synthetic git", "docs/local-review/result.json": "{}", "user-data/state.json": "{}",
    "index.test.js": "throw new Error('test only');", "data.sqlite": "synthetic database", "error.log": "fixture log",
  });
  await fs.chmod(path.join(directory, "native/tool"), 0o755);
  const before = await fs.readFile(path.join(directory, "index.js"));
  const result = await stageProductionDependencies(f.source, f.destination);
  assert.ok(result.excludedEntries >= 10);
  for (const name of ["tests", "fixtures", "index.js.map", ".env", ".env.local", ".npmrc", ".git", "docs/local-review", "user-data", "index.test.js", "data.sqlite", "error.log"]) {
    await missing(path.join(f.destination, "runtime", name));
  }
  for (const name of ["src/runtime.js", "native/tool", "ca.pem", "LICENSE"]) await fs.access(path.join(f.destination, "runtime", name));
  assert.equal(createRequire(path.join(f.destination, "runtime/package.json"))("./index.js"), 42);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(f.destination, "runtime/native/tool"))).mode & 0o777, 0o755);
  assert.deepEqual(await fs.readFile(path.join(directory, "index.js")), before);
});

test("restores PostgreSQL native links only in the staged tree", async t => {
  const name = `@embedded-postgres/${process.platform}-${process.arch}`;
  const f = await fixture(t, { dependencies: { [name]: "1.0.0" } });
  const source = await f.add(`node_modules/${name}`, {}, {
    "native/lib/libpg.1.dylib": "synthetic native library",
    "native/pg-symlinks.json": JSON.stringify([{ source: "native/lib/libpg.1.dylib", target: "native/lib/libpg.dylib" }]),
  });
  const result = await stageProductionDependencies(f.source, f.destination);
  assert.equal(result.restoredNativeLinks, 1);
  assert.equal(await fs.readFile(path.join(f.destination, name, "native/lib/libpg.dylib"), "utf8"), "synthetic native library");
  await missing(path.join(source, "native/lib/libpg.dylib"));
});

test("omits node-gyp metadata and intermediates while keeping linked native runtime files", async t => {
  const f = await fixture(t, { dependencies: { runtime: "1.0.0" } });
  const omitted = ["build/Makefile", "build/binding.Makefile", "build/config.gypi", "build/gyp-mac-tool",
    "build/deps/native/native.target.mk", "build/Release/obj.target/native/binding.o", "build/Release/.deps/native.d", "build/Release/native.a"];
  const retained = ["build/index.js", "build/Release/runtime.node", "build/Release/native.dylib"];
  await f.add("node_modules/runtime", {}, Object.fromEntries([...omitted, ...retained].map(name => [name, "synthetic artifact"])));
  await stageProductionDependencies(f.source, f.destination);
  for (const name of omitted) await missing(path.join(f.destination, "runtime", name));
  for (const name of retained) await fs.access(path.join(f.destination, "runtime", name));
});

test("strips Mach-O debug paths only from staged native copies", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, { dependencies: { runtime: "1.0.0" } });
  const source = await f.add("node_modules/runtime", {}, { "binding.c": "int review_fixture(void) { return 42; }\n" });
  const original = path.join(source, "runtime.node");
  execFileSync("/usr/bin/clang", ["-g", "-dynamiclib", "-Wl,-install_name,@rpath/runtime.node", path.join(source, "binding.c"), "-o", original]);
  const before = await fs.readFile(original);
  assert.ok(before.includes(Buffer.from(source)), "fixture contains its compile path before stripping");
  const result = await stageProductionDependencies(f.source, f.destination);
  assert.deepEqual(result.strippedNativeFiles, ["node_modules/runtime/runtime.node"]);
  const staged = path.join(f.destination, "runtime/runtime.node");
  await missing(`${staged}.dSYM`);
  assert.equal((await fs.readFile(staged)).includes(Buffer.from(source)), false);
  assert.match(execFileSync("/usr/bin/nm", ["-g", staged], { encoding: "utf8" }), /_review_fixture/);
  assert.deepEqual(await fs.readFile(original), before, "installed source binary is unchanged");
});

test("fails before copying when a required dependency is absent or differs from the lock", async t => {
  const f = await fixture(t, { dependencies: { required: "1.0.0" } });
  await assert.rejects(stageProductionDependencies(f.source, f.destination), /Required production dependency is missing/);
  await missing(f.destination);
  const source = await f.add("node_modules/required", {});
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "required", version: "2.0.0" }));
  await assert.rejects(stageProductionDependencies(f.source, f.destination), /does not match package-lock/);
  await missing(f.destination);
});

test("does not overwrite existing output or allow input/output overlap", async t => {
  const f = await fixture(t, {});
  await fs.mkdir(f.destination);
  await fs.writeFile(path.join(f.destination, "keep"), "user-owned");
  await assert.rejects(stageProductionDependencies(f.source, f.destination), /new or empty directory/);
  assert.equal(await fs.readFile(path.join(f.destination, "keep"), "utf8"), "user-owned");
  await assert.rejects(stageProductionDependencies(f.source, path.join(f.source, "node_modules")), /outside the source package tree/);
});

test("rejects escaped, absolute and dangling runtime symlinks; preserves internal native links", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, { dependencies: { runtime: "1.0.0" } });
  const source = await f.add("node_modules/runtime", {}, { "native/lib.1": "fixture native" });
  await fs.symlink("lib.1", path.join(source, "native/lib"));
  await stageProductionDependencies(f.source, f.destination);
  assert.equal(await fs.readlink(path.join(f.destination, "runtime/native/lib")), "lib.1");
  const outside = path.join(f.root, "outside");
  await fs.writeFile(outside, "must not be included");
  for (const target of ["../../../../outside", outside, "absent"]) {
    const output = await fs.mkdtemp(path.join(f.root, "stage-"));
    await fs.symlink(target, path.join(source, "escape"));
    await assert.rejects(stageProductionDependencies(f.source, output));
    await fs.unlink(path.join(source, "escape"));
  }
  const linkedParent = path.join(f.root, "linked-parent");
  await fs.symlink(f.source, linkedParent, "dir");
  await assert.rejects(stageProductionDependencies(f.source, path.join(linkedParent, "new-output")), /outside the source package tree/);
  await missing(path.join(f.source, "new-output"));
});

test("release content policy is path portable and does not remove runtime source or certificates", () => {
  for (const name of ["fixtures/key.pem", "tests\\key.pem", "a/index.js.map", "docs/local-review/report.md", ".env.production", "user-data/state.json"]) {
    assert.equal(isReleaseContentPath(name), false, name);
  }
  for (const name of ["src/runtime.js", "dist/index.js", "native/libssl.3.dylib", "native/share/test_decoding.control", "LICENSE", "ca.pem"]) {
    assert.equal(isReleaseContentPath(name), true, name);
  }
});
