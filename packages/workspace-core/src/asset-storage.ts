import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { WorkspaceError, hasErrorCode } from "./errors.js";

export async function readBoundedJson(file: string, maximum: number): Promise<unknown> {
  const handle = await fs.open(file, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new WorkspaceError("INVALID_ASSET", "资产路径不是文件。");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new WorkspaceError("ASSETS_TOO_LARGE", "资产文件超过允许的完整大小。");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { throw new WorkspaceError("INVALID_ASSET", "资产文件不是有效的 UTF-8 JSON，请重新同步或恢复备份。"); }
  } finally { await handle.close(); }
}

export async function withAssetLock<T>(directory: string, name: string, operation: (assertOwned: () => void) => Promise<T>): Promise<T> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const realDirectory = await fs.realpath(directory);
  let compromised = false;
  let release;
  try {
    release = await lockfile.lock(realDirectory, {
      lockfilePath: path.join(realDirectory, name),
      retries: { retries: 25, factor: 1, minTimeout: 40, maxTimeout: 40 },
      onCompromised: () => { compromised = true; },
    });
  } catch (error) {
    if (hasErrorCode(error, "ELOCKED")) throw new WorkspaceError("ASSETS_BUSY", "另一个命令正在修改相关配置或资产，请稍后重试。");
    throw error;
  }
  const assertOwned = () => {
    if (compromised) throw new WorkspaceError("ASSETS_BUSY", "资产锁已失效，本次操作取消，请重试。");
  };
  try { return await operation(assertOwned); }
  finally { if (!compromised) await release(); }
}
