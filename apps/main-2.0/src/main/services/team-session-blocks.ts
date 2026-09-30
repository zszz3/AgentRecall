import { createHash, randomUUID } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { WorkspaceError } from "@agentrecall/workspace-core";

const compress = promisify(gzip), decompress = promisify(gunzip);
export const SESSION_BLOCK_BYTES = 4 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.object({ hash, bytes: z.number().int().min(0).max(SESSION_BLOCK_BYTES), storedBytes: z.number().int().positive().max(SESSION_BLOCK_BYTES + 65536) }).strict();
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const descriptor = z.object({ encoding: z.enum(["json", "base64"]), blocks: z.array(reference).min(1).max(32), bytes: z.number().int().nonnegative().max(MAX_TOTAL_BYTES) }).strict();
const location = z.array(z.union([z.string().max(1024), z.number().int().nonnegative()])).max(128);
export const sessionBlockManifestSchema = z.object({
  schemaVersion: z.literal(4), shareId: z.string().uuid(), repository: z.string().max(2048),
  source: z.object({ agent: z.string().max(100), sessionKey: z.string().max(4096) }).strict(),
  body: z.array(reference).min(1).max(32),
  strings: z.array(z.object({ path: location, prefix: z.string().max(1024), value: descriptor }).strict()).max(100000),
  originalBytes: z.number().int().positive().max(MAX_TOTAL_BYTES),
}).strict();
export type SessionBlockManifest = z.infer<typeof sessionBlockManifestSchema>;
export interface SessionBlockBundle { manifest: SessionBlockManifest; blocks: Map<string, Buffer>; }
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function check(signal: AbortSignal) { if (signal.aborted) throw new WorkspaceError("CANCELLED", "会话打包已取消。"); }

/** Lossless JSON-value encoding. References live outside user objects, so user
 * fields cannot masquerade as protocol references. Original files are untouched. */
export async function encodeSessionBlocks(value: unknown, source: SessionBlockManifest["source"], repository: string, signal: AbortSignal): Promise<SessionBlockBundle> {
  const blocks = new Map<string, Buffer>(), rawBlocks = new Map<string, z.infer<typeof reference>>(), strings: SessionBlockManifest["strings"] = [];
  const store = async (bytes: Buffer) => {
    const refs: z.infer<typeof reference>[] = [];
    for (let offset = 0; offset < Math.max(1, bytes.length); offset += SESSION_BLOCK_BYTES) {
      check(signal);
      const raw = bytes.subarray(offset, offset + SESSION_BLOCK_BYTES);
      const rawHash = digest(raw), prior = rawBlocks.get(rawHash);
      if (prior) { refs.push(prior); continue; }
      const packed = await compress(raw), id = digest(packed);
      const ref = { hash: id, bytes: raw.length, storedBytes: packed.length };
      blocks.set(id, packed); rawBlocks.set(rawHash, ref); refs.push(ref);
    }
    return refs;
  };
  const visit = async (node: unknown, path: Array<string | number>): Promise<unknown> => {
    check(signal);
    if (path.length > 128) throw new WorkspaceError("TEAM_SESSION_INVALID", "会话结构嵌套过深。");
    if (typeof node === "string" && Buffer.byteLength(node) >= 16384) {
      let prefix = "", encoding: "json" | "base64" = "json", data = Buffer.from(JSON.stringify(node));
      const image = /^data:image\/[a-zA-Z0-9.+-]+;base64,/.exec(node);
      // Canonical base64 also covers packet attachments and original source files.
      // Round-trip equality preserves strings that merely resemble base64.
      const body = image ? node.slice(image[0].length) : node;
      if (image || /^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
        const binary = Buffer.from(body, "base64");
        if (binary.toString("base64") === body) { data = binary; encoding = "base64"; prefix = image?.[0] ?? ""; }
      }
      strings.push({ path, prefix, value: { encoding, blocks: await store(data), bytes: data.length } });
      return null;
    }
    if (Array.isArray(node)) { const out: unknown[] = []; for (let i = 0; i < node.length; i++) out.push(await visit(node[i], [...path, i])); return out; }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, child] of Object.entries(node)) out[key] = await visit(child, [...path, key]);
      return out;
    }
    return node;
  };
  const serialized = JSON.stringify(value), originalBytes = Buffer.byteLength(serialized);
  if (originalBytes > MAX_TOTAL_BYTES) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "会话快照超过当前打包上限，请减少所选轮次。");
  const body = await store(Buffer.from(JSON.stringify(await visit(value, []))));
  const manifest = sessionBlockManifestSchema.parse({ schemaVersion: 4, shareId: randomUUID(), repository, source, body, strings, originalBytes });
  if (Buffer.byteLength(JSON.stringify(manifest)) > 4 * 1024 * 1024) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "会话清单过大，请减少所选轮次。");
  return { manifest, blocks };
}
export async function decodeSessionBlocks(input: unknown, read: (hash: string) => Promise<Buffer>, signal: AbortSignal, omit?: (entry: SessionBlockManifest["strings"][number]) => boolean): Promise<unknown> {
  const manifest = sessionBlockManifestSchema.parse(input);
  const skipped = new Set(manifest.strings.filter(entry => omit?.(entry)));
  const references = [...manifest.body, ...manifest.strings.flatMap(entry => entry.value.blocks)];
  for (const entry of manifest.strings) if (entry.value.blocks.reduce((sum, ref) => sum + ref.bytes, 0) !== entry.value.bytes) throw new WorkspaceError("TEAM_SESSION_INVALID", "会话内容长度无效。");
  const unique = new Map<string, z.infer<typeof reference>>();
  let total = 0;
  for (const ref of references) {
    total += ref.bytes;
    if (total > MAX_TOTAL_BYTES * 2) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "会话解压内容超过限制。");
    const prior = unique.get(ref.hash);
    if (prior && (prior.bytes !== ref.bytes || prior.storedBytes !== ref.storedBytes)) throw new WorkspaceError("TEAM_SESSION_INVALID", "会话分块长度不一致。");
    unique.set(ref.hash, ref);
  }
  // Bound concurrency, fetch and inflate each required block once, and await
  // every in-flight read even when one fails. File payloads can be deferred by
  // the read-only projection; full downloads still validate every block.
  const needed = new Set([...manifest.body, ...manifest.strings.filter(entry => !skipped.has(entry)).flatMap(entry => entry.value.blocks)].map(ref => ref.hash));
  const cache = new Map<string, Buffer>(), refs = [...unique.values()].filter(ref => needed.has(ref.hash));
  for (let offset = 0; offset < refs.length; offset += 4) {
    check(signal);
    const results = await Promise.allSettled(refs.slice(offset, offset + 4).map(async ref => {
      const data = await read(ref.hash); check(signal);
      if (data.length !== ref.storedBytes || digest(data) !== ref.hash) throw new WorkspaceError("TEAM_SESSION_INVALID", "会话分块校验失败。");
      const raw = await decompress(data, { maxOutputLength: SESSION_BLOCK_BYTES });
      if (raw.length !== ref.bytes) throw new WorkspaceError("TEAM_SESSION_INVALID", "会话分块长度无效。");
      cache.set(ref.hash, raw);
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  const load = (entries: z.infer<typeof reference>[]) => { check(signal); return Buffer.concat(entries.map(entry => cache.get(entry.hash)!)); };
  let result: unknown = JSON.parse((await load(manifest.body)).toString("utf8"));
  const seen = new Set<string>();
  for (const entry of manifest.strings) {
    const key = JSON.stringify(entry.path);
    if (seen.has(key)) throw new WorkspaceError("TEAM_SESSION_INVALID", "重复的内容引用。"); seen.add(key);
    let parent = result;
    for (const part of entry.path.slice(0, -1)) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, part)) throw new WorkspaceError("TEAM_SESSION_INVALID", "内容引用不存在。");
      parent = (parent as Record<string | number, unknown>)[part];
    }
    const last = entry.path.at(-1)!;
    if (entry.path.length ? !parent || typeof parent !== "object" || !Object.hasOwn(parent, last) || (parent as Record<string | number, unknown>)[last] !== null : result !== null) throw new WorkspaceError("TEAM_SESSION_INVALID", "内容引用无效。");
    if (skipped.has(entry)) continue;
    const bytes = load(entry.value.blocks);
    const text = entry.value.encoding === "base64" ? entry.prefix + bytes.toString("base64") : JSON.parse(bytes.toString("utf8"));
    if (typeof text !== "string") throw new WorkspaceError("TEAM_SESSION_INVALID", "字符串分块格式无效。");
    if (!entry.path.length) { result = text; continue; }
    Object.defineProperty(parent, last, { value: text, writable: true, configurable: true, enumerable: true });
  }
  const restoredBytes = Buffer.byteLength(JSON.stringify(result));
  if (restoredBytes > MAX_TOTAL_BYTES || skipped.size === 0 && restoredBytes !== manifest.originalBytes) throw new WorkspaceError("TEAM_SESSION_INVALID", "会话还原长度无效。");
  return result;
}
