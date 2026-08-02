#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

const WINDOWS_X64_LLAMA_CPP_WHEEL = [
  "llama-cpp-python @ ",
  "https://github.com/abetlen/llama-cpp-python/releases/download/v0.3.34/",
  "llama_cpp_python-0.3.34-py3-none-win_amd64.whl",
  "#sha256=6526fff614e5ef7e439e6369e076a78073e45e1d791dbe1d5e5d42661f46ca1a",
].join("");

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
  const openVikingPackageVersion = input.version.replace(/-r[1-9][0-9]*$/u, "");
  if (!path.isAbsolute(input.pythonArchive)) {
    throw new Error("OpenViking runtime build requires an absolute CPython archive path.");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(input.pythonSha256 ?? ""))) {
    throw new Error("OpenViking runtime CPython archive checksum is invalid.");
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
      ...(input.platform === "win32" && input.arch === "x64"
        ? [WINDOWS_X64_LLAMA_CPP_WHEEL]
        : []),
      `openviking[local-embed]==${openVikingPackageVersion}`,
      "mcp>=1.27.0,<2",
    ],
  };
}

export function patchCodexResponsesAdapter(source) {
  const marker = 'response_kwargs["reasoning"] = {"effort": reasoning_effort}';
  if (source.includes(marker)) return source;
  const anchor = '        tools = _convert_tools_for_responses(kwargs.get("tools"))';
  const parts = source.split(anchor);
  if (parts.length !== 2) {
    throw new Error("Cannot patch unsupported OpenViking Codex adapter.");
  }
  return [
    parts[0],
    '        reasoning_effort = kwargs.get("reasoning_effort")\n',
    "        if reasoning_effort:\n",
    `            ${marker}\n`,
    anchor,
    parts[1],
  ].join("");
}

export function patchVlmReasoningEffortConfig(source) {
  const fieldMarker = '    reasoning_effort: str = Field(default="low"';
  const forwardingMarker = '            "reasoning_effort": self.reasoning_effort,';
  if (source.includes(fieldMarker) && source.split(forwardingMarker).length === 3) return source;

  const thinkingField = /^    thinking: bool = Field\(.*\)$/mu;
  if (!thinkingField.test(source)) {
    throw new Error("Cannot patch unsupported OpenViking VLM config.");
  }
  const resultAnchor = '            "thinking": self.thinking,\n';
  if (source.split(resultAnchor).length !== 3) {
    throw new Error("Cannot patch unsupported OpenViking VLM config.");
  }
  return source
    .replace(
      thinkingField,
      (line) => `${line}\n    reasoning_effort: str = Field(default="low", description="OpenAI reasoning effort")`,
    )
    .replaceAll(
      resultAnchor,
      `${resultAnchor}${forwardingMarker}\n`,
    );
}

export async function buildRuntimeArtifact(input) {
  const plan = buildRuntimePlan(input);
  reportProgress(input, { phase: "building-runtime" });
  await access(plan.pythonArchive);
  const pythonArchiveSha256 = await sha256File(plan.pythonArchive);
  if (pythonArchiveSha256 !== plan.pythonSha256.toLowerCase()) {
    throw new Error("OpenViking runtime CPython archive checksum did not match the pinned value.");
  }
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
    const archiveRoot = runtimeArchiveRoot(python, plan.platform);
    const codexAdapterPath = await locateCodexResponsesAdapter(archiveRoot);
    const codexAdapterSource = await readFile(codexAdapterPath, "utf8");
    await writeFile(
      codexAdapterPath,
      patchCodexResponsesAdapter(codexAdapterSource),
      "utf8",
    );
    const vlmConfigPath = await locateVlmConfig(archiveRoot);
    const vlmConfigSource = await readFile(vlmConfigPath, "utf8");
    await writeFile(
      vlmConfigPath,
      patchVlmReasoningEffortConfig(vlmConfigSource),
      "utf8",
    );
    await writeFile(path.join(archiveRoot, "OPENVIKING-SOURCE.txt"), [
      "OpenViking server 0.4.11",
      "License: GNU Affero General Public License v3.0",
      "Corresponding source: https://github.com/volcengine/OpenViking/tree/v0.4.11",
      "License text: https://github.com/volcengine/OpenViking/blob/v0.4.11/LICENSE",
      "",
    ].join("\n"), "utf8");
    await createRuntimeArchive({
      sourceDir: archiveRoot,
      outputPath: plan.outputPath,
      onProgress: (progress) => reportProgress(input, progress),
    });
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

export async function createRuntimeArchive({
  sourceDir,
  outputPath,
  onProgress,
  progressIntervalMs = 500,
}) {
  const startedAt = Date.now();
  const report = async () => {
    let downloadedBytes;
    try {
      downloadedBytes = (await stat(outputPath)).size;
    } catch (error) {
      if (error?.code === "ENOENT") downloadedBytes = 0;
      else return;
    }
    const elapsedMs = Date.now() - startedAt;
    onProgress?.({
      phase: "packaging-runtime",
      downloadedBytes,
      ...(elapsedMs > 0 && downloadedBytes > 0
        ? { bytesPerSecond: Math.round(downloadedBytes / (elapsedMs / 1_000)) }
        : {}),
    });
  };
  let progressUpdate = Promise.resolve();
  const schedule = () => {
    progressUpdate = progressUpdate.then(report, report);
  };

  await report();
  const timer = setInterval(schedule, progressIntervalMs);
  try {
    await tar.c({
      cwd: sourceDir,
      file: outputPath,
      gzip: true,
      portable: true,
      noMtime: true,
    }, ["."]);
  } finally {
    clearInterval(timer);
    await progressUpdate;
    await report();
  }
}

export function assertTrustedPythonArchiveUrl(value) {
  const url = new URL(String(value ?? ""));
  if (
    url.protocol !== "https:"
    || url.hostname !== "github.com"
    || !url.pathname.startsWith("/astral-sh/python-build-standalone/releases/download/20260510/")
  ) {
    throw new Error("OpenViking runtime builds require a trusted python-build-standalone release URL.");
  }
  return url;
}

export async function buildRuntimeArtifactFromUrl(input) {
  const url = assertTrustedPythonArchiveUrl(input.pythonUrl);
  const downloadRoot = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-python-"));
  const pythonArchive = path.join(downloadRoot, "cpython.tar.gz");
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`Could not download standalone Python (${response.status}).`);
    const contentLength = Number(response.headers.get("content-length"));
    const totalBytes = Number.isSafeInteger(contentLength) && contentLength > 0
      ? contentLength
      : undefined;
    let downloadedBytes = 0;
    const downloadStartedAt = Date.now();
    reportProgress(input, {
      phase: "downloading-python",
      downloadedBytes,
      ...(totalBytes === undefined ? {} : { totalBytes }),
    });
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          downloadedBytes += chunk.byteLength;
          const elapsedMs = Date.now() - downloadStartedAt;
          const bytesPerSecond = elapsedMs >= 250
            ? Math.round(downloadedBytes / (elapsedMs / 1_000))
            : undefined;
          reportProgress(input, {
            phase: "downloading-python",
            downloadedBytes,
            ...(totalBytes === undefined ? {} : { totalBytes }),
            ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
          });
          callback(null, chunk);
        },
      }),
      createWriteStream(pythonArchive, { mode: 0o600 }),
    );
    return await buildRuntimeArtifact({ ...input, pythonArchive });
  } finally {
    await rm(downloadRoot, { recursive: true, force: true });
  }
}

function reportProgress(input, progress) {
  input.onProgress?.(progress);
}

export function runtimeArchiveRoot(pythonPath, platform, pathApi = path) {
  return platform === "win32"
    ? pathApi.dirname(pythonPath)
    : pathApi.dirname(pathApi.dirname(pythonPath));
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

async function locateCodexResponsesAdapter(archiveRoot) {
  const pending = [archiveRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name === "codex_responses_adapter.py") {
        return candidate;
      }
    }
  }
  throw new Error("The OpenViking runtime does not contain the Codex Responses adapter.");
}

async function locateVlmConfig(archiveRoot) {
  const pending = [archiveRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (
        entry.isFile()
        && entry.name === "vlm_config.py"
        && candidate.includes(`${path.sep}openviking_cli${path.sep}utils${path.sep}config${path.sep}`)
      ) {
        return candidate;
      }
    }
  }
  throw new Error("The OpenViking runtime does not contain the VLM config.");
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
    pythonUrl: values["python-url"],
    pythonSha256: values["python-sha256"],
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const input = parseArguments(process.argv.slice(2));
  input.onProgress = (progress) => {
    process.stdout.write(`${JSON.stringify({ type: "progress", progress })}\n`);
  };
  const build = input.pythonUrl ? buildRuntimeArtifactFromUrl(input) : buildRuntimeArtifact(input);
  build
    .then((result) => process.stdout.write(`${JSON.stringify({ type: "result", result })}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
