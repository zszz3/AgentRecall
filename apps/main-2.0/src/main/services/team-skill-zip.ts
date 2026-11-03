import { crc32, deflateRawSync } from "node:zlib";

export type ZipEntry = { path: string; content: Buffer; executable: boolean };

// 1980-01-01 00:00 in DOS format. A fixed timestamp keeps identical Skills
// producing identical archives, so recipients can compare them by checksum.
const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1;
const UTF8_NAMES = 0x0800;

/**
 * Writes a ZIP archive without ZIP64. Callers stay within its limits because
 * team snapshots are capped at 16 MiB and 64 Skills × 200 files. Entries are
 * marked as created on Unix so `unzip` and Finder restore executable bits.
 * Paths must already be portable relative paths with `/` separators.
 */
export function writeZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const deflated = deflateRawSync(entry.content);
    const stored = deflated.length >= entry.content.length;
    const data = stored ? entry.content : deflated;
    const checksum = crc32(entry.content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(UTF8_NAMES, 6); header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt16LE(DOS_TIME, 10); header.writeUInt16LE(DOS_DATE, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(entry.content.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | 20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(UTF8_NAMES, 8); record.writeUInt16LE(stored ? 0 : 8, 10);
    record.writeUInt16LE(DOS_TIME, 12); record.writeUInt16LE(DOS_DATE, 14); record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(entry.content.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((entry.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(record, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
