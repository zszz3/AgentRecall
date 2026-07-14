import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readReleaseNote, renderReleaseNotes } from "./release-notes.mjs";

export const LATEST_PACKAGE_NAME = "agent-session-search.tgz";

export async function createReleaseAssets({
  notePath,
  version,
  packagePath,
  repository,
  outputDirectory,
  publishedAt = new Date().toISOString(),
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error(`Invalid GitHub repository: ${repository}`);

  const note = readReleaseNote(notePath);
  const packageBytes = await readFile(packagePath);
  const packageName = path.basename(packagePath);
  const sha256 = createHash("sha256").update(packageBytes).digest("hex");
  const tag = `v${version}`;
  const releaseBaseUrl = `https://github.com/${repository}/releases`;
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

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runCli(args) {
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
