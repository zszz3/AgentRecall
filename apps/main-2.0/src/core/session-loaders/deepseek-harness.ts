import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { cleanTitle, isMeaningfulUserMessage } from "../format-adapters";
import { MAX_ATTACHMENT_BYTES } from "../session-attachments";
import type {
  LoadedSession,
  SessionAttachment,
  SessionMessage,
  SessionTraceEvent,
  TokenUsageEvent,
} from "../types";
import {
  createIndexedSession,
  firstStringField,
  isRecord,
  objectField,
  parseMaybeJson,
  parseTimestampMs,
  shouldSkipFile,
  stringifyDetail,
  stringField,
  titleWithSummary,
  tokenEvent,
  tokenUsageFromEvents,
  unknownField,
  type SessionLoadOptions,
  type TraceEventDraft,
  type VirtualSessionFileStat,
} from "./common";

const DSH_HOME_DIR = ".dsh";
const DSH_SESSION_FILE = "session.jsonl";
const DSH_ZSTD_SESSION_FILE = "session.jsonl.zstd";
const DSH_ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/u;
const ZSTD_MAGIC = 0xFD2FB528;
const DSH_PACKED_ROW_TYPES = new Set([
  "text-chunks",
  "reasoning-chunks",
  "tool-call-chunks",
]);
const DSH_KNOWN_EVENT_TYPES = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/chunk",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry",
  "llm/retry-started",
  "permission/preset",
  "plan/mode",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "step/end",
  "step/start",
  "subagent/descriptor",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/call",
  "tool/code-dispatch",
  "tool/code-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
  "user/message",
  "web/deepseek-search-llm-request",
]);

interface DshSessionHeader {
  id: string;
  createdAt: number;
  cwd?: string;
  seedLength: number;
  parentSessionId: string | null;
  isSubagent: boolean;
}

interface DshDiscoveredTranscript {
  filePath: string;
  encoding: "raw" | "zstd";
  stat: VirtualSessionFileStat | null;
}

interface ZstdFrameRange {
  start: number;
  end: number;
}

interface ZstdFrameScan {
  frames: ZstdFrameRange[];
  tornStart?: number;
}

type StableRegularFileSnapshot =
  | { kind: "ok"; bytes: Buffer; stat: fs.BigIntStats }
  | { kind: "changed" }
  | { kind: "missing" }
  | { kind: "unsafe" }
  | { kind: "too_large"; size: bigint };

interface ResolveDshHomeOptions {
  homeDir?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the DeepSeek Harness home with the same precedence as DSH:
 * explicit config, DSH_HOME, then ~/.dsh.
 */
export function resolveDeepSeekHarnessHome(
  configured?: string,
  options: ResolveDshHomeOptions = {},
): string {
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const fromEnv = env.DSH_HOME;
  const selected = configured
    ?? (fromEnv !== undefined && fromEnv.trim().length > 0
      ? fromEnv
      : path.join(homeDir, DSH_HOME_DIR));
  const expanded = selected === "~"
    ? homeDir
    : selected.startsWith("~/") || selected.startsWith("~\\")
      ? path.join(homeDir, selected.slice(2))
      : selected;
  return path.resolve(options.cwd ?? process.cwd(), expanded);
}

// Adapted from DeepSeek Harness rc.7; see apps/main-2.0/THIRD_PARTY_NOTICES.md.
function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid Zstandard frame magic at byte ${offset}`);
    }
    offset += 4;

    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`reserved Zstandard block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }

  return { frames };
}

function parseCompleteJsonl(content: string, allowTornTail: boolean): unknown[] {
  const rows: unknown[] = [];
  const hasTerminalNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (index === 0) line = line.replace(/^\uFEFF/u, "");
    if (allowTornTail && index === lines.length - 1 && !hasTerminalNewline) break;
    if (index === lines.length - 1 && hasTerminalNewline && line === "") continue;
    if (!line.trim()) {
      throw new Error(`blank DeepSeek Harness JSONL record at line ${index + 1}`);
    }
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`invalid DeepSeek Harness JSONL record at line ${index + 1}`, { cause: error });
    }
  }
  return rows;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// Mirrors the rc.7 packed-chunk storage validator; see apps/main-2.0/THIRD_PARTY_NOTICES.md.
function packedRowLength(row: Record<string, unknown>): number {
  const tag = row.type;
  if (typeof tag !== "string" || !DSH_PACKED_ROW_TYPES.has(tag)) return 0;
  const fail = (reason: string): never => {
    throw new Error(`malformed DeepSeek Harness ${tag} storage row: ${reason}`);
  };
  if (!hasExactKeys(row, ["type", "seq0", "time0", "data"])) {
    fail("envelope must be exactly {type, seq0, time0, data}");
  }
  if (
    typeof row.seq0 !== "number"
    || !Number.isSafeInteger(row.seq0)
    || row.seq0 < 0
    || Object.is(row.seq0, -0)
  ) fail("seq0 must be a non-negative safe integer");
  if (typeof row.time0 !== "number" || !Number.isSafeInteger(row.time0)) {
    fail("time0 must be a safe integer");
  }
  if (!isRecord(row.data) || Array.isArray(row.data)) fail("data must be an object");
  const data = row.data as Record<string, unknown>;
  const payloadKey = tag === "tool-call-chunks" ? "args" : "texts";
  if (tag === "tool-call-chunks") {
    const withName = hasExactKeys(data, ["turn", "step", "index", "id", "name", "dt", "args"]);
    if (!withName && !hasExactKeys(data, ["turn", "step", "index", "id", "dt", "args"])) {
      fail("data must be exactly {turn, step, index, id, name?, dt, args}");
    }
    if (typeof data.id !== "string" || (withName && typeof data.name !== "string")) {
      fail("id (and name when present) must be strings");
    }
  } else if (!hasExactKeys(data, ["turn", "step", "index", "dt", "texts"])) {
    fail("data must be exactly {turn, step, index, dt, texts}");
  }
  if (typeof data.turn !== "number" || typeof data.step !== "number" || typeof data.index !== "number") {
    fail("turn/step/index must be numbers");
  }
  const payload = data[payloadKey];
  if (
    !Array.isArray(payload)
    || payload.length === 0
    || payload.some((entry) => typeof entry !== "string")
  ) fail(`${payloadKey} must be a non-empty string array`);
  const members = payload as string[];
  if (!Array.isArray(data.dt) || data.dt.some((gap: unknown) => !Number.isSafeInteger(gap))) {
    fail("dt must be an array of safe integers");
  }
  const gaps = data.dt as number[];
  if (gaps.length !== members.length - 1) {
    fail(`dt length ${gaps.length} does not match ${members.length} members`);
  }
  const seq0 = row.seq0 as number;
  if (!Number.isSafeInteger(seq0 + members.length - 1)) {
    fail("member seqs must stay safe integers");
  }
  let time = row.time0 as number;
  for (const gap of gaps) {
    time += gap;
    if (!Number.isSafeInteger(time)) fail("member times must stay safe integers");
  }
  return members.length;
}

function validateDshRecordSequence(rows: unknown[], seedLength: number): void {
  let expected = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!isRecord(row) || Array.isArray(row)) {
      throw new Error(`DeepSeek Harness storage record at line ${index + 1} is not an object.`);
    }
    const packedLength = packedRowLength(row);
    if (packedLength === 0) {
      if (typeof row.type !== "string" || !row.type) {
        throw new Error(`DeepSeek Harness event at line ${index + 1} has an invalid type.`);
      }
      if (Object.hasOwn(row, "ignorable") && row.ignorable !== true) {
        throw new Error(`DeepSeek Harness event at line ${index + 1} has an invalid ignorable marker.`);
      }
      if (!DSH_KNOWN_EVENT_TYPES.has(row.type) && row.ignorable !== true) {
        throw new Error(
          `DeepSeek Harness event type ${JSON.stringify(row.type)} at line ${index + 1} is unsupported and required.`,
        );
      }
    }
    const actual = packedLength > 0 ? row.seq0 : row.seq;
    if (
      typeof actual !== "number"
      || !Number.isSafeInteger(actual)
      || actual < 0
      || Object.is(actual, -0)
    ) {
      throw new Error(`DeepSeek Harness storage record at line ${index + 1} has an invalid sequence.`);
    }
    if (actual !== expected) {
      throw new Error(
        `DeepSeek Harness storage sequence gap at line ${index + 1} (expected ${expected}, got ${actual}).`,
      );
    }
    expected += packedLength || 1;
  }
  if (seedLength > expected) {
    throw new Error(
      `DeepSeek Harness seedLength ${seedLength} exceeds the decoded event count ${expected}.`,
    );
  }
}

function decodeDshRows(filePath: string, encoded: Buffer): unknown[] {
  if (!filePath.endsWith(".zstd")) return parseCompleteJsonl(encoded.toString("utf8"), true);

  const decoder = (zlib as typeof zlib & {
    zstdDecompressSync?: (input: Buffer) => Buffer;
  }).zstdDecompressSync;
  if (typeof decoder !== "function") {
    throw new Error(
      "This Node.js runtime does not provide Zstandard support required to read DeepSeek Harness sessions.",
    );
  }
  const { frames, tornStart } = scanZstdFrames(encoded);
  if (frames.length === 0) {
    throw new Error("DeepSeek Harness session has no complete Zstandard frame.");
  }
  const decoded = frames.map(({ start, end }) => {
    try {
      return decoder(encoded.subarray(start, end));
    } catch (error) {
      throw new Error(`corrupt DeepSeek Harness Zstandard frame at byte ${start}`, { cause: error });
    }
  });
  const headerFrame = decoded[0];
  if (headerFrame.length === 0 || headerFrame.indexOf(0x0A) !== headerFrame.length - 1) {
    throw new Error("DeepSeek Harness Zstandard first frame is not exactly one header line.");
  }
  const completePlaintext = Buffer.concat(decoded);
  if (completePlaintext.length === 0 || completePlaintext.at(-1) !== 0x0A) {
    throw new Error("DeepSeek Harness complete Zstandard frame contains an unterminated JSONL record.");
  }
  if (tornStart === undefined) {
    return parseCompleteJsonl(completePlaintext.toString("utf8"), false);
  }

  let recoveredPlaintext = Buffer.alloc(0);
  try {
    recoveredPlaintext = decoder(encoded.subarray(tornStart), {
      finishFlush: zlib.constants.ZSTD_e_flush,
    });
  } catch {
    // A frame can be truncated before Node's decoder can emit plaintext. Keep
    // the complete preceding frames and leave the source artifact untouched.
  }
  return parseCompleteJsonl(
    Buffer.concat([completePlaintext, recoveredPlaintext]).toString("utf8"),
    true,
  );
}

function dshHeader(row: unknown): DshSessionHeader | null {
  if (!isRecord(row) || row.type !== "session" || row.version !== 0) return null;
  const id = stringField(row, "id");
  const createdAt = row.createdAt;
  if (
    !id.trim()
    || id.includes("\0")
    || typeof createdAt !== "number"
    || !Number.isSafeInteger(createdAt)
    || createdAt < 0
    || Object.is(createdAt, -0)
  ) return null;
  if (
    Object.hasOwn(row, "cwd")
    && (
      typeof row.cwd !== "string"
      || row.cwd.length === 0
      || row.cwd.includes("\0")
      || (!path.posix.isAbsolute(row.cwd) && !path.win32.isAbsolute(row.cwd))
    )
  ) return null;
  if (
    Object.hasOwn(row, "parentSession")
    && (
      typeof row.parentSession !== "string"
      || !row.parentSession.trim()
      || row.parentSession.includes("\0")
    )
  ) return null;
  if (Object.hasOwn(row, "origin") && row.origin !== "subagent") return null;
  if (
    Object.hasOwn(row, "seedLength")
    && (
      typeof row.seedLength !== "number"
      || !Number.isSafeInteger(row.seedLength)
      || row.seedLength < 0
      || Object.is(row.seedLength, -0)
    )
  ) return null;
  if (Object.hasOwn(row, "agentPreset") && typeof row.agentPreset !== "string") return null;
  if (Object.hasOwn(row, "sandboxMode") || Object.hasOwn(row, "approvalPolicy")) return null;
  const parentSessionId = typeof row.parentSession === "string" ? row.parentSession : null;
  const seedLength = typeof row.seedLength === "number" ? row.seedLength : 0;
  // Pre-rc.7 v0 logs could omit this now-required writer field; zero preserves their top-level meaning.
  const hasDelegationDepth = Object.hasOwn(row, "delegationDepth");
  if (
    hasDelegationDepth
    && (
      typeof row.delegationDepth !== "number"
      || !Number.isSafeInteger(row.delegationDepth)
      || row.delegationDepth < 0
      || Object.is(row.delegationDepth, -0)
    )
  ) return null;
  const delegationDepth = hasDelegationDepth ? row.delegationDepth as number : 0;
  return {
    id,
    createdAt,
    ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
    seedLength,
    parentSessionId,
    isSubagent: row.origin === "subagent" || delegationDepth > 0,
  };
}

function eventTimestamp(row: Record<string, unknown>): string {
  const timestamp = parseTimestampMs(row.time);
  return timestamp > 0 || row.time === 0 ? new Date(timestamp).toISOString() : "";
}

function turnNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  return contentBlocks(value)
    .flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : [])
    .join("\n");
}

function mimeExtension(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return "";
}

function attachmentName(value: unknown, digest: string, mimeType: string): string {
  if (typeof value === "string") {
    const leaf = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
    const clean = leaf.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 255);
    if (clean) return clean;
  }
  return `${digest.slice(0, 12)}${mimeExtension(mimeType)}`;
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  const startOfFrame = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xFF) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xFF) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xD8 || marker === 0xD9) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (startOfFrame.has(marker) && length >= 7) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 21) return null;
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([0x9D, 0x01, 0x2A]))) {
    return {
      width: bytes.readUInt16LE(26) & 0x3FFF,
      height: bytes.readUInt16LE(28) & 0x3FFF,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2F) {
    const bits = bytes.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3FFF),
      height: 1 + ((bits >>> 14) & 0x3FFF),
    };
  }
  return null;
}

function detectedImageMetadata(bytes: Buffer): { mimeType: string; width: number; height: number } | null {
  if (
    bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
  ) {
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    const dimensions = jpegDimensions(bytes);
    return dimensions ? { mimeType: "image/jpeg", ...dimensions } : null;
  }
  if (bytes.length >= 10) {
    const signature = bytes.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { mimeType: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const dimensions = webpDimensions(bytes);
    return dimensions ? { mimeType: "image/webp", ...dimensions } : null;
  }
  return null;
}

function unavailableAttachment(
  id: string,
  fileName: string,
  mimeType: string,
  status: SessionAttachment["status"],
  sizeBytes?: number,
  sha256?: string,
): SessionAttachment {
  return {
    id,
    fileName,
    mimeType,
    previewKind: "image",
    status,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(sha256 ? { sha256 } : {}),
  };
}

// Follows the rc.7 content-addressed image contract; see apps/main-2.0/THIRD_PARTY_NOTICES.md.
function dshAttachment(
  block: Record<string, unknown>,
  dshHome: string,
  cache: Map<string, SessionAttachment>,
): SessionAttachment | null {
  if (block.type !== "image") return null;
  const ref = objectField(block, "attachment");
  if (!ref) return null;
  const attachmentId = stringField(ref, "attachmentId");
  const match = DSH_ATTACHMENT_ID.exec(attachmentId);
  const mimeType = stringField(ref, "mediaType") || "application/octet-stream";
  const declaredBytes = typeof ref.bytes === "number" && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0
    ? ref.bytes
    : undefined;
  const declaredWidth = typeof ref.width === "number" && Number.isSafeInteger(ref.width) && ref.width > 0
    ? ref.width
    : undefined;
  const declaredHeight = typeof ref.height === "number" && Number.isSafeInteger(ref.height) && ref.height > 0
    ? ref.height
    : undefined;
  const digest = match?.[1] ?? "";
  const fileName = attachmentName(ref.name, digest || "attachment", mimeType);
  if (
    !match
    || declaredBytes === undefined
    || declaredBytes <= 0
    || declaredWidth === undefined
    || declaredHeight === undefined
    || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)
  ) {
    return unavailableAttachment(attachmentId || "invalid-dsh-attachment", fileName, mimeType, "unsafe", declaredBytes);
  }
  const cacheKey = [
    attachmentId,
    mimeType,
    declaredBytes,
    declaredWidth,
    declaredHeight,
    fileName,
  ].join("\0");
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const remember = (attachment: SessionAttachment): SessionAttachment => {
    cache.set(cacheKey, attachment);
    return attachment;
  };
  if (declaredBytes > MAX_ATTACHMENT_BYTES) {
    return remember(unavailableAttachment(
      attachmentId,
      fileName,
      mimeType,
      "too_large",
      declaredBytes,
      digest,
    ));
  }

  const attachmentRoot = path.resolve(dshHome, "attachments", "v1");
  const objectsRoot = path.join(attachmentRoot, "objects");
  const objectPath = path.join(objectsRoot, digest.slice(0, 2), digest);
  const relative = path.relative(objectsRoot, objectPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return remember(unavailableAttachment(attachmentId, fileName, mimeType, "unsafe", declaredBytes, digest));
  }

  let canonicalObjectsRoot: string;
  let canonicalObject: string;
  let canonicalDshHome: string;
  let objectState: fs.BigIntStats;
  try {
    canonicalDshHome = fs.realpathSync(dshHome);
    canonicalObjectsRoot = fs.realpathSync(objectsRoot);
    const rootRelative = path.relative(canonicalDshHome, canonicalObjectsRoot);
    if (rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) {
      return remember(unavailableAttachment(attachmentId, fileName, mimeType, "unsafe", declaredBytes, digest));
    }
    const objectLstat = fs.lstatSync(objectPath, { bigint: true });
    if (!objectLstat.isFile() || objectLstat.isSymbolicLink()) {
      const objectBytes = objectLstat.size <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(objectLstat.size)
        : undefined;
      return remember(unavailableAttachment(attachmentId, fileName, mimeType, "unsafe", objectBytes, digest));
    }
    objectState = objectLstat;
    canonicalObject = fs.realpathSync(objectPath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return remember(unavailableAttachment(attachmentId, fileName, mimeType, "missing", declaredBytes, digest));
    }
    return remember(unavailableAttachment(attachmentId, fileName, mimeType, "unsafe", declaredBytes, digest));
  }
  const canonicalRelative = path.relative(canonicalObjectsRoot, canonicalObject);
  if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) {
    return remember(unavailableAttachment(attachmentId, fileName, mimeType, "unsafe", declaredBytes, digest));
  }

  const snapshot = readStableRegularFile(objectPath, MAX_ATTACHMENT_BYTES, objectState);
  if (snapshot.kind === "missing") {
    return remember(unavailableAttachment(attachmentId, fileName, mimeType, "missing", declaredBytes, digest));
  }
  if (snapshot.kind === "too_large") {
    const actualBytes = snapshot.size <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(snapshot.size)
      : undefined;
    return remember(unavailableAttachment(attachmentId, fileName, mimeType, "too_large", actualBytes, digest));
  }
  if (snapshot.kind !== "ok") {
    return remember(unavailableAttachment(attachmentId, fileName, mimeType, "unsafe", declaredBytes, digest));
  }
  const actualBytes = Number(snapshot.stat.size);
  if (actualBytes !== declaredBytes) {
    return remember(unavailableAttachment(attachmentId, fileName, mimeType, "unsafe", actualBytes, digest));
  }
  try {
    const objectAfter = fs.lstatSync(objectPath);
    const canonicalAfter = fs.realpathSync(objectPath);
    const afterRelative = path.relative(canonicalObjectsRoot, canonicalAfter);
    if (
      !objectAfter.isFile()
      || objectAfter.isSymbolicLink()
      || canonicalAfter !== canonicalObject
      || afterRelative.startsWith("..")
      || path.isAbsolute(afterRelative)
    ) {
      return remember(unavailableAttachment(attachmentId, fileName, mimeType, "unsafe", actualBytes, digest));
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return remember(unavailableAttachment(attachmentId, fileName, mimeType, "missing", actualBytes, digest));
    }
    return remember(unavailableAttachment(attachmentId, fileName, mimeType, "unsafe", actualBytes, digest));
  }
  const bytes = snapshot.bytes;
  const metadata = detectedImageMetadata(bytes);
  if (
    createHash("sha256").update(bytes).digest("hex") !== digest
    || metadata?.mimeType !== mimeType
    || metadata.width !== declaredWidth
    || metadata.height !== declaredHeight
  ) {
    return remember(unavailableAttachment(attachmentId, fileName, mimeType, "unsafe", bytes.length, digest));
  }
  return remember({
    id: attachmentId,
    fileName,
    mimeType,
    sizeBytes: bytes.length,
    previewKind: "image",
    status: "available",
    source: { kind: "inline", value: bytes.toString("base64") },
    sha256: digest,
  });
}

function messageContent(
  value: unknown,
  dshHome: string,
  attachmentCache: Map<string, SessionAttachment>,
): { text: string; taskText: string; attachments?: SessionAttachment[] } {
  const taskText = textFromContent(value);
  const attachments = contentBlocks(value)
    .map((block) => dshAttachment(block, dshHome, attachmentCache))
    .filter((attachment): attachment is SessionAttachment => attachment !== null);
  return {
    text: taskText || (attachments.length > 0 ? "[Attachment]" : ""),
    taskText,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function assistantMessageData(data: Record<string, unknown>): Record<string, unknown> {
  return objectField(data, "message") ?? data;
}

function dshUsage(
  row: Record<string, unknown>,
  data: Record<string, unknown>,
  turn: number | null,
): TokenUsageEvent | null {
  const usage = objectField(data, "usage");
  const seq = row.seq;
  if (!usage || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
  const nonNegative = (key: string): number | null => {
    const value = usage[key];
    if (value === undefined) return 0;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const input = nonNegative("inputTokens");
  const reportedOutput = nonNegative("outputTokens");
  const cacheRead = nonNegative("cacheReadTokens");
  const cacheWrite = nonNegative("cacheWriteTokens");
  const reportedReasoning = nonNegative("reasoningTokens");
  if (
    input === null
    || reportedOutput === null
    || cacheRead === null
    || cacheWrite === null
    || reportedReasoning === null
  ) return null;
  const reasoning = Math.min(reportedOutput, reportedReasoning);
  const event = tokenEvent(
    parseTimestampMs(row.time),
    `dsh:${seq}`,
    input,
    reportedOutput - reasoning,
    cacheRead,
    reasoning,
    cacheWrite,
  );
  if (event.totalTokens === 0) return null;
  return { ...event, ...(turn !== null ? { sourceTurnId: `dsh:${turn}` } : {}) };
}

function toolResultData(data: Record<string, unknown>): {
  callId: string;
  output: unknown;
  failed: boolean;
} | null {
  const message = objectField(data, "message");
  if (!message) {
    const callId = stringField(data, "callId");
    if (!callId || !Object.hasOwn(data, "content")) return null;
    return {
      callId,
      output: data.content,
      failed: data.isError === true || objectField(data, "error") !== null,
    };
  }
  const source = objectField(message, "source");
  const sourceCallId = stringField(source, "callId");
  const block = contentBlocks(message.content).find((item) =>
    item.type === "tool-result"
    && (!sourceCallId || stringField(item, "toolCallId") === sourceCallId));
  const callId = sourceCallId || stringField(block, "toolCallId");
  if (!callId || !block) return null;
  return {
    callId,
    output: block.content,
    failed: block.isError === true || objectField(data, "error") !== null,
  };
}

function outputDetail(value: unknown): string {
  const text = textFromContent(value);
  return text || stringifyDetail(value);
}

// Parses the rc.7 descriptor-v2 schema; see apps/main-2.0/THIRD_PARTY_NOTICES.md.
function dshDescriptorLabel(data: Record<string, unknown>): string | null {
  if (data.version !== 2) return null;
  const mode = data.mode;
  if (mode !== "one-shot" && mode !== "continuable") return null;
  const allowedKeys = new Set(mode === "one-shot"
    ? ["version", "mode", "provider", "label"]
    : [
        "version",
        "mode",
        "provider",
        "label",
        "agentProvider",
        "agentModel",
        "persona",
        "toolFilter",
      ]);
  if (Object.keys(data).some((key) => !allowedKeys.has(key))) return null;
  if (typeof data.provider !== "string") return null;
  if (mode === "continuable" && typeof data.label !== "string") return null;
  if (Object.hasOwn(data, "label") && typeof data.label !== "string") return null;
  for (const key of ["agentProvider", "agentModel", "persona"]) {
    if (Object.hasOwn(data, key) && typeof data[key] !== "string") return null;
  }
  if (Object.hasOwn(data, "toolFilter")) {
    const toolFilter = objectField(data, "toolFilter");
    if (!toolFilter) return null;
    const keys = Object.keys(toolFilter);
    if (
      keys.length === 0
      || keys.some((key) => key !== "allow" && key !== "deny")
      || keys.some((key) =>
        !Array.isArray(toolFilter[key])
        || (toolFilter[key] as unknown[]).some((item) => typeof item !== "string"))
    ) return null;
  }
  return typeof data.label === "string" ? data.label.trim() : "";
}

function turnEndPresentation(reason: unknown): {
  eventType: "dsh.turn.completed" | "dsh.turn.aborted" | "dsh.turn.failed";
  status: SessionTraceEvent["status"];
  title: string;
  detail: string;
  abortReason?: string;
} {
  const record = isRecord(reason) ? reason : {};
  const kind = stringField(record, "kind");
  if (kind === "completed") {
    return { eventType: "dsh.turn.completed", status: "completed", title: "Turn completed", detail: "" };
  }
  if (kind === "aborted" || kind === "disposed" || kind === "interrupted") {
    const cause = objectField(record, "reason");
    const causeKind = stringField(cause, "kind") || kind;
    const hookReason = stringField(cause, "reason");
    const abortReason = hookReason || causeKind;
    return {
      eventType: "dsh.turn.aborted",
      status: "aborted",
      title: "Turn aborted",
      detail: abortReason,
      abortReason,
    };
  }
  const failure = objectField(record, "error") ?? objectField(record, "failure");
  const message = stringField(failure, "message") || stringField(record, "message") || kind || "unknown";
  return {
    eventType: "dsh.turn.failed",
    status: "failed",
    title: "Turn failed",
    detail: message,
  };
}

function loadDshRows(
  filePath: string,
  rows: unknown[],
  dshHome: string,
  stat: VirtualSessionFileStat,
): LoadedSession {
  const header = dshHeader(rows[0]);
  if (!header) throw new Error("DeepSeek Harness session header is missing or unsupported.");
  const ownRows = rows.slice(1).filter((row) =>
    isRecord(row)
    && typeof row.seq === "number"
    && row.seq >= header.seedLength);

  const messages: SessionMessage[] = [];
  const tokenEvents: TokenUsageEvent[] = [];
  const traceDrafts: TraceEventDraft[] = [];
  const toolNames = new Map<string, string>();
  const turnStarts = new Map<number, number>();
  const attachmentCache = new Map<string, SessionAttachment>();
  let activeTurn: number | null = null;
  let title = "";
  let descriptorLabel = "";
  let descriptorSeen = false;
  let firstUserTask = "";

  for (const rowValue of ownRows) {
    if (!isRecord(rowValue) || typeof rowValue.type !== "string") continue;
    const row = rowValue;
    const data = objectField(row, "data");
    const timestamp = eventTimestamp(row);

    if (row.type === "session/title" && data) {
      const candidate = stringField(data, "title").trim();
      if (candidate) title = candidate;
      continue;
    }
    if (row.type === "subagent/descriptor") {
      if (!descriptorSeen) {
        descriptorSeen = true;
        if (data) {
          const candidate = dshDescriptorLabel(data);
          if (candidate !== null) descriptorLabel = candidate;
        }
      }
      continue;
    }

    if (row.type === "turn/start" && data) {
      const turn = turnNumber(data.turn);
      if (turn === null) continue;
      activeTurn = turn;
      const startedAt = parseTimestampMs(row.time);
      if (startedAt > 0) turnStarts.set(turn, startedAt);
      traceDrafts.push({
        kind: "event",
        source: "dsh",
        title: "Turn started",
        detail: "",
        timestamp,
        eventType: "dsh.turn.started",
        status: "running",
        sourceTurnId: `dsh:${turn}`,
        attributes: { ...(timestamp ? { startedAt: timestamp } : {}) },
      });
      continue;
    }

    if (row.type === "turn/end" && data) {
      const turn = turnNumber(data.turn);
      if (turn === null) continue;
      const presentation = turnEndPresentation(unknownField(data, "reason"));
      const endedAt = parseTimestampMs(row.time);
      const startedAt = turnStarts.get(turn);
      traceDrafts.push({
        kind: "event",
        source: "dsh",
        title: presentation.title,
        detail: presentation.detail,
        timestamp,
        eventType: presentation.eventType,
        status: presentation.status,
        sourceTurnId: `dsh:${turn}`,
        attributes: {
          ...(timestamp ? { endedAt: timestamp } : {}),
          ...(startedAt !== undefined && endedAt >= startedAt ? { durationMs: endedAt - startedAt } : {}),
          ...(presentation.abortReason ? { abortReason: presentation.abortReason } : {}),
          reason: isRecord(data.reason) ? data.reason : {},
        },
      });
      if (activeTurn === turn) activeTurn = null;
      continue;
    }

    if (row.type === "user/message" && row.surfaceOp === "append" && data) {
      const source = objectField(data, "source");
      const human = source?.kind === "user";
      const coordinatorRelay = source?.kind === "coordinator" && source.form === "relay";
      if (!human && !coordinatorRelay) continue;
      const content = messageContent(data.content, dshHome, attachmentCache);
      if (!content.text) continue;
      if (!firstUserTask && isMeaningfulUserMessage(content.taskText)) firstUserTask = content.taskText;
      messages.push({
        role: "user",
        content: content.text,
        timestamp,
        index: messages.length,
        ...(activeTurn !== null ? { sourceTurnId: `dsh:${activeTurn}` } : {}),
        ...(content.attachments ? { attachments: content.attachments } : {}),
      });
      continue;
    }

    if (row.type === "assistant/message" && row.surfaceOp === "append" && data) {
      const message = assistantMessageData(data);
      const content = messageContent(message.content, dshHome, attachmentCache);
      const turn = turnNumber(data.turn) ?? activeTurn;
      if (content.text) {
        messages.push({
          role: "assistant",
          content: content.text,
          timestamp,
          index: messages.length,
          ...(turn !== null ? { sourceTurnId: `dsh:${turn}` } : {}),
          ...(content.attachments ? { attachments: content.attachments } : {}),
        });
      }
      const usage = dshUsage(row, data, turn);
      if (usage) tokenEvents.push(usage);
      continue;
    }

    if (
      row.type === "tool/call"
      && (row.surfaceOp === undefined || row.surfaceOp === "append")
      && data
    ) {
      const callId = stringField(data, "callId");
      const name = stringField(data, "name");
      if (!callId || !name) continue;
      const input = parseMaybeJson(unknownField(data, "arguments"));
      const turn = turnNumber(data.turn) ?? activeTurn;
      toolNames.set(callId, name);
      traceDrafts.push({
        kind: "tool_call",
        source: "dsh",
        title: titleWithSummary(
          name,
          firstStringField(input, ["command", "cmd", "path", "file_path", "query", "url", "description"]),
        ),
        detail: stringifyDetail(input),
        timestamp,
        callId,
        eventType: "dsh.tool.call",
        status: "running",
        ...(turn !== null ? { sourceTurnId: `dsh:${turn}` } : {}),
        attributes: {
          input,
          ...(turn !== null ? { turn } : {}),
          ...(turnNumber(data.step) !== null ? { step: data.step } : {}),
        },
      });
      continue;
    }

    if (row.type === "tool/result" && row.surfaceOp === "append" && data) {
      const result = toolResultData(data);
      if (!result) continue;
      const name = toolNames.get(result.callId) || "tool";
      const turn = turnNumber(data.turn) ?? activeTurn;
      traceDrafts.push({
        kind: "tool_result",
        source: "dsh",
        title: titleWithSummary(name, "result"),
        detail: outputDetail(result.output),
        timestamp,
        callId: result.callId,
        eventType: "dsh.tool.result",
        status: result.failed ? "failed" : "completed",
        ...(turn !== null ? { sourceTurnId: `dsh:${turn}` } : {}),
        attributes: {
          output: result.output,
          ...(turn !== null ? { turn } : {}),
          ...(turnNumber(data.step) !== null ? { step: data.step } : {}),
        },
      });
    }
  }

  const question = firstUserTask;
  if (messages.length === 0 && traceDrafts.length === 0) {
    throw new Error("DeepSeek Harness session contains no indexable events.");
  }
  const session = createIndexedSession({
    keyPrefix: "dsh",
    rawId: header.id,
    source: "deepseek-harness",
    projectPath: header.cwd ?? "",
    filePath,
    originalTitle: title || cleanTitle(question) || descriptorLabel || "Untitled Session",
    firstQuestion: cleanTitle(question),
    timestamp: header.createdAt,
    tokenUsage: tokenUsageFromEvents(tokenEvents),
    stat,
    isSubagent: header.isSubagent,
    parentSessionId: header.parentSessionId,
  });
  return {
    session: { ...session, timestamp: header.createdAt },
    messages,
    tokenEvents,
    traceEvents: traceDrafts.map((event, index) => ({ ...event, index })),
  };
}

function strictDshSessionPath(filePath: string, sessionsDir: string): boolean {
  const relative = path.relative(sessionsDir, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  return segments.length === 3
    && Boolean(segments[0])
    && Boolean(segments[1])
    && (segments[2] === DSH_SESSION_FILE || segments[2] === DSH_ZSTD_SESSION_FILE);
}

// Path encoding and project keys follow rc.7 storage layout; see apps/main-2.0/THIRD_PARTY_NOTICES.md.
function encodeDshSegment(raw: string): string {
  if (!raw) throw new Error("DeepSeek Harness session id is empty.");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let encoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    encoded += character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
}

function dshProjectKey(cwd: string): string {
  if (!cwd) throw new Error("DeepSeek Harness project path is empty.");
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/u, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}

function samePhysicalFile(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertDshStoredIdentity(
  filePath: string,
  sessionsDir: string,
  header: DshSessionHeader,
): void {
  const project = header.cwd === undefined ? "_no-cwd" : dshProjectKey(header.cwd);
  const expectedPath = path.join(
    sessionsDir,
    project,
    encodeDshSegment(header.id),
    filePath.endsWith(".zstd") ? DSH_ZSTD_SESSION_FILE : DSH_SESSION_FILE,
  );
  if (path.resolve(filePath) !== path.resolve(expectedPath) && !samePhysicalFile(filePath, expectedPath)) {
    throw new Error(
      `DeepSeek Harness header id and cwd do not match the transcript storage path ${JSON.stringify(filePath)}.`,
    );
  }
}

export function loadDeepSeekHarnessSessionFile(
  filePath: string,
  dshHome: string,
  stat?: VirtualSessionFileStat,
): LoadedSession {
  const sessionsDir = path.join(dshHome, "sessions");
  if (!strictDshSessionPath(filePath, sessionsDir)) {
    throw new Error("DeepSeek Harness transcript is outside the supported session layout.");
  }
  let canonicalSessionsDir: string;
  try {
    const canonicalDshHome = fs.realpathSync(dshHome);
    canonicalSessionsDir = fs.realpathSync(sessionsDir);
    if (path.resolve(canonicalSessionsDir) !== path.resolve(canonicalDshHome, "sessions")) {
      throw new Error("DeepSeek Harness sessions directory resolves outside its canonical home.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("resolves outside")) throw error;
    throw new Error("DeepSeek Harness sessions directory could not be resolved safely.", { cause: error });
  }
  const discovered = candidateStat(filePath);
  if (!discovered) {
    throw new Error("DeepSeek Harness transcript is not a regular file.");
  }
  let before = stat
    ? { mtimeMs: stat.mtimeMs, size: stat.size }
    : discovered;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = readDshTranscriptSnapshot(filePath, canonicalSessionsDir);
    if (snapshot && snapshot.stat.mtimeMs === before.mtimeMs && snapshot.stat.size === before.size) {
      const rows = decodeDshRows(filePath, snapshot.bytes);
      const header = dshHeader(rows[0]);
      if (!header) throw new Error("DeepSeek Harness session header is missing or unsupported.");
      validateDshRecordSequence(rows, header.seedLength);
      assertDshStoredIdentity(filePath, sessionsDir, header);
      return loadDshRows(filePath, rows, dshHome, snapshot.stat);
    }
    if (snapshot) before = snapshot.stat;
  }
  throw new Error("DeepSeek Harness transcript kept changing while it was being read.");
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function sameFileState(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function virtualFileStat(stat: fs.BigIntStats): VirtualSessionFileStat {
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("DeepSeek Harness transcript is too large to index safely.");
  }
  const wholeMilliseconds = stat.mtimeNs / 1_000_000n;
  const remainingNanoseconds = stat.mtimeNs % 1_000_000n;
  return {
    mtimeMs: Number(wholeMilliseconds) + Number(remainingNanoseconds) / 1_000_000,
    size: Number(stat.size),
  };
}

function readBoundedFile(
  descriptor: number,
  size: number,
): Buffer | null {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (read === 0) return null;
    offset += read;
  }
  const extra = Buffer.allocUnsafe(1);
  return fs.readSync(descriptor, extra, 0, 1, size) === 0 ? bytes : null;
}

function readStableRegularFile(
  filePath: string,
  maximumBytes?: number,
  expectedState?: fs.BigIntStats,
): StableRegularFileSnapshot {
  let pathBefore: fs.BigIntStats;
  try {
    pathBefore = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    return isRecord(error) && error.code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unsafe" };
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) return { kind: "unsafe" };
  if (expectedState && !sameFileState(expectedState, pathBefore)) return { kind: "changed" };
  const maximum = maximumBytes === undefined ? null : BigInt(maximumBytes);
  if (maximum !== null && pathBefore.size > maximum) {
    return { kind: "too_large", size: pathBefore.size };
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    return isRecord(error) && (error.code === "ENOENT" || error.code === "ESTALE")
      ? { kind: "changed" }
      : { kind: "unsafe" };
  }

  try {
    const descriptorBefore = fs.fstatSync(descriptor, { bigint: true });
    if (!descriptorBefore.isFile()) return { kind: "unsafe" };
    if (maximum !== null && descriptorBefore.size > maximum) {
      return { kind: "too_large", size: descriptorBefore.size };
    }
    if (!sameFileState(pathBefore, descriptorBefore)) return { kind: "changed" };

    let bytes: Buffer | null;
    try {
      bytes = maximum === null
        ? fs.readFileSync(descriptor)
        : readBoundedFile(descriptor, Number(descriptorBefore.size));
    } catch {
      return { kind: "unsafe" };
    }
    if (!bytes) return { kind: "changed" };

    const descriptorAfter = fs.fstatSync(descriptor, { bigint: true });
    if (maximum !== null && descriptorAfter.size > maximum) {
      return { kind: "too_large", size: descriptorAfter.size };
    }
    let pathAfter: fs.BigIntStats;
    try {
      pathAfter = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
      return isRecord(error) && error.code === "ENOENT"
        ? { kind: "changed" }
        : { kind: "unsafe" };
    }
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink()) return { kind: "unsafe" };
    if (
      !sameFileState(descriptorBefore, descriptorAfter)
      || !sameFileState(descriptorAfter, pathAfter)
    ) return { kind: "changed" };
    return { kind: "ok", bytes, stat: descriptorAfter };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readDshTranscriptSnapshot(
  filePath: string,
  canonicalSessionsDir: string,
): { bytes: Buffer; stat: VirtualSessionFileStat } | null {
  let canonicalBefore: string;
  let expectedState: fs.BigIntStats;
  try {
    canonicalBefore = fs.realpathSync(filePath);
    if (!isPathWithin(canonicalBefore, canonicalSessionsDir)) {
      throw new Error("DeepSeek Harness transcript resolves outside the canonical sessions directory.");
    }
    expectedState = fs.lstatSync(canonicalBefore, { bigint: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("resolves outside")) throw error;
    throw new Error("DeepSeek Harness transcript could not be resolved safely.", { cause: error });
  }

  const snapshot = readStableRegularFile(filePath, undefined, expectedState);
  if (snapshot.kind === "changed") return null;
  if (snapshot.kind === "missing") {
    throw new Error("DeepSeek Harness transcript disappeared while it was being read.");
  }
  if (snapshot.kind === "too_large") {
    throw new Error("DeepSeek Harness transcript is too large to index safely.");
  }
  if (snapshot.kind === "unsafe") {
    throw new Error("DeepSeek Harness transcript is not a stable regular non-symlink file.");
  }
  try {
    const canonicalAfter = fs.realpathSync(filePath);
    if (!isPathWithin(canonicalAfter, canonicalSessionsDir)) {
      throw new Error("DeepSeek Harness transcript resolves outside the canonical sessions directory.");
    }
    if (canonicalAfter !== canonicalBefore) return null;
  } catch (error) {
    if (error instanceof Error && error.message.includes("resolves outside")) throw error;
    throw new Error("DeepSeek Harness transcript could not be resolved safely.", { cause: error });
  }
  return { bytes: snapshot.bytes, stat: virtualFileStat(snapshot.stat) };
}

function candidateStat(filePath: string): VirtualSessionFileStat | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function readDirectories(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function warnSkipped(filePath: string, reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.warn(`[DeepSeek Harness] Skipping ${filePath}: ${message}`);
}

function dshCandidates(
  sessionsDir: string,
): DshDiscoveredTranscript[] {
  const discovered: DshDiscoveredTranscript[] = [];
  for (const project of readDirectories(sessionsDir)) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(sessionsDir, project.name);
    for (const session of readDirectories(projectDir)) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(projectDir, session.name);
      for (const [fileName, encoding] of [
        [DSH_SESSION_FILE, "raw"],
        [DSH_ZSTD_SESSION_FILE, "zstd"],
      ] as const) {
        const filePath = path.join(sessionDir, fileName);
        if (!fs.existsSync(filePath)) continue;
        const stat = candidateStat(filePath);
        discovered.push({
          filePath,
          encoding,
          stat,
        });
      }
    }
  }

  const encodings = new Set(discovered.map((candidate) => candidate.encoding));
  if (encodings.size > 1) {
    warnSkipped(
      sessionsDir,
      "both raw and Zstandard transcripts are present in one sessions root; mixed physical encodings are unsupported",
    );
    return [];
  }

  return discovered;
}

export function* loadDeepSeekHarnessSessionsIterator(
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  const dshHome = resolveDeepSeekHarnessHome(options.deepSeekHarnessHomeDir, { homeDir: options.homeDir });
  const sessionsDir = path.join(dshHome, "sessions");
  const candidates = dshCandidates(sessionsDir);
  const byStoredId = new Map<string, DshDiscoveredTranscript[]>();
  for (const candidate of candidates) {
    const storedId = path.basename(path.dirname(candidate.filePath));
    const siblings = byStoredId.get(storedId) ?? [];
    siblings.push(candidate);
    byStoredId.set(storedId, siblings);
  }
  const loaded: LoadedSession[] = [];
  for (const candidate of candidates) {
    const storedId = path.basename(path.dirname(candidate.filePath));
    const physicalDuplicates = byStoredId.get(storedId) ?? [];
    if (physicalDuplicates.length > 1) {
      if (physicalDuplicates[0] === candidate) {
        for (const duplicate of physicalDuplicates) {
          warnSkipped(
            duplicate.filePath,
            `duplicate session id ${JSON.stringify(storedId)} appears in multiple project directories`,
          );
        }
      }
      continue;
    }
    if (!candidate.stat) {
      warnSkipped(candidate.filePath, "transcript is not a regular file");
      continue;
    }
    if (shouldSkipFile(options, candidate.filePath, candidate.stat)) continue;
    try {
      loaded.push(loadDeepSeekHarnessSessionFile(candidate.filePath, dshHome, candidate.stat));
    } catch (error) {
      warnSkipped(candidate.filePath, error);
    }
  }

  const byId = new Map<string, LoadedSession[]>();
  for (const item of loaded) {
    const siblings = byId.get(item.session.rawId) ?? [];
    siblings.push(item);
    byId.set(item.session.rawId, siblings);
  }
  for (const item of loaded) {
    const duplicates = byId.get(item.session.rawId) ?? [];
    if (duplicates.length > 1) {
      if (duplicates[0] === item) {
        for (const duplicate of duplicates) {
          warnSkipped(
            duplicate.session.filePath,
            `duplicate session id ${JSON.stringify(item.session.rawId)} appears in multiple project directories`,
          );
        }
      }
      continue;
    }
    yield item;
  }
}

export function loadDeepSeekHarnessSessions(
  options: SessionLoadOptions = {},
): LoadedSession[] {
  return [...loadDeepSeekHarnessSessionsIterator(options)];
}
