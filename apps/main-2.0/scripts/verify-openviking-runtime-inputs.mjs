#!/usr/bin/env node

import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  patchCodexResponsesAdapter,
  patchVlmReasoningEffortConfig,
} from "./build-openviking-runtime.mjs";

const OPENVIKING_VERSION = "0.4.11";
const PYPI_METADATA_URL = `https://pypi.org/pypi/openviking/${OPENVIKING_VERSION}/json`;
const PATCH_INPUTS = [
  { key: "codex", suffix: "/codex_responses_adapter.py", patch: patchCodexResponsesAdapter },
  { key: "vlm", suffix: "/openviking_cli/utils/config/vlm_config.py", patch: patchVlmReasoningEffortConfig },
];

export const OPENVIKING_RUNTIME_WHEELS = [
  {
    platform: "darwin",
    arch: "arm64",
    filename: "openviking-0.4.11-cp310-abi3-macosx_14_0_arm64.whl",
    sha256: "4a0389f2c3de0eb41cc2f26ccedb89566d8719393c3ab37d2ee2895cf9a8ebee",
    size: 18_980_965,
  },
  {
    platform: "darwin",
    arch: "x64",
    filename: "openviking-0.4.11-cp310-abi3-macosx_15_0_x86_64.whl",
    sha256: "f3ed8d86917fe3cd94421019fb997bb874ef1f95fd97bada614a10b1516aba77",
    size: 21_346_489,
  },
  {
    platform: "win32",
    arch: "x64",
    filename: "openviking-0.4.11-cp310-abi3-win_amd64.whl",
    sha256: "858f3d7bf2ecb102744d6de704551f9df9b4fa4ab9adc2bdcdd500f8881bf6c8",
    size: 25_023_612,
  },
];

export async function verifyOpenVikingRuntimeInputs({
  fetchImpl = fetch,
  metadataUrl = PYPI_METADATA_URL,
  wheels = OPENVIKING_RUNTIME_WHEELS,
} = {}) {
  const metadataResponse = await fetchImpl(metadataUrl, { headers: { accept: "application/json" } });
  if (!metadataResponse.ok) {
    throw new Error(`Could not load OpenViking package metadata (${metadataResponse.status}).`);
  }
  const metadata = await metadataResponse.json();
  const publishedFiles = new Map(metadata.urls?.map((entry) => [entry.filename, entry]) ?? []);
  return await Promise.all(wheels.map(async (wheel) => {
    const published = publishedFiles.get(wheel.filename);
    if (
      published?.packagetype !== "bdist_wheel"
      || published?.digests?.sha256 !== wheel.sha256
      || published?.size !== wheel.size
    ) {
      throw new Error(`OpenViking ${wheel.platform}-${wheel.arch} wheel metadata changed.`);
    }
    const url = new URL(published.url);
    if (url.protocol !== "https:" || url.hostname !== "files.pythonhosted.org") {
      throw new Error(`OpenViking ${wheel.platform}-${wheel.arch} wheel URL is not trusted.`);
    }

    const entries = await readRemoteZipEntries({
      fetchImpl,
      url,
      archiveSize: wheel.size,
      suffixes: PATCH_INPUTS.map(({ suffix }) => suffix),
    });
    const newlineStyles = {};
    for (const input of PATCH_INPUTS) {
      const source = entries.get(input.suffix)?.toString("utf8");
      if (!source) {
        throw new Error(`OpenViking ${wheel.platform}-${wheel.arch} wheel is missing ${input.suffix}.`);
      }
      const patched = input.patch(source);
      if (input.patch(patched) !== patched) {
        throw new Error(`OpenViking ${wheel.platform}-${wheel.arch} ${input.key} patch is not idempotent.`);
      }
      newlineStyles[input.key] = source.includes("\r\n") ? "crlf" : "lf";
    }
    return { platform: wheel.platform, arch: wheel.arch, newlineStyles };
  }));
}

async function readRemoteZipEntries({ fetchImpl, url, archiveSize, suffixes }) {
  let fullArchive;
  const readRange = async (start, end) => {
    if (fullArchive) return fullArchive.subarray(start, end + 1);
    const response = await fetchImpl(url, { headers: { range: `bytes=${start}-${end}` } });
    if (response.status === 200) {
      fullArchive = Buffer.from(await response.arrayBuffer());
      if (fullArchive.length !== archiveSize) throw new Error("OpenViking wheel size did not match its metadata.");
      return fullArchive.subarray(start, end + 1);
    }
    if (response.status !== 206) throw new Error(`Could not read OpenViking wheel (${response.status}).`);
    const contentRange = response.headers.get("content-range");
    if (contentRange !== `bytes ${start}-${end}/${archiveSize}`) {
      throw new Error("OpenViking wheel returned an invalid byte range.");
    }
    return Buffer.from(await response.arrayBuffer());
  };

  const tailStart = Math.max(0, archiveSize - 65_557);
  const tail = await readRange(tailStart, archiveSize - 1);
  let endOffset = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === 0x06054b50) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0) throw new Error("OpenViking wheel has no ZIP directory.");
  const entryCount = tail.readUInt16LE(endOffset + 10);
  const directorySize = tail.readUInt32LE(endOffset + 12);
  const directoryOffset = tail.readUInt32LE(endOffset + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("OpenViking wheel uses unsupported ZIP64 metadata.");
  }
  const directory = await readRange(directoryOffset, directoryOffset + directorySize - 1);
  const candidates = [];
  let offset = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (directory.readUInt32LE(offset) !== 0x02014b50) throw new Error("OpenViking wheel ZIP directory is invalid.");
    const flags = directory.readUInt16LE(offset + 8);
    const method = directory.readUInt16LE(offset + 10);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const uncompressedSize = directory.readUInt32LE(offset + 24);
    const filenameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const localHeaderOffset = directory.readUInt32LE(offset + 42);
    const filename = directory.subarray(offset + 46, offset + 46 + filenameLength).toString("utf8");
    const suffix = suffixes.find((value) => `/${filename}`.endsWith(value));
    if (suffix) {
      candidates.push({ suffix, filename, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
    }
    offset += 46 + filenameLength + extraLength + commentLength;
  }

  const result = new Map();
  for (const candidate of candidates) {
    if (candidate.flags & 1) throw new Error(`OpenViking wheel entry ${candidate.filename} is encrypted.`);
    const localHeader = await readRange(candidate.localHeaderOffset, candidate.localHeaderOffset + 29);
    if (localHeader.readUInt32LE(0) !== 0x04034b50) throw new Error("OpenViking wheel local header is invalid.");
    const filenameLength = localHeader.readUInt16LE(26);
    const extraLength = localHeader.readUInt16LE(28);
    const dataStart = candidate.localHeaderOffset + 30 + filenameLength + extraLength;
    const compressed = await readRange(dataStart, dataStart + candidate.compressedSize - 1);
    const content = candidate.method === 0
      ? compressed
      : candidate.method === 8
        ? inflateRawSync(compressed)
        : null;
    if (!content || content.length !== candidate.uncompressedSize) {
      throw new Error(`OpenViking wheel entry ${candidate.filename} could not be decoded.`);
    }
    if (result.has(candidate.suffix)) throw new Error(`OpenViking wheel contains duplicate ${candidate.suffix}.`);
    result.set(candidate.suffix, content);
  }
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  verifyOpenVikingRuntimeInputs()
    .then((results) => {
      for (const result of results) {
        process.stdout.write(`Verified OpenViking ${result.platform}-${result.arch} wheel patch inputs (${result.newlineStyles.codex}/${result.newlineStyles.vlm}).\n`);
      }
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
