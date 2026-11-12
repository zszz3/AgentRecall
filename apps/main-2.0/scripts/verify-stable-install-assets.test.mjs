import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";

import { verifyStableInstallAssets } from "./verify-stable-install-assets.mjs";
import { LATEST_PACKAGE_NAME, UPDATE_MANIFEST_NAME } from "./create-release-assets.mjs";

const temporaryDirectories = new Set();

after(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTemporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

function tarEntry(name, content) {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "utf8");
  header.write("0", 156, 1, "utf8");
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([header, body, padding]);
}

function packageTarball({ name = "agent-recall-v2", version }) {
  const manifest = JSON.stringify({ name, version });
  return gzipSync(Buffer.concat([
    tarEntry("package/package.json", manifest),
    Buffer.alloc(1024),
  ]));
}

async function writeStableRelease({ version, tarball, checksumTarget = LATEST_PACKAGE_NAME, checksumOverride }) {
  const stableDirectory = await makeTemporaryDirectory("agent-recall-v2-stable-");
  const releaseDirectory = await makeTemporaryDirectory("agent-recall-v2-release-");
  const sha256 = checksumOverride ?? createHash("sha256").update(tarball).digest("hex");
  const updateManifest = `${JSON.stringify({ schemaVersion: 1, version, tag: `v2-${version}` })}\n`;
  await writeFile(path.join(stableDirectory, LATEST_PACKAGE_NAME), tarball);
  await writeFile(path.join(stableDirectory, `${LATEST_PACKAGE_NAME}.sha256`), `${sha256}  ${checksumTarget}\n`, "utf8");
  await writeFile(path.join(stableDirectory, UPDATE_MANIFEST_NAME), updateManifest, "utf8");
  await writeFile(path.join(releaseDirectory, `agent-recall-v2-${version}.tgz`), tarball);
  await writeFile(path.join(releaseDirectory, UPDATE_MANIFEST_NAME), updateManifest, "utf8");
  return { stableDirectory, releaseDirectory };
}

test("accepts a stable install release that mirrors the versioned package", async () => {
  const tarball = packageTarball({ version: "0.3.0" });
  const { stableDirectory, releaseDirectory } = await writeStableRelease({ version: "0.3.0", tarball });

  const result = await verifyStableInstallAssets({ stableDirectory, releaseDirectory, version: "0.3.0" });

  assert.equal(result.version, "0.3.0");
  assert.equal(result.sha256, createHash("sha256").update(tarball).digest("hex"));
});

test("rejects a stable package whose bytes differ from the versioned release", async () => {
  const { stableDirectory, releaseDirectory } = await writeStableRelease({
    version: "0.3.0",
    tarball: packageTarball({ version: "0.3.0" }),
  });
  await writeFile(path.join(releaseDirectory, "agent-recall-v2-0.3.0.tgz"), packageTarball({ version: "0.3.0" }).subarray(0, 64));

  await assert.rejects(
    verifyStableInstallAssets({ stableDirectory, releaseDirectory, version: "0.3.0" }),
    /does not match agent-recall-v2-0\.3\.0\.tgz/,
  );
});

test("rejects a stable release whose checksum asset is stale", async () => {
  const { stableDirectory, releaseDirectory } = await writeStableRelease({
    version: "0.3.0",
    tarball: packageTarball({ version: "0.3.0" }),
    checksumOverride: "0".repeat(64),
  });

  await assert.rejects(
    verifyStableInstallAssets({ stableDirectory, releaseDirectory, version: "0.3.0" }),
    /does not match agent-recall-v2\.tgz/,
  );
});

test("rejects a stable update manifest that differs from the versioned release", async () => {
  const { stableDirectory, releaseDirectory } = await writeStableRelease({
    version: "0.3.0",
    tarball: packageTarball({ version: "0.3.0" }),
  });
  await writeFile(
    path.join(stableDirectory, UPDATE_MANIFEST_NAME),
    `${JSON.stringify({ schemaVersion: 1, version: "0.2.9", tag: "v2-0.2.9" })}\n`,
    "utf8",
  );

  await assert.rejects(
    verifyStableInstallAssets({ stableDirectory, releaseDirectory, version: "0.3.0" }),
    /update-v2\.json on the stable install release does not match the versioned release/,
  );
});

test("rejects a checksum asset that names a different file", async () => {
  const { stableDirectory, releaseDirectory } = await writeStableRelease({
    version: "0.3.0",
    tarball: packageTarball({ version: "0.3.0" }),
    checksumTarget: "agent-recall.tgz",
  });

  await assert.rejects(
    verifyStableInstallAssets({ stableDirectory, releaseDirectory, version: "0.3.0" }),
    /Invalid checksum asset/,
  );
});

// The packaged version is what the installed app reports to the updater, so a
// stale tarball would misreport the installed release.
test("rejects a package whose baked-in version does not match the release", async () => {
  const tarball = packageTarball({ version: "0.2.9" });
  const { stableDirectory, releaseDirectory } = await writeStableRelease({ version: "0.3.0", tarball });

  await assert.rejects(
    verifyStableInstallAssets({ stableDirectory, releaseDirectory, version: "0.3.0" }),
    /reports version 0\.2\.9, expected 0\.3\.0/,
  );
});

test("rejects a package that is not agent-recall-v2", async () => {
  const tarball = packageTarball({ name: "agent-recall", version: "0.3.0" });
  const { stableDirectory, releaseDirectory } = await writeStableRelease({ version: "0.3.0", tarball });

  await assert.rejects(
    verifyStableInstallAssets({ stableDirectory, releaseDirectory, version: "0.3.0" }),
    /declares package name agent-recall/,
  );
});

test("rejects a missing stable package", async () => {
  const stableDirectory = await makeTemporaryDirectory("agent-recall-v2-stable-missing-");
  const releaseDirectory = await makeTemporaryDirectory("agent-recall-v2-release-missing-");
  await writeFile(path.join(releaseDirectory, "agent-recall-v2-0.3.0.tgz"), packageTarball({ version: "0.3.0" }));

  await assert.rejects(
    verifyStableInstallAssets({ stableDirectory, releaseDirectory, version: "0.3.0" }),
    /Missing release asset: agent-recall-v2\.tgz/,
  );
});

test("rejects an invalid release version", async () => {
  const stableDirectory = await makeTemporaryDirectory("agent-recall-v2-stable-version-");
  const releaseDirectory = await makeTemporaryDirectory("agent-recall-v2-release-version-");

  await assert.rejects(
    verifyStableInstallAssets({ stableDirectory, releaseDirectory, version: "latest" }),
    /Invalid release version: latest/,
  );
});
