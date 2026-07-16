import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readReleaseNote, renderReleaseNotes } from "./release-notes.mjs";

export const LATEST_PACKAGE_NAME = "agent-recall.tgz";
export const UPDATE_MANIFEST_REPOSITORY = "zszz3/AgentRecall";

function releasePackageName(version) {
  return `agent-recall-${version}.tgz`;
}

function manifestRepositoryFor(repository) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error(`Invalid GitHub repository: ${repository}`);
  return repository.toLowerCase() === "zszz3/agentrecall" ? UPDATE_MANIFEST_REPOSITORY : repository;
}

export async function createReleaseAssets({
  notePath,
  version,
  packagePath,
  repository,
  outputDirectory,
  publishedAt = new Date().toISOString(),
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);

  const note = readReleaseNote(notePath);
  const packageName = path.basename(packagePath);
  const expectedPackageName = releasePackageName(version);
  if (packageName !== expectedPackageName) {
    throw new Error(`Release package filename ${packageName} does not match release version ${version}; expected ${expectedPackageName}.`);
  }
  const packageBytes = await readFile(packagePath);
  const sha256 = createHash("sha256").update(packageBytes).digest("hex");
  const tag = `v${version}`;
  const manifestRepository = manifestRepositoryFor(repository);
  const releaseBaseUrl = `https://github.com/${manifestRepository}/releases`;
  const assetBaseUrl = `${releaseBaseUrl}/download/${tag}`;
  const checksumName = `${packageName}.sha256`;
  const latestChecksumName = `${LATEST_PACKAGE_NAME}.sha256`;
  const manifest = {
    schemaVersion: 1,
    version,
    tag,
    title: note.title,
    publishedAt,
    releaseUrl: `${releaseBaseUrl}/tag/${tag}`,
    notes: {
      features: note.features,
      fixes: note.fixes,
    },
    package: {
      name: packageName,
      url: `${assetBaseUrl}/${packageName}`,
      sha256,
      checksumUrl: `${assetBaseUrl}/${checksumName}`,
    },
  };

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, LATEST_PACKAGE_NAME), packageBytes),
    writeFile(path.join(outputDirectory, latestChecksumName), `${sha256}  ${LATEST_PACKAGE_NAME}\n`, "utf8"),
    writeFile(path.join(outputDirectory, checksumName), `${sha256}  ${packageName}\n`, "utf8"),
    writeFile(path.join(outputDirectory, "update.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(path.join(outputDirectory, "release-notes.md"), renderReleaseNotes(note), "utf8"),
  ]);
  return manifest;
}

async function readReleaseAsset(outputDirectory, name) {
  try {
    const bytes = await readFile(path.join(outputDirectory, name));
    if (bytes.length === 0) throw new Error(`Release asset is empty: ${name}`);
    return bytes;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Missing release asset: ${name}`);
    }
    throw error;
  }
}

function checksumFromAsset(bytes, name) {
  const match = bytes.toString("utf8").trim().match(/^([a-f0-9]{64})\s+(.+)$/i);
  if (!match || match[2] !== name) throw new Error(`Invalid checksum asset for ${name}.`);
  return match[1].toLowerCase();
}

export async function validateReleaseAssets({ outputDirectory, version, repository }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
  const manifestRepository = manifestRepositoryFor(repository);
  const packageName = releasePackageName(version);
  const checksumName = `${packageName}.sha256`;
  const latestChecksumName = `${LATEST_PACKAGE_NAME}.sha256`;
  const tag = `v${version}`;
  const releaseBaseUrl = `https://github.com/${manifestRepository}/releases`;
  const assetBaseUrl = `${releaseBaseUrl}/download/${tag}`;
  const assets = new Map();
  for (const name of [packageName, checksumName, LATEST_PACKAGE_NAME, latestChecksumName, "update.json"]) {
    assets.set(name, await readReleaseAsset(outputDirectory, name));
  }

  let manifest;
  try {
    manifest = JSON.parse(assets.get("update.json").toString("utf8"));
  } catch {
    throw new Error("Invalid update.json release asset.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid update.json release asset.");
  }
  if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.tag !== tag) {
    throw new Error("update.json version does not match the release version.");
  }
  if (manifest.releaseUrl !== `${releaseBaseUrl}/tag/${tag}`) {
    throw new Error("update.json release URL does not match the release.");
  }
  if (typeof manifest.title !== "string" || manifest.title.trim().length === 0) {
    throw new Error("update.json title is invalid.");
  }
  if (!Array.isArray(manifest.notes?.features) || !Array.isArray(manifest.notes?.fixes)) {
    throw new Error("update.json release notes are invalid.");
  }
  const packageManifest = manifest.package;
  if (!packageManifest || typeof packageManifest !== "object" || Array.isArray(packageManifest) || packageManifest.name !== packageName) {
    throw new Error(`update.json package name does not match ${packageName}.`);
  }
  if (packageManifest.url !== `${assetBaseUrl}/${packageName}`) {
    throw new Error("update.json package URL does not match the release asset.");
  }
  if (packageManifest.checksumUrl !== `${assetBaseUrl}/${checksumName}`) {
    throw new Error("update.json checksum URL does not match the release asset.");
  }

  const packageBytes = assets.get(packageName);
  const sha256 = createHash("sha256").update(packageBytes).digest("hex");
  if (packageManifest.sha256 !== sha256) throw new Error(`update.json checksum does not match ${packageName}.`);
  if (checksumFromAsset(assets.get(checksumName), packageName) !== sha256) {
    throw new Error(`Checksum asset does not match ${packageName}.`);
  }
  if (checksumFromAsset(assets.get(latestChecksumName), LATEST_PACKAGE_NAME) !== sha256) {
    throw new Error(`Latest package checksum does not match ${LATEST_PACKAGE_NAME}.`);
  }
  if (!assets.get(LATEST_PACKAGE_NAME).equals(packageBytes)) {
    throw new Error(`${LATEST_PACKAGE_NAME} does not match ${packageName}.`);
  }
  return manifest;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runCli(args) {
  if (args.includes("--validate")) {
    const version = argumentValue(args, "--version");
    const repository = argumentValue(args, "--repository");
    const outputDirectory = argumentValue(args, "--output");
    if (!version || !repository || !outputDirectory) {
      throw new Error("Usage: node scripts/create-release-assets.mjs --validate --version <x.y.z> --repository <owner/repo> --output <dir>");
    }
    const manifest = await validateReleaseAssets({ outputDirectory, version, repository });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return manifest;
  }
  const notePath = argumentValue(args, "--note");
  const version = argumentValue(args, "--version");
  const packagePath = argumentValue(args, "--package");
  const repository = argumentValue(args, "--repository");
  const outputDirectory = argumentValue(args, "--output");
  if (!notePath || !version || !packagePath || !repository || !outputDirectory) {
    throw new Error("Usage: node scripts/create-release-assets.mjs --note <file> --version <x.y.z> --package <tgz> --repository <owner/repo> --output <dir>");
  }
  const manifest = await createReleaseAssets({ notePath, version, packagePath, repository, outputDirectory });
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
