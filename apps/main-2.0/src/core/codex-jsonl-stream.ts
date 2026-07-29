import fs from "node:fs";

export interface JsonlScanResult {
  startOffset: number;
  committedOffset: number;
  fileSize: number;
  malformedLines: number;
}

export function scanCompleteJsonl(
  filePath: string,
  options: {
    startOffset?: number;
    chunkSize?: number;
    onRecord(record: unknown): void;
  },
): JsonlScanResult {
  const startOffset = options.startOffset ?? 0;
  const chunkSize = Math.max(1, options.chunkSize ?? 64 * 1024);
  const fileSize = fs.statSync(filePath).size;
  if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > fileSize) {
    throw new RangeError(`Invalid JSONL start offset ${startOffset} for ${fileSize}-byte file.`);
  }

  const descriptor = fs.openSync(filePath, "r");
  let position = startOffset;
  let committedOffset = startOffset;
  let malformedLines = 0;
  let pendingParts: Buffer[] = [];
  let pendingBytes = 0;

  try {
    while (position < fileSize) {
      const chunk = Buffer.allocUnsafe(Math.min(chunkSize, fileSize - position));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, position);
      if (bytesRead <= 0) throw new Error(`Unexpected end of JSONL file at byte ${position}.`);
      const content = chunk.subarray(0, bytesRead);
      let lineStart = 0;

      while (lineStart < content.length) {
        const newline = content.indexOf(0x0a, lineStart);
        if (newline < 0) {
          const tail = content.subarray(lineStart);
          if (tail.length > 0) {
            pendingParts.push(tail);
            pendingBytes += tail.length;
          }
          break;
        }

        const lineTail = content.subarray(lineStart, newline);
        const line = pendingBytes > 0
          ? Buffer.concat([...pendingParts, lineTail], pendingBytes + lineTail.length)
          : lineTail;
        pendingParts = [];
        pendingBytes = 0;
        const normalized = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
        if (normalized.toString("utf8").trim()) {
          try {
            options.onRecord(JSON.parse(normalized.toString("utf8")) as unknown);
          } catch {
            malformedLines += 1;
          }
        }
        committedOffset = position + newline + 1;
        lineStart = newline + 1;
      }

      position += bytesRead;
    }
    if (pendingBytes > 0) {
      const line = Buffer.concat(pendingParts, pendingBytes).toString("utf8").trim();
      if (line) {
        try {
          options.onRecord(JSON.parse(line) as unknown);
          committedOffset = fileSize;
        } catch {
          // Leave an incomplete final JSON value behind the committed cursor.
        }
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }

  return { startOffset, committedOffset, fileSize, malformedLines };
}
