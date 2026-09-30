import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { encodeSessionBlocks, decodeSessionBlocks, SESSION_BLOCK_BYTES } from "./team-session-blocks";
const source = { agent: "codex-cli", sessionKey: "fixture" }, repository = "https://github.com/example/team";
it("round trips images and duplicate output without conflating separate shares", async () => {
  const image = `data:image/jpeg;base64,${randomBytes(50000).toString("base64")}`, output = "多字节".repeat(10000);
  const value = JSON.parse(JSON.stringify({ items: [image, image], stdout: output, aggregated_output: output, literal: { $arBlob: "user field" }, nested: { ["__proto__"]: output } }));
  const signal = new AbortController().signal;
  const first = await encodeSessionBlocks(value, source, repository, signal), second = await encodeSessionBlocks(value, source, repository, signal);
  expect(first.manifest.shareId).not.toBe(second.manifest.shareId);
  expect([...first.blocks.keys()]).toEqual([...second.blocks.keys()]);
  expect(first.manifest.strings[0]!.value.blocks).toEqual(first.manifest.strings[1]!.value.blocks);
  expect(first.blocks.size).toBe(3);
  expect(await decodeSessionBlocks(first.manifest, async hash => first.blocks.get(hash)!, signal)).toEqual(value);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});
it("splits oversized values across bounded blocks and rejects corruption or missing data", async () => {
  const signal = new AbortController().signal, value = { output: "汉".repeat(Math.ceil(SESSION_BLOCK_BYTES / 3) + 50) };
  const bundle = await encodeSessionBlocks(value, source, repository, signal);
  expect(bundle.manifest.strings[0]!.value.blocks).toHaveLength(2);
  expect(await decodeSessionBlocks(bundle.manifest, async hash => bundle.blocks.get(hash)!, signal)).toEqual(value);
  await expect(decodeSessionBlocks(bundle.manifest, async () => Buffer.from("corrupt"), signal)).rejects.toMatchObject({ code: "TEAM_SESSION_INVALID" });
  await expect(decodeSessionBlocks(bundle.manifest, async () => { throw new Error("missing"); }, signal)).rejects.toThrow("missing");
});
it("round trips empty JSON values and stops on cancellation", async () => {
  for (const value of [null, [], {}, ""]) {
    const signal = new AbortController().signal, bundle = await encodeSessionBlocks(value, source, repository, signal);
    expect(await decodeSessionBlocks(bundle.manifest, async hash => bundle.blocks.get(hash)!, signal)).toEqual(value);
  }
  const abort = new AbortController(); abort.abort();
  await expect(encodeSessionBlocks({ text: "x".repeat(20000) }, source, repository, abort.signal)).rejects.toMatchObject({ code: "CANCELLED" });
});

it("shares binary attachment blocks with inline images and preserves unusual JSON strings", async () => {
  const binary = randomBytes(40000).toString("base64"), signal = new AbortController().signal;
  const value = { image: `data:image/png;base64,${binary}`, file: { data: binary }, text: "\ud800".repeat(18000), similar: `data:image/png;base64,${binary}\n` };
  const bundle = await encodeSessionBlocks(value, source, repository, signal);
  expect(bundle.manifest.strings[0]!.value.blocks).toEqual(bundle.manifest.strings[1]!.value.blocks);
  expect(await decodeSessionBlocks(bundle.manifest, async hash => bundle.blocks.get(hash)!, signal)).toEqual(value);
});

it("counts wrappers and all restored references when enforcing the complete JSON limit", async () => {
  const signal = new AbortController().signal, limit = 64 * 1024 * 1024;
  const value = { text: "!".repeat(limit - Buffer.byteLength(JSON.stringify({ text: "" }))) };
  const bundle = await encodeSessionBlocks(value, source, repository, signal);
  expect(await decodeSessionBlocks(bundle.manifest, async hash => bundle.blocks.get(hash)!, signal)).toEqual(value);
  await expect(encodeSessionBlocks({ ...value, extra: true }, source, repository, signal)).rejects.toMatchObject({ code: "TEAM_SESSION_TOO_LARGE" });
  await expect(decodeSessionBlocks({ ...bundle.manifest, originalBytes: limit - 1 }, async hash => bundle.blocks.get(hash)!, signal)).rejects.toMatchObject({ code: "TEAM_SESSION_INVALID" });
});

it("fetches each repeated block once with at most four concurrent reads", async () => {
  const texts = Array.from({length: 6}, () => randomBytes(20000).toString("hex"));
  const value = {items:[...texts,...texts]}, signal = new AbortController().signal;
  const bundle = await encodeSessionBlocks(value, source, repository, signal);
  let active = 0, peak = 0;
  const reads: string[] = [];
  const restored = await decodeSessionBlocks(bundle.manifest, async hash => {
    reads.push(hash); peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return bundle.blocks.get(hash)!;
  }, signal);
  expect(restored).toEqual(value);
  expect(reads).toHaveLength(bundle.blocks.size);
  expect(new Set(reads).size).toBe(reads.length);
  expect(peak).toBe(4); expect(active).toBe(0);
});

it("validates deferred reference paths and lengths without reading their payloads", async () => {
  const signal = new AbortController().signal;
  const bundle = await encodeSessionBlocks({file:randomBytes(20000).toString("base64")}, source, repository, signal);
  const entry = bundle.manifest.strings[0]!;
  const read = async (hash: string) => bundle.blocks.get(hash)!;
  await expect(decodeSessionBlocks({...bundle.manifest, strings:[{...entry,path:["missing"]}]}, read, signal, () => true)).rejects.toMatchObject({code:"TEAM_SESSION_INVALID"});
  await expect(decodeSessionBlocks({...bundle.manifest, strings:[{...entry,value:{...entry.value,bytes:entry.value.bytes+1}}]}, read, signal, () => true)).rejects.toMatchObject({code:"TEAM_SESSION_INVALID"});
});
