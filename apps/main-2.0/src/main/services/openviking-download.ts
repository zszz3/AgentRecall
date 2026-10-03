import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export type DownloadProgressListener = (
  downloadedBytes: number,
  totalBytes?: number,
  bytesPerSecond?: number,
) => void;

interface DownloadOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  maxAttempts?: number;
  idleTimeoutMs?: number;
  retryDelayMs?: number;
}

/**
 * Downloads `url` into `destination`, resuming an interrupted attempt through an HTTP
 * range request when a partial file is already on disk. Callers keep the partial file
 * after a failure so a retry does not restart a multi-hundred-megabyte transfer, and
 * delete it when the checksum of the completed file does not match.
 */
export async function downloadFileWithResume(
  url: string,
  destination: string,
  onProgress?: DownloadProgressListener,
  options: DownloadOptions = {},
): Promise<void> {
  const source = new URL(url);
  if (source.protocol === "file:") {
    const sourcePath = fileURLToPath(source);
    const totalBytes = (await stat(sourcePath)).size;
    await pipeline(
      createReadStream(sourcePath),
      createDownloadProgressTransform(totalBytes, onProgress),
      createWriteStream(destination, { mode: 0o600 }),
    );
    return;
  }
  const fetchImpl = options.fetchImpl ?? (async (input, init) => {
    const { net } = await import("electron");
    return net.fetch(input, init);
  });
  const maxAttempts = options.maxAttempts ?? 3;
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const resumeFrom = await partialSize(destination);
    const controller = new AbortController();
    let stalled = false;
    let retryable = true;
    let failedStatus: number | undefined;
    const abortStalled = () => {
      stalled = true;
      controller.abort(new Error("OpenViking download stalled. Check your network or proxy and retry."));
    };
    const idleTimer = setTimeout(abortStalled, idleTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        signal: controller.signal,
        ...(resumeFrom > 0 ? { headers: { Range: `bytes=${resumeFrom}-` } } : {}),
      });
      if (resumeFrom > 0 && response.status === 416) {
        await response.body?.cancel();
        onProgress?.(resumeFrom, resumeFrom);
        return;
      }
      if (!response.ok || !response.body) {
        failedStatus = response.status;
        retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        await response.body?.cancel();
        throw new Error(`OpenViking download failed with HTTP ${response.status}.`);
      }
      const resumed = resumeFrom > 0 && response.status === 206;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(response.headers.get("content-range") ?? "");
        if (!range || Number(range[1]) !== resumeFrom) {
          retryable = false;
          await response.body.cancel();
          throw new Error("OpenViking download returned an invalid resume range.");
        }
      }
      const remainingBytes = Number(response.headers.get("content-length"));
      const totalBytes = Number.isSafeInteger(remainingBytes) && remainingBytes > 0
        ? (resumed ? resumeFrom : 0) + remainingBytes
        : undefined;
      // Abort only a transfer with no new bytes, not a healthy large download.
      idleTimer.refresh();
      await pipeline(
        Readable.fromWeb(response.body as never),
        createDownloadProgressTransform(totalBytes, (downloaded, total, speed) => {
          idleTimer.refresh();
          onProgress?.(downloaded, total, speed);
        }, resumed ? resumeFrom : 0),
        createWriteStream(destination, { mode: 0o600, flags: resumed ? "a" : "w" }),
        { signal: controller.signal },
      );
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!retryable || ["EACCES", "EPERM", "ENOSPC", "EROFS", "EISDIR", "ENOTDIR", "ENOENT", "EMFILE", "ENFILE"].includes(code ?? "")) throw error;
      if (attempt === maxAttempts) {
        if (stalled) throw controller.signal.reason;
        throw new Error(`OpenViking download failed after ${maxAttempts} attempts${failedStatus ? ` (HTTP ${failedStatus})` : ""}. Check your network or proxy and retry.`, { cause: error });
      }
    } finally {
      clearTimeout(idleTimer);
      controller.abort();
    }
    await delay((options.retryDelayMs ?? 1_000) * attempt);
  }
}

async function partialSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function createDownloadProgressTransform(
  totalBytes: number | undefined,
  onProgress?: DownloadProgressListener,
  alreadyOnDisk = 0,
): Transform {
  let downloadedBytes = alreadyOnDisk;
  const startedAt = Date.now();
  onProgress?.(downloadedBytes, totalBytes);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.byteLength;
      const elapsedMs = Date.now() - startedAt;
      // Speed covers only this attempt's transfer, so resumed bytes stay out of it.
      const bytesPerSecond = elapsedMs >= 250
        ? Math.round((downloadedBytes - alreadyOnDisk) / (elapsedMs / 1_000))
        : undefined;
      onProgress?.(downloadedBytes, totalBytes, bytesPerSecond);
      callback(null, chunk);
    },
  });
}
