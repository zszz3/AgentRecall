// A fixed Finder layout, authored without Finder automation or user metadata.
// Buddy allocation and leaf records were checked against our synthetic Finder
// folder; this deliberately implements only the six records shipped in the DMG.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BACKGROUND = ".background/background.png";
const WINDOW_BOUNDS = "{{180, 140}, {720, 440}}";
const ICON_POSITIONS = { "AgentRecall.app": [180, 212], Applications: [540, 212] };
const ALLOCATOR_OFFSET = 4096;
const SUPERBLOCK_OFFSET = 32;
const LEAF_OFFSET = 8192;
const LEAF_SIZE = 4096;

function plutil(args, input) {
  return execFileSync("/usr/bin/plutil", [...args, "-o", "-", "-"], { input, timeout: 10_000 });
}

function plist(values) {
  const xmlEscape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const entries = Object.entries(values).map(([key, value]) => {
    let encoded;
    if (Buffer.isBuffer(value)) encoded = `<data>${value.toString("base64")}</data>`;
    else if (typeof value === "boolean") encoded = value ? "<true/>" : "<false/>";
    else if (typeof value === "number") encoded = ["viewOptionsVersion", "backgroundType"].includes(key)
      ? `<integer>${value}</integer>` : `<real>${value}</real>`;
    else encoded = `<string>${xmlEscape(value)}</string>`;
    return `<key>${xmlEscape(key)}</key>${encoded}`;
  }).join("");
  return plutil(["-convert", "binary1"], `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${entries}</dict></plist>`);
}

function decodePlist(bytes, dataKey) {
  let data;
  if (dataKey) {
    data = Buffer.from(plutil(["-extract", dataKey, "raw", "-expect", "data"], bytes).toString().trim(), "base64");
    bytes = plutil(["-remove", dataKey], bytes);
  }
  const decoded = JSON.parse(plutil(["-convert", "json"], bytes));
  if (dataKey) decoded[dataKey] = data;
  return decoded;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function record(name, code, type, value) {
  const filename = Buffer.from(name, "utf16le").swap16();
  const payload = type === "blob" ? Buffer.concat([u32(value.length), value]) : value;
  return Buffer.concat([u32(name.length), filename, Buffer.from(code + type, "ascii"), payload]);
}

function iconLocation([x, y]) {
  return Buffer.concat([u32(x), u32(y), Buffer.from("ffffffffffff0000", "hex")]);
}

function buildStore(backgroundImageAlias) {
  const window = plist({ ShowStatusBar: false, ShowToolbar: false, ShowTabView: false,
    ContainerShowSidebar: false, ShowSidebar: false, WindowBounds: WINDOW_BOUNDS });
  const icons = plist({ viewOptionsVersion: 1, backgroundType: 2, backgroundImageAlias,
    backgroundColorRed: 1, backgroundColorGreen: 1, backgroundColorBlue: 1,
    gridOffsetX: 0, gridOffsetY: 0, gridSpacing: 100, arrangeBy: "none",
    showIconPreview: true, showItemInfo: false, labelOnBottom: true,
    scrollPositionX: 0, scrollPositionY: 0, iconSize: 96, textSize: 13 });
  const records = [record(".", "bwsp", "blob", window), record(".", "icvp", "blob", icons),
    record(".", "vSrn", "long", u32(1)), record(".", "vstl", "type", Buffer.from("icnv")),
    ...Object.entries(ICON_POSITIONS).map(([name, position]) => record(name, "Iloc", "blob", iconLocation(position)))];
  const leaf = Buffer.concat([u32(0), u32(records.length), ...records]);
  assert.ok(leaf.length <= LEAF_SIZE, "Fixed Finder layout exceeds its single B-tree leaf.");
  const bytes = Buffer.alloc(LEAF_OFFSET + LEAF_SIZE + 4);
  Buffer.concat([u32(1), Buffer.from("Bud1"), u32(ALLOCATOR_OFFSET), u32(2048), u32(ALLOCATOR_OFFSET)]).copy(bytes);
  // Buddy block addresses encode log2(size) in their five low bits. All
  // allocator-relative offsets start after the initial four-byte file marker.
  let cursor = ALLOCATOR_OFFSET + 4;
  u32(3).copy(bytes, cursor); cursor += 8;
  for (const address of [ALLOCATOR_OFFSET + 11, SUPERBLOCK_OFFSET + 5, LEAF_OFFSET + 12]) {
    u32(address).copy(bytes, cursor); cursor += 4;
  }
  cursor = ALLOCATOR_OFFSET + 4 + 8 + 256 * 4;
  Buffer.concat([u32(1), Buffer.from([4]), Buffer.from("DSDB"), u32(1)]).copy(bytes, cursor); cursor += 13;
  // Free blocks complete the Buddy address space without marking live blocks
  // as available if Finder later opens a writable copy of this layout.
  for (let exponent = 0; exponent < 32; exponent++) {
    const free = exponent >= 6 && exponent <= 10 ? [2 ** exponent]
      : exponent === 11 ? [2048, 6144]
        : exponent === 12 ? [12288]
          : exponent >= 14 ? [2 ** exponent] : [];
    u32(free.length).copy(bytes, cursor); cursor += 4;
    for (const offset of free) { u32(offset).copy(bytes, cursor); cursor += 4; }
  }
  Buffer.concat([u32(2), u32(0), u32(records.length), u32(1), u32(LEAF_SIZE)]).copy(bytes, SUPERBLOCK_OFFSET + 4);
  leaf.copy(bytes, LEAF_OFFSET + 4);
  return bytes;
}

// The reader rejects arbitrary trees: verification concerns the fixed layout
// above, not a general-purpose .DS_Store editor or a developer's Finder files.
function readStore(bytes) {
  assert.equal(bytes.length, LEAF_OFFSET + LEAF_SIZE + 4, "Unexpected Finder layout size.");
  assert.equal(bytes.readUInt32BE(0), 1);
  assert.equal(bytes.toString("ascii", 4, 8), "Bud1");
  assert.equal(bytes.readUInt32BE(8), ALLOCATOR_OFFSET);
  assert.equal(bytes.readUInt32BE(12), 2048);
  assert.equal(bytes.readUInt32BE(16), ALLOCATOR_OFFSET);
  const allocation = ALLOCATOR_OFFSET + 4;
  assert.equal(bytes.readUInt32BE(allocation), 3);
  assert.deepEqual([8, 12, 16].map(offset => bytes.readUInt32BE(allocation + offset)),
    [ALLOCATOR_OFFSET + 11, SUPERBLOCK_OFFSET + 5, LEAF_OFFSET + 12]);
  const table = allocation + 8 + 256 * 4;
  assert.equal(bytes.readUInt32BE(table), 1);
  assert.equal(bytes[table + 4], 4);
  assert.equal(bytes.toString("ascii", table + 5, table + 9), "DSDB");
  assert.equal(bytes.readUInt32BE(table + 9), 1);
  assert.deepEqual([0, 4, 8, 12, 16].map(offset => bytes.readUInt32BE(SUPERBLOCK_OFFSET + 4 + offset)), [2, 0, 6, 1, LEAF_SIZE]);
  let cursor = LEAF_OFFSET + 4;
  assert.equal(bytes.readUInt32BE(cursor), 0); cursor += 4;
  assert.equal(bytes.readUInt32BE(cursor), 6); cursor += 4;
  const records = new Map();
  for (let index = 0; index < 6; index++) {
    const length = bytes.readUInt32BE(cursor); cursor += 4;
    assert.ok(length <= 64 && cursor + length * 2 + 8 <= bytes.length, "Invalid Finder record name.");
    const name = Buffer.from(bytes.subarray(cursor, cursor + length * 2)).swap16().toString("utf16le"); cursor += length * 2;
    const code = bytes.toString("ascii", cursor, cursor + 4); cursor += 4;
    const type = bytes.toString("ascii", cursor, cursor + 4); cursor += 4;
    assert.ok(["blob", "long", "type"].includes(type), "Unexpected Finder record type.");
    let size = 4;
    if (type === "blob") { size = bytes.readUInt32BE(cursor); cursor += 4; }
    assert.ok(cursor + size <= bytes.length, "Invalid Finder record length.");
    const key = `${name}:${code}`;
    assert.ok(!records.has(key), "Duplicate Finder record.");
    records.set(key, { type, value: bytes.subarray(cursor, cursor + size) }); cursor += size;
  }
  return records;
}

async function requireBackground(root) {
  const background = path.join(root, BACKGROUND);
  const stat = await fs.lstat(background);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "DMG background must be a regular staged PNG.");
  assert.equal(await fs.realpath(background), path.join(await fs.realpath(root), BACKGROUND), "DMG background escapes staging.");
}

export async function writeMacosFinderLayout(stageRoot, { backgroundImageAlias, replaceExisting = false } = {}) {
  assert.ok(Buffer.isBuffer(backgroundImageAlias) && backgroundImageAlias.length > 0, "A volume-relative Finder background alias is required.");
  await requireBackground(stageRoot);
  const file = path.join(stageRoot, ".DS_Store");
  const bytes = buildStore(backgroundImageAlias);
  if (!replaceExisting) await fs.writeFile(file, bytes, { flag: "wx" });
  else {
    const entry = await fs.lstat(file);
    assert.ok(entry.isFile() && !entry.isSymbolicLink(), "Existing Finder layout must be a regular file.");
    // Preserve the image's catalog node ID while replacing placeholder alias
    // metadata with the actual mounted-volume identity. Never follow a link.
    const handle = await fs.open(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      assert.ok(stat.isFile() && stat.size === bytes.length, "Existing Finder layout has an unexpected size.");
      readStore(await handle.readFile());
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
        assert.ok(bytesWritten > 0, "Finder layout write made no progress.");
        offset += bytesWritten;
      }
      await handle.sync();
    } finally { await handle.close(); }
  }
  return verifyMacosFinderLayout(stageRoot);
}

export async function verifyMacosFinderLayout(root) {
  await requireBackground(root);
  const records = readStore(await fs.readFile(path.join(root, ".DS_Store")));
  const take = (key, type) => {
    const entry = records.get(key);
    assert.ok(entry, `Missing Finder layout record: ${key}`);
    assert.equal(entry.type, type);
    return entry.value;
  };
  const window = decodePlist(take(".:bwsp", "blob"));
  assert.equal(window.WindowBounds, WINDOW_BOUNDS);
  for (const name of ["ShowStatusBar", "ShowToolbar", "ShowTabView", "ContainerShowSidebar", "ShowSidebar"]) assert.equal(window[name], false);
  const iconPlist = take(".:icvp", "blob");
  // Preserve native plist enum/version types; JSON decoding alone erases the
  // integer-versus-real distinction and cannot protect this Finder contract.
  for (const [key, value] of [["backgroundType", "2"], ["viewOptionsVersion", "1"]]) {
    assert.equal(plutil(["-extract", key, "raw", "-expect", "integer"], iconPlist).toString().trim(), value);
  }
  const icons = decodePlist(iconPlist, "backgroundImageAlias");
  assert.equal(icons.backgroundType, 2);
  assert.equal(icons.iconSize, 96);
  assert.equal(icons.textSize, 13);
  assert.equal(icons.arrangeBy, "none");
  assert.equal(icons.labelOnBottom, true);
  assert.equal(icons.scrollPositionX, 0);
  assert.equal(icons.scrollPositionY, 0);
  assert.ok(icons.backgroundImageAlias.length > 0);
  assert.equal(take(".:vstl", "type").toString("ascii"), "icnv");
  assert.equal(take(".:vSrn", "long").readUInt32BE(), 1);
  for (const [name, position] of Object.entries(ICON_POSITIONS)) assert.deepEqual(take(`${name}:Iloc`, "blob"), iconLocation(position));
  return { windowBounds: WINDOW_BOUNDS, canvas: [720, 440], iconSize: 96, textSize: 13,
    iconPositions: ICON_POSITIONS, background: BACKGROUND, backgroundImageAlias: icons.backgroundImageAlias };
}
