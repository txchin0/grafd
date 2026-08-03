import { describe, expect, it } from 'vitest';
import { crc32, createZipArchive } from '../src/client/zip.js';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

interface ParsedEntry {
  path: string;
  text: string;
  crc: number;
}

// Reads the archive the way an extractor would: local headers first, then verifies the
// central directory and end record agree with them.
function parseArchive(bytes: Uint8Array): ParsedEntry[] {
  const data = view(bytes);
  const decoder = new TextDecoder();
  const entries: ParsedEntry[] = [];
  let offset = 0;
  while (data.getUint32(offset, true) === LOCAL_HEADER_SIGNATURE) {
    const crc = data.getUint32(offset + 14, true);
    const size = data.getUint32(offset + 18, true);
    const nameLength = data.getUint16(offset + 26, true);
    const extraLength = data.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.push({
      path: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      text: decoder.decode(bytes.subarray(dataStart, dataStart + size)),
      crc,
    });
    offset = dataStart + size;
  }
  expect(data.getUint32(offset, true)).toBe(CENTRAL_HEADER_SIGNATURE);
  const endOffset = bytes.length - 22;
  expect(data.getUint32(endOffset, true)).toBe(END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  expect(data.getUint16(endOffset + 10, true)).toBe(entries.length);
  expect(data.getUint32(endOffset + 16, true)).toBe(offset);
  return entries;
}

describe('crc32', () => {
  it('matches the reference value for a known input', () => {
    expect(crc32(new TextEncoder().encode('hello'))).toBe(0x3610a686);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('createZipArchive', () => {
  it('produces an archive whose entries round-trip with valid checksums', () => {
    const files = [
      { path: 'main.flow', text: '---\nname: main\n---\n' },
      { path: 'auth/login.flow', text: 'Validate Input\n  -> Authenticate\n' },
      { path: 'grafd.manifest.json', text: '{"entrypoint": "main.flow"}\n' },
    ];
    const parsed = parseArchive(createZipArchive(files, new Date(2026, 6, 20, 12, 0, 0)));
    expect(parsed.map(({ path, text }) => ({ path, text }))).toEqual(files);
    for (const entry of parsed) {
      expect(entry.crc).toBe(crc32(new TextEncoder().encode(entry.text)));
    }
  });

  it('stores unicode paths and content as UTF-8', () => {
    const [entry] = parseArchive(createZipArchive([{ path: 'flöws/tæst.flow', text: 'Nöde → Über\n' }]));
    expect(entry.path).toBe('flöws/tæst.flow');
    expect(entry.text).toBe('Nöde → Über\n');
  });

  it('produces just a central-directory end record for an empty workspace', () => {
    const bytes = createZipArchive([]);
    expect(bytes.length).toBe(22);
    expect(view(bytes).getUint32(0, true)).toBe(END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  });
});
