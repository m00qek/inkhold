// A minimal STORE-only zip writer (no runtime deps). Store suffices: payloads
// are PNGs, and OpenRaster requires an uncompressed `mimetype` entry anyway.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

/** Standard zip/PNG CRC-32 (reflected, poly 0xEDB88320). */
export function crc32(data: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Serialise `entries` as a store-only ZIP (little-endian; sizes are raw sizes). */
export function writeStoredZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0; // running offset of the next local header

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature (PK\x03\x04)
    lv.setUint16(4, 20, true); // version needed to extract
    lv.setUint16(6, 0, true); // general purpose bit flag
    lv.setUint16(8, 0, true); // compression method = 0 (store)
    lv.setUint16(10, 0, true); // last mod file time
    lv.setUint16(12, 0, true); // last mod file date
    lv.setUint32(14, crc, true); // crc-32
    lv.setUint32(18, size, true); // compressed size (== uncompressed for store)
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // file name length
    lv.setUint16(28, 0, true); // extra field length
    lh.set(nameBytes, 30);
    chunks.push(lh, e.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed to extract
    cv.setUint16(8, 0, true); // general purpose bit flag
    cv.setUint16(10, 0, true); // compression method
    cv.setUint16(12, 0, true); // last mod file time
    cv.setUint16(14, 0, true); // last mod file date
    cv.setUint32(16, crc, true); // crc-32
    cv.setUint32(20, size, true); // compressed size
    cv.setUint32(24, size, true); // uncompressed size
    cv.setUint16(28, nameBytes.length, true); // file name length
    cv.setUint16(30, 0, true); // extra field length
    cv.setUint16(32, 0, true); // file comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal file attributes
    cv.setUint32(38, 0, true); // external file attributes
    cv.setUint32(42, offset, true); // relative offset of local header
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += lh.length + size;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    chunks.push(c);
    cdSize += c.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central dir signature
  ev.setUint16(4, 0, true); // number of this disk
  ev.setUint16(6, 0, true); // disk with the start of the central directory
  ev.setUint16(8, entries.length, true); // central dir entries on this disk
  ev.setUint16(10, entries.length, true); // total central dir entries
  ev.setUint32(12, cdSize, true); // size of the central directory
  ev.setUint32(16, cdStart, true); // offset of central directory
  ev.setUint16(20, 0, true); // .zip file comment length
  chunks.push(eocd);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
