#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = [
  { platform: "darwin", arch: "arm64", executablePath: "bin/openviking-server" },
  { platform: "darwin", arch: "x64", executablePath: "bin/openviking-server" },
  { platform: "win32", arch: "x64", executablePath: "Scripts/openviking-server.exe" },
];

export async function verifyOpenVikingRuntimeAssets(directory, version) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(String(version ?? ""))) {
    throw new Error("OpenViking runtime version is invalid.");
  }
  for (const target of TARGETS) {
    const file = `openviking-runtime-${version}-${target.platform}-${target.arch}.tar.gz`;
    const archivePath = path.join(directory, file);
    const manifestPath = path.join(directory, `${file}.json`);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      await access(archivePath);
    } catch {
      throw new Error(`Missing OpenViking runtime for ${target.platform}-${target.arch}.`);
    }
    if (
      manifest.version !== version
      || manifest.platform !== target.platform
      || manifest.arch !== target.arch
      || manifest.archiveType !== "tar.gz"
      || manifest.executablePath !== target.executablePath
      || manifest.file !== file
      || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    ) {
      throw new Error(`Invalid OpenViking runtime manifest for ${target.platform}-${target.arch}.`);
    }
    if (await sha256File(archivePath) !== manifest.sha256) {
      throw new Error(`OpenViking runtime checksum mismatch for ${target.platform}-${target.arch}.`);
    }
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [directory, version] = process.argv.slice(2);
  verifyOpenVikingRuntimeAssets(directory, version)
    .then(() => process.stdout.write(`Verified OpenViking ${version} runtime assets.\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
