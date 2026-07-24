#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

export function runtimeArtifactName({ version, platform, arch }) {
  assertToken(version, "version");
  assertToken(platform, "platform");
  assertToken(arch, "architecture");
  return `openviking-runtime-${version}-${platform}-${arch}.tar.gz`;
}

export function assertSafeBuildDirectory(directory, label) {
  const raw = String(directory ?? "").trim();
  const resolved = path.resolve(raw || ".");
  const broadPaths = new Set([
    path.parse(resolved).root,
    path.resolve(homedir()),
    path.resolve(process.cwd()),
  ]);
  if (!path.isAbsolute(raw) || broadPaths.has(resolved)) {
    throw new Error(`OpenViking runtime build requires a safe explicit ${label} directory.`);
  }
  return resolved;
}

export function buildRuntimePlan(input) {
  const buildHome = assertSafeBuildDirectory(input.buildHome, "build HOME");
  const outputDir = assertSafeBuildDirectory(input.outputDir, "output");
  const artifactName = runtimeArtifactName(input);
  if (!path.isAbsolute(input.pythonArchive)) {
    throw new Error("OpenViking runtime build requires an absolute CPython archive path.");
  }
  return {
    ...input,
    buildHome,
    outputDir,
    outputPath: path.join(outputDir, artifactName),
    manifestPath: path.join(outputDir, `${artifactName}.json`),
    env: {
      ...process.env,
      HOME: buildHome,
      USERPROFILE: buildHome,
      PIP_CACHE_DIR: path.join(buildHome, ".cache", "pip"),
      PYTHONNOUSERSITE: "1",
      PIP_REQUIRE_VIRTUALENV: "0",
    },
    pipArgs: [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      `openviking[local-embed]==${input.version}`,
    ],
  };
}

export async function buildRuntimeArtifact(input) {
  const plan = buildRuntimePlan(input);
  await access(plan.pythonArchive);
  await mkdir(plan.buildHome, { recursive: true, mode: 0o700 });
  await mkdir(plan.outputDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-build-"));
  try {
    await tar.x({
      cwd: stagingRoot,
      file: plan.pythonArchive,
      preservePaths: false,
      strict: true,
    });
    const python = await locatePython(stagingRoot, plan.platform);
    await run(python, ["-m", "ensurepip", "--upgrade"], {
      cwd: stagingRoot,
      env: plan.env,
    });
    await run(python, plan.pipArgs, {
      cwd: stagingRoot,
      env: plan.env,
    });
    const archiveRoot = path.dirname(path.dirname(python));
    await tar.c({
      cwd: archiveRoot,
      file: plan.outputPath,
      gzip: true,
      portable: true,
      noMtime: true,
    }, ["."]);
    const sha256 = await sha256File(plan.outputPath);
    const executablePath = plan.platform === "win32"
      ? "Scripts/openviking-server.exe"
      : "bin/openviking-server";
    const manifest = {
      version: plan.version,
      platform: plan.platform,
      arch: plan.arch,
      sha256,
      archiveType: "tar.gz",
      executablePath,
      file: path.basename(plan.outputPath),
    };
    await writeFile(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { ...manifest, outputPath: plan.outputPath, manifestPath: plan.manifestPath };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function locatePython(stagingRoot, platform) {
  const candidates = platform === "win32"
    ? [
        path.join(stagingRoot, "python", "python.exe"),
        path.join(stagingRoot, "python.exe"),
      ]
    : [
        path.join(stagingRoot, "python", "bin", "python3"),
        path.join(stagingRoot, "bin", "python3"),
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported python-build-standalone layout.
    }
  }
  throw new Error("The CPython archive does not contain a supported standalone Python layout.");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with ${code ?? signal ?? "unknown status"}.`));
    });
  });
}

function assertToken(value, label) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(String(value ?? ""))) {
    throw new Error(`OpenViking runtime ${label} is invalid.`);
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Expected --name value arguments.");
    }
    values[key.slice(2)] = value;
  }
  return {
    version: values.version,
    platform: values.platform,
    arch: values.arch,
    buildHome: values["build-home"],
    outputDir: values["output-dir"],
    pythonArchive: values["python-archive"],
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  buildRuntimeArtifact(parseArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
