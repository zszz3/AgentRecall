#!/usr/bin/env node

// Guards the rolling `v2-latest` release that gives V2 a stable install URL.
// GitHub reserves the repository-wide "Latest" release for V1, so the install
// docs point at `v2-latest` instead. That release must always serve the exact
// bytes of the version it mirrors, otherwise `npm install -g` would hand users
// a stale or corrupted package.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";

import { LATEST_PACKAGE_NAME, UPDATE_MANIFEST_NAME } from "./create-release-assets.mjs";

const LATEST_CHECKSUM_NAME = `${LATEST_PACKAGE_NAME}.sha256`;

export async function verifyStableInstallAssets({ stableDirectory, releaseDirectory, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version ?? ""))) {
    throw new Error(`Invalid release version: ${version}`);
  }

  const stablePackage = await readAsset(stableDirectory, LATEST_PACKAGE_NAME);
  const releasePackage = await readAsset(releaseDirectory, `agent-recall-v2-${version}.tgz`);
  if (!stablePackage.equals(releasePackage)) {
    throw new Error(`${LATEST_PACKAGE_NAME} on the stable install release does not match agent-recall-v2-${version}.tgz.`);
  }

  const sha256 = createHash("sha256").update(stablePackage).digest("hex");
  const declared = await readChecksum(stableDirectory, LATEST_CHECKSUM_NAME, LATEST_PACKAGE_NAME);
  if (declared !== sha256) {
    throw new Error(`${LATEST_CHECKSUM_NAME} does not match ${LATEST_PACKAGE_NAME}.`);
  }

  const stableManifest = await readAsset(stableDirectory, UPDATE_MANIFEST_NAME);
  const releaseManifest = await readAsset(releaseDirectory, UPDATE_MANIFEST_NAME);
  if (!stableManifest.equals(releaseManifest)) {
    throw new Error(`${UPDATE_MANIFEST_NAME} on the stable install release does not match the versioned release.`);
  }

  // The tarball's own package.json version is what the installed app reports to
  // the updater, so a mismatch would make the stable install look outdated or
  // newer than the release it was published with.
  const packagedVersion = await readPackagedVersion(stablePackage);
  if (packagedVersion !== version) {
    throw new Error(`${LATEST_PACKAGE_NAME} reports version ${packagedVersion}, expected ${version}.`);
  }

  return { version, sha256 };
}

async function readAsset(directory, name) {
  try {
    const bytes = await readFile(path.join(directory, name));
    if (bytes.length === 0) throw new Error(`Release asset is empty: ${name}`);
    return bytes;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Missing release asset: ${name}`);
    }
    throw error;
  }
}

async function readChecksum(directory, name, expectedTarget) {
  const bytes = await readAsset(directory, name);
  const match = bytes.toString("utf8").trim().match(/^([a-f0-9]{64})\s+(.+)$/i);
  if (!match || match[2] !== expectedTarget) throw new Error(`Invalid checksum asset for ${expectedTarget}.`);
  return match[1].toLowerCase();
}

async function readPackagedVersion(tarballBytes) {
  const unpacked = await gunzip(tarballBytes);
  const manifest = readTarEntry(unpacked, "package/package.json");
  if (!manifest) throw new Error(`${LATEST_PACKAGE_NAME} does not contain package/package.json.`);
  let parsed;
  try {
    parsed = JSON.parse(manifest.toString("utf8"));
  } catch {
    throw new Error(`${LATEST_PACKAGE_NAME} contains an invalid package.json.`);
  }
  if (parsed?.name !== "agent-recall-v2") {
    throw new Error(`${LATEST_PACKAGE_NAME} declares package name ${parsed?.name ?? "unknown"}.`);
  }
  if (typeof parsed.version !== "string") throw new Error(`${LATEST_PACKAGE_NAME} has no package version.`);
  return parsed.version;
}

async function gunzip(bytes) {
  const chunks = [];
  const stream = Readable.from([bytes]).pipe(createGunzip());
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Minimal ustar reader: npm tarballs are flat and uncompressed once gunzipped,
// so walking 512-byte headers avoids pulling a tar dependency into CI.
function readTarEntry(archive, entryName) {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeField, 8);
    if (!Number.isInteger(size) || size < 0) throw new Error("Tar entry size is invalid.");
    const contentStart = offset + 512;
    if (name === entryName) return archive.subarray(contentStart, contentStart + size);
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runCli(args) {
  const stableDirectory = argumentValue(args, "--stable");
  const releaseDirectory = argumentValue(args, "--release");
  const version = argumentValue(args, "--version");
  if (!stableDirectory || !releaseDirectory || !version) {
    throw new Error("Usage: node scripts/verify-stable-install-assets.mjs --stable <dir> --release <dir> --version <x.y.z>");
  }
  const result = await verifyStableInstallAssets({ stableDirectory, releaseDirectory, version });
  process.stdout.write(`Verified agent-recall-v2 stable install assets for v${result.version}.\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
