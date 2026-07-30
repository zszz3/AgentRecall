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
    shouldSkipLinePrefix?(prefix: Buffer): boolean;
    shouldParseLine?(line: Buffer): boolean;
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
  let skippingLine = false;

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
          if (!skippingLine && tail.length > 0) {
            const prefix = pendingBytes > 0
              ? Buffer.concat([...pendingParts, tail], pendingBytes + tail.length)
              : tail;
            if (options.shouldSkipLinePrefix?.(prefix)) {
              pendingParts = [];
              pendingBytes = 0;
              skippingLine = true;
              break;
            }
            pendingParts.push(tail);
            pendingBytes += tail.length;
          }
          break;
        }

        if (skippingLine) {
          skippingLine = false;
          committedOffset = position + newline + 1;
          lineStart = newline + 1;
          continue;
        }
        const lineTail = content.subarray(lineStart, newline);
        const line = pendingBytes > 0
          ? Buffer.concat([...pendingParts, lineTail], pendingBytes + lineTail.length)
          : lineTail;
        pendingParts = [];
        pendingBytes = 0;
        const normalized = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
        if (options.shouldParseLine?.(normalized) === false) {
          committedOffset = position + newline + 1;
          lineStart = newline + 1;
          continue;
        }
        const text = normalized.toString("utf8");
        if (text.trim()) {
          try {
            options.onRecord(JSON.parse(text) as unknown);
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
      const pending = Buffer.concat(pendingParts, pendingBytes);
      if (options.shouldParseLine?.(pending) === false) {
        committedOffset = fileSize;
      } else {
        const line = pending.toString("utf8").trim();
        if (line) {
          try {
            options.onRecord(JSON.parse(line) as unknown);
            committedOffset = fileSize;
          } catch {
            // Leave an incomplete final JSON value behind the committed cursor.
          }
        }
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }

  return { startOffset, committedOffset, fileSize, malformedLines };
}

export async function scanCompleteJsonlAsync(
  filePath: string,
  options: {
    startOffset?: number;
    chunkSize?: number;
    shouldSkipLinePrefix?(prefix: Buffer): boolean;
    shouldParseLine?(line: Buffer): boolean;
    onRecord(record: unknown): void;
  },
): Promise<JsonlScanResult> {
  const startOffset = options.startOffset ?? 0;
  const chunkSize = Math.max(1, options.chunkSize ?? 8 * 1024 * 1024);
  const fileSize = (await fs.promises.stat(filePath)).size;
  if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > fileSize) {
    throw new RangeError(`Invalid JSONL start offset ${startOffset} for ${fileSize}-byte file.`);
  }

  const handle = await fs.promises.open(filePath, "r");
  let position = startOffset;
  let committedOffset = startOffset;
  let malformedLines = 0;
  let pendingParts: Buffer[] = [];
  let pendingBytes = 0;
  let skippingLine = false;
  let sliceStartedAt = Date.now();

  const yieldIfNeeded = async (): Promise<void> => {
    if (Date.now() - sliceStartedAt < 8) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    sliceStartedAt = Date.now();
  };

  const parseLine = (line: Buffer, nextOffset: number): void => {
    const normalized = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    if (options.shouldParseLine?.(normalized) === false) {
      committedOffset = nextOffset;
      return;
    }
    const text = normalized.toString("utf8");
    if (text.trim()) {
      try {
        options.onRecord(JSON.parse(text) as unknown);
      } catch {
        malformedLines += 1;
      }
    }
    committedOffset = nextOffset;
  };

  try {
    while (position < fileSize) {
      const chunk = Buffer.allocUnsafe(Math.min(chunkSize, fileSize - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead <= 0) throw new Error(`Unexpected end of JSONL file at byte ${position}.`);
      const content = chunk.subarray(0, bytesRead);
      let lineStart = 0;

      while (lineStart < content.length) {
        const newline = content.indexOf(0x0a, lineStart);
        if (newline < 0) {
          const tail = content.subarray(lineStart);
          if (!skippingLine && tail.length > 0) {
            const prefix = pendingBytes > 0
              ? Buffer.concat([...pendingParts, tail], pendingBytes + tail.length)
              : tail;
            if (options.shouldSkipLinePrefix?.(prefix)) {
              pendingParts = [];
              pendingBytes = 0;
              skippingLine = true;
              break;
            }
            pendingParts.push(tail);
            pendingBytes += tail.length;
          }
          break;
        }
        if (skippingLine) {
          skippingLine = false;
          committedOffset = position + newline + 1;
          lineStart = newline + 1;
          continue;
        }
        const lineTail = content.subarray(lineStart, newline);
        const line = pendingBytes > 0
          ? Buffer.concat([...pendingParts, lineTail], pendingBytes + lineTail.length)
          : lineTail;
        pendingParts = [];
        pendingBytes = 0;
        parseLine(line, position + newline + 1);
        await yieldIfNeeded();
        lineStart = newline + 1;
      }
      position += bytesRead;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    if (pendingBytes > 0) {
      const pending = Buffer.concat(pendingParts, pendingBytes);
      if (options.shouldParseLine?.(pending) === false) {
        committedOffset = fileSize;
      } else {
        const line = pending.toString("utf8").trim();
        if (line) {
          try {
            options.onRecord(JSON.parse(line) as unknown);
            committedOffset = fileSize;
          } catch {
            // Leave an incomplete final JSON value behind the committed cursor.
          }
        }
      }
    }
  } finally {
    await handle.close();
  }

  return { startOffset, committedOffset, fileSize, malformedLines };
}
