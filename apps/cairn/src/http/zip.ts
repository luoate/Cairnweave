/**
 * Minimal ZIP writer (M20b).
 *
 * The writeup points at payload and evidence files by path, so the control plane has to be
 * able to hand over the bytes as one bundle. A ZIP needs no client-side unpacking step on
 * Windows, macOS or Linux, and the format is small enough to write directly: store and raw
 * deflate entries, one central directory, no encryption and no archive comments.
 *
 * The writer takes entries in the caller's order and keeps every offset it needs for the
 * central directory while streaming the local headers, so the output is deterministic for a
 * given entry list and modification time.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntryInput {
  /** Path inside the archive; forward slashes, no leading slash, no "..". */
  name: string;
  data: Uint8Array;
  /** Timestamp written into both headers; fixed by the caller so output is reproducible. */
  modifiedAt?: Date;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
/** Bit 11: file names are UTF-8. Bit 3 would need data descriptors, which we never write. */
const UTF8_NAME_FLAG = 0x0800;
const VERSION_NEEDED = 20;
const STORE_METHOD = 0;
const DEFLATE_METHOD = 8;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return ~crc >>> 0;
}

export function buildZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const chunks: Buffer[] = [];
  const records: CentralRecord[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(assertEntryName(entry.name), "utf8");
    const raw = entry.data instanceof Buffer ? entry.data : Buffer.from(entry.data);
    const deflated = raw.length === 0 ? null : deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated !== null && deflated.length < raw.length;
    const body = useDeflate ? (deflated as Buffer) : raw;
    const method = useDeflate ? DEFLATE_METHOD : STORE_METHOD;
    const stamp = dosDateTime(entry.modifiedAt ?? new Date(0));

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(UTF8_NAME_FLAG, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc32(raw), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    records.push({
      name,
      method,
      time: stamp.time,
      date: stamp.date,
      crc: crc32(raw),
      compressedSize: body.length,
      uncompressedSize: raw.length,
      localOffset: offset,
    });

    chunks.push(header, name, body);
    offset += header.length + name.length + body.length;
  }

  const centralStart = offset;
  for (const record of records) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(UTF8_NAME_FLAG, 8);
    header.writeUInt16LE(record.method, 10);
    header.writeUInt16LE(record.time, 12);
    header.writeUInt16LE(record.date, 14);
    header.writeUInt32LE(record.crc, 16);
    header.writeUInt32LE(record.compressedSize, 20);
    header.writeUInt32LE(record.uncompressedSize, 24);
    header.writeUInt16LE(record.name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(record.localOffset, 42);
    chunks.push(header, record.name);
    offset += header.length + record.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);

  return Buffer.concat(chunks);
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Reads back an archive produced by `buildZip`, unpacking every entry and checking its CRC.
 * The writer is small enough that the pairing is the format test; the archive routes use it
 * to assert what a reviewer would actually get after unpacking.
 */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const buffer = Buffer.from(bytes);
  const end = findEndRecord(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const centralSize = buffer.readUInt32LE(end + 12);
  if (centralOffset + centralSize > end) throw new Error("truncated central directory");

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error("bad central header");
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");

    if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error("bad local header");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    if (buffer.readUInt32LE(localOffset + 14) !== crc) throw new Error("crc mismatch in headers");
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const packed = buffer.subarray(start, start + compressedSize);
    const data = method === STORE_METHOD ? Buffer.from(packed) : inflateRawSync(packed);
    if (data.length !== uncompressedSize) throw new Error("unexpected entry size");
    if (crc32(data) !== crc) throw new Error(`checksum mismatch for ${name}`);

    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndRecord(buffer: Buffer): number {
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index -= 1) {
    if (buffer.readUInt32LE(index) === END_SIGNATURE) return index;
  }
  throw new Error("no end-of-central-directory record");
}

/** Reject names that would escape the archive root when unpacked. */
function assertEntryName(name: string): string {
  const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized === "" || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`invalid zip entry name: ${name}`);
  }
  return normalized;
}

function dosDateTime(value: Date): { time: number; date: number } {
  const year = Math.max(1980, value.getUTCFullYear());
  const month = value.getUTCMonth() + 1;
  const day = value.getUTCDate();
  const time =
    (value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) | (value.getUTCSeconds() >> 1);
  const date = ((year - 1980) << 9) | (month << 5) | day;
  return { time, date };
}

interface CentralRecord {
  name: Buffer;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}
