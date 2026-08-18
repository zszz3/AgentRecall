import { createRequire } from "node:module";

const ZSTD_MAGIC = 0xFD2FB528;
const require = createRequire(import.meta.url);

interface ZstdFrameRange {
  start: number;
  end: number;
}

interface ZstdFrameScan {
  frames: ZstdFrameRange[];
  tornStart?: number;
}

interface NodeZlibModule {
  zstdDecompressSync?: (
    input: Uint8Array,
    options?: { finishFlush?: number },
  ) => Buffer;
  constants?: {
    ZSTD_e_flush?: number;
  };
}

export class DeepSeekHarnessZstdUnavailableError extends Error {
  override readonly name = "DeepSeekHarnessZstdUnavailableError";
}

/**
 * Decode DeepSeek Harness' append-friendly concatenated Zstandard container.
 * Every durable append is an independent checksummed frame. Node's one-shot
 * API decodes only one frame, so each structurally complete frame must be
 * isolated first. An incomplete final append is ignored; malformed complete
 * structure and checksum failures remain hard corruption.
 *
 * Frame scanning is adapted from DeepSeek Harness rc.7; see
 * apps/main-1.0/THIRD_PARTY_NOTICES.md.
 */
export function decodeDeepSeekHarnessZstd(source: Buffer): string {
  const { frames, tornStart } = scanZstdFrames(source);
  const zlib = require("node:zlib") as NodeZlibModule;
  const decompress = zlib.zstdDecompressSync;
  if (typeof decompress !== "function") {
    throw new DeepSeekHarnessZstdUnavailableError(
      "DeepSeek Harness compressed sessions require a Node.js runtime with Zstandard support.",
    );
  }
  if (frames.length === 0) {
    throw new Error("corrupt DeepSeek Harness Zstandard session: no complete header frame");
  }

  const decoded: Buffer[] = [];
  for (const [index, frame] of frames.entries()) {
    try {
      const plaintext = Buffer.from(decompress(source.subarray(frame.start, frame.end)));
      if (index === 0
        && (plaintext.length === 0
          || plaintext[plaintext.length - 1] !== 0x0A
          || plaintext.indexOf(0x0A) !== plaintext.length - 1)) {
        throw new Error("first frame must contain exactly one header record");
      }
      decoded.push(plaintext);
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(
        `corrupt DeepSeek Harness Zstandard session: frame at byte ${frame.start} failed validation${detail}`,
      );
    }
  }
  if (tornStart !== undefined && typeof zlib.constants?.ZSTD_e_flush === "number") {
    try {
      decoded.push(Buffer.from(decompress(source.subarray(tornStart), {
        finishFlush: zlib.constants.ZSTD_e_flush,
      })));
    } catch {
      // An early cut may not have produced a decodable block yet. Complete
      // frames remain usable, and the final complete-line truncation below
      // keeps any unavailable torn fragment out of the logical transcript.
    }
  }
  const plaintext = Buffer.concat(decoded);
  if (tornStart !== undefined) {
    const lastNewline = plaintext.lastIndexOf(0x0A);
    return plaintext.subarray(0, Math.max(0, lastNewline + 1)).toString("utf8");
  }
  if (plaintext.length === 0 || plaintext[plaintext.length - 1] !== 0x0A) {
    throw new Error(
      "corrupt DeepSeek Harness Zstandard session: complete frames end inside a JSONL record",
    );
  }
  return plaintext.toString("utf8");
}

function scanZstdFrames(source: Buffer): ZstdFrameScan {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  while (offset < source.length) {
    const start = offset;
    if (source.length - offset < 4) return { frames, tornStart: start };
    if (source.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt DeepSeek Harness Zstandard session: invalid frame magic at byte ${offset}`);
    }
    offset += 4;

    if (offset === source.length) return { frames, tornStart: start };
    const descriptor = source.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(
        `corrupt DeepSeek Harness Zstandard session: reserved frame-header bit at byte ${offset - 1}`,
      );
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
    if (source.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (source.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = source.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(
          `corrupt DeepSeek Harness Zstandard session: reserved block type at byte ${offset - 3}`,
        );
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (source.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (source.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }

  return { frames };
}
