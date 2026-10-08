// Finder's icvp background uses a classic Alias v2 record. Keep the reference
// volume-relative: IDs and dates describe the owned HFS+ image, never the host.
import assert from "node:assert/strict";

export function createDmgBackgroundAlias({ volumeCreatedAtMs, parentId = 0xffffffff, targetId = 0xffffffff } = {}) {
  const volume = "AgentRecall";
  const filename = "background.png";
  const header = Buffer.alloc(150);
  header.writeUInt16BE(2, 6); // Alias record version.
  header.writeUInt8(volume.length, 10);
  header.write(volume, 11, "ascii");
  if (volumeCreatedAtMs !== undefined) {
    assert.ok(Number.isFinite(volumeCreatedAtMs), "Invalid image volume creation time.");
    // Classic Alias dates are local-time seconds since 1904, unlike fs.stat's
    // Unix UTC milliseconds. This matches FSNewAlias on the mounted HFS+ image.
    const date = new Date(volumeCreatedAtMs);
    header.writeUInt32BE(Math.floor(volumeCreatedAtMs / 1000) - date.getTimezoneOffset() * 60 + 2082844800, 38);
  }
  header.write("H+", 42, "ascii"); // The generated image is HFS+.
  // The delivered image is read-only. A read/write-media alias (4) resolves on
  // the staging mount but fails without context when Finder opens the DMG.
  header.writeUInt16BE(5, 44);
  for (const id of [parentId, targetId]) assert.ok(Number.isInteger(id) && id >= 0 && id <= 0xffffffff, "Invalid image catalog node ID.");
  header.writeUInt32BE(parentId, 46);
  header.writeUInt8(filename.length, 50);
  header.write(filename, 51, "ascii");
  header.writeUInt32BE(targetId, 114);
  header.writeUInt16BE(1, 130); // From .DS_Store up to its containing folder.
  header.writeUInt16BE(2, 132); // Then .background/background.png.
  header.writeUInt32BE(0x00000902, 134); // Native read-only HFS+ volume attributes.
  const unicode = text => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(text.length);
    return Buffer.concat([length, Buffer.from(text, "utf16le").swap16()]);
  };
  const field = (tag, value) => {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeInt16BE(tag);
    prefix.writeUInt16BE(data.length, 2);
    return Buffer.concat([prefix, data, Buffer.alloc(data.length % 2)]);
  };
  const alias = Buffer.concat([header,
    field(0, ".background"),
    field(2, `${volume}:.background:${filename}`),
    field(14, unicode(filename)),
    field(15, unicode(volume)),
    field(18, `.background/${filename}`),
    field(19, `/Volumes/${volume}`),
    field(-1, Buffer.alloc(0)),
  ]);
  alias.writeUInt16BE(alias.length, 4);
  return alias;
}
