// Minimal ZIP archive writer for workspace export. Entries are stored uncompressed
// (method 0) — .flow workspaces are small text files, and storing avoids a compression
// dependency. Names are written as UTF-8 with general-purpose flag bit 11 set, per the
// ZIP appnote.

export interface ZipEntry {
  path: string;
  text: string;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const UTF8_NAMES_FLAG = 0x0800;
const ZIP_VERSION = 20;

const crcTable = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value;
  }
  return table;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// MS-DOS date/time format used by ZIP: two-second resolution, epoch 1980.
function dosDateTime(date: Date): { time: number; date: number } {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate =
    ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: dosTime, date: dosDate };
}

class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  length = 0;

  bytes(data: Uint8Array): void {
    this.chunks.push(data);
    this.length += data.length;
  }

  uint16(value: number): void {
    this.bytes(new Uint8Array([value & 0xff, (value >> 8) & 0xff]));
  }

  uint32(value: number): void {
    this.bytes(new Uint8Array([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]));
  }

  concat(): Uint8Array {
    const result = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

export function createZipArchive(entries: ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const writer = new ByteWriter();
  const centralRecords: { nameBytes: Uint8Array; crc: number; size: number; offset: number }[] = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const dataBytes = encoder.encode(entry.text);
    const crc = crc32(dataBytes);
    centralRecords.push({ nameBytes, crc, size: dataBytes.length, offset: writer.length });

    writer.uint32(LOCAL_HEADER_SIGNATURE);
    writer.uint16(ZIP_VERSION);
    writer.uint16(UTF8_NAMES_FLAG);
    writer.uint16(0); // method: stored
    writer.uint16(time);
    writer.uint16(date);
    writer.uint32(crc);
    writer.uint32(dataBytes.length);
    writer.uint32(dataBytes.length);
    writer.uint16(nameBytes.length);
    writer.uint16(0); // extra field length
    writer.bytes(nameBytes);
    writer.bytes(dataBytes);
  }

  const centralDirectoryOffset = writer.length;
  for (const record of centralRecords) {
    writer.uint32(CENTRAL_HEADER_SIGNATURE);
    writer.uint16(ZIP_VERSION); // version made by
    writer.uint16(ZIP_VERSION); // version needed
    writer.uint16(UTF8_NAMES_FLAG);
    writer.uint16(0); // method: stored
    writer.uint16(time);
    writer.uint16(date);
    writer.uint32(record.crc);
    writer.uint32(record.size);
    writer.uint32(record.size);
    writer.uint16(record.nameBytes.length);
    writer.uint16(0); // extra field length
    writer.uint16(0); // comment length
    writer.uint16(0); // disk number
    writer.uint16(0); // internal attributes
    writer.uint32(0); // external attributes
    writer.uint32(record.offset);
    writer.bytes(record.nameBytes);
  }
  const centralDirectorySize = writer.length - centralDirectoryOffset;

  writer.uint32(END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  writer.uint16(0); // this disk
  writer.uint16(0); // central directory disk
  writer.uint16(centralRecords.length);
  writer.uint16(centralRecords.length);
  writer.uint32(centralDirectorySize);
  writer.uint32(centralDirectoryOffset);
  writer.uint16(0); // comment length

  return writer.concat();
}
