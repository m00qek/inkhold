// Decoder for the search manifest, the caller's complete live document set.
// Encoder: `backend/services/search/index_export.zig` `writeManifest`, pinned
// by `testdata/manifest_golden.bin`. The manifest replaces, never merges:
// absence is the only deletion, so a truncated body would read as deletions.
//
// Layout (change both sides or neither):
//
//     "SMAN"                     magic, 4 bytes
//     MANIFEST_FORMAT_VERSION    u8
//     rowCount                   u32 LE
//     notes                      varint
//     unsearchable               varint
//     rowCount x row, in the server's fill order:
//       md5                      16 RAW bytes
//       flags                    u8      tier in the low nibble, derivation in the high
//       fileId                   varint
//       updatedAt                varint  ABSOLUTE on a tier's first row, else the
//                                        gap from the row before it
//       indexVersion             varint  0 = absent, else version + 1

/** The wire spelling this build understands. NOT `index_version`. */
export const MANIFEST_FORMAT_VERSION = 1;

export const MANIFEST_HEADER_LEN = 9;

const MAGIC = [0x53, 0x4d, 0x41, 0x4e];

/** The fill pass a document belongs to, in server order. A priority only. */
export type Tier = "note" | "marked" | "other";

/**
 * Whether an empty term set may be cached. Underived and text-less documents
 * look identical on the wire, so cache emptiness only under `derived`.
 */
export type Derivation = "derived" | "pending" | "unknown";

export interface ManifestRow {
  readonly md5: string;
  /** `files.id`; the name comes from the listing the client already holds. */
  readonly fileId: number;
  readonly tier: Tier;
  /** `files.updated_at`, seconds; the display order for hits. */
  readonly updatedAt: number;
  /**
   * The other half of the `(md5, indexVersion)` cache key. Null means "cannot
   * be cached", not version 0.
   */
  readonly indexVersion: number | null;
  readonly derivation: Derivation;
}

/** How much of the library is searchable, for the zero-hit sentence. */
export interface Coverage {
  readonly notes: number;
  /** Notes with no recognised text. Permanent, unlike `pending`. */
  readonly unsearchable: number;
}

export interface DocumentManifest {
  readonly coverage: Coverage;
  readonly rows: readonly ManifestRow[];
}

const TIERS: Record<number, Tier> = { 1: "note", 2: "marked", 3: "other" };
const DERIVATIONS: Record<number, Derivation> = { 0: "derived", 1: "pending", 2: "unknown" };

export function decodeManifest(payload: Uint8Array): DocumentManifest {
  const cursor = new Cursor(payload);
  if (payload.length < MANIFEST_HEADER_LEN) {
    throw new SearchWireError("manifest payload is shorter than its header");
  }
  readMagic(cursor, MAGIC, MANIFEST_FORMAT_VERSION);
  const rowCount = cursor.u32();
  // Checked before allocating. Floor per row: 16 md5 + 1 flags + 3 varints.
  if (MANIFEST_HEADER_LEN + rowCount * 20 > payload.length + 2) {
    throw new SearchWireError("manifest payload is too short for the row count it declares");
  }
  const notes = cursor.varint();
  const unsearchable = cursor.varint();

  const rows: ManifestRow[] = new Array<ManifestRow>(rowCount);
  let previousTier: Tier | null = null;
  let previousUpdatedAt = 0;
  for (let i = 0; i < rowCount; i += 1) {
    const md5 = cursor.md5();
    const flags = cursor.byte();

    // Refused, not coerced: a defaulted derivation would license caching emptiness.
    const tier = TIERS[flags & 0x0f];
    if (tier === undefined) throw new SearchWireError(`manifest row carries an unknown tier ${flags & 0x0f}`);
    const derivation = DERIVATIONS[flags >> 4];
    if (derivation === undefined) {
      throw new SearchWireError(`manifest row carries an unknown derivation state ${flags >> 4}`);
    }

    const fileId = cursor.varint();
    // A gap within a tier, an absolute anchor when the tier changes.
    const raw = cursor.varint();
    const updatedAt = previousTier === tier ? previousUpdatedAt - raw : raw;
    const rawVersion = cursor.varint();

    rows[i] = {
      md5,
      fileId,
      tier,
      updatedAt,
      // 0 is absent, else value - 1, so version 0 survives.
      indexVersion: rawVersion === 0 ? null : rawVersion - 1,
      derivation,
    };
    previousTier = tier;
    previousUpdatedAt = updatedAt;
  }

  // The truncation check.
  if (cursor.offset !== payload.length) {
    throw new SearchWireError("manifest payload has trailing bytes after its last row");
  }
  return { coverage: { notes, unsearchable }, rows };
}

// ---- wire primitives, shared by every search-index payload reader ----

/** A payload format this build cannot read: wants a reload, not a retry. One class for every payload. */
export class SearchWireError extends Error {
  override readonly name = "SearchWireError";
}

const MAX_VARINT_BYTES = 5;

// Terms are valid UTF-8 by construction, so decode with `fatal`: U+FFFD means a broken stream.
export class Cursor {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}

  byte(): number {
    const b = this.bytes[this.offset];
    if (b === undefined) throw new SearchWireError("search index payload ends mid-record");
    this.offset += 1;
    return b;
  }

  slice(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.bytes.length) {
      throw new SearchWireError("search index payload ends mid-record");
    }
    const out = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return out;
  }

  /** Unsigned LEB128, bounded so a corrupt stream cannot spin. */
  varint(): number {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) {
        if (value > 0xffffffff) {
          throw new SearchWireError("search index payload carries an implausible length");
        }
        return value;
      }
      shift += 7;
    }
    throw new SearchWireError("search index payload carries an over-long varint");
  }

  u32(): number {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const value = view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  md5(): string {
    let hex = "";
    for (const byte of this.slice(16)) hex += byte.toString(16).padStart(2, "0");
    return hex;
  }
}

/** The error names the wire version, not `index_version`, so nobody bumps the latter to fix a codec change. */
function readMagic(cursor: Cursor, magic: readonly number[], version: number): void {
  if (cursor.bytes.length < magic.length + 1) {
    throw new SearchWireError("search index payload is shorter than its header");
  }
  for (const expected of magic) {
    if (cursor.byte() !== expected) {
      throw new SearchWireError("not a search index payload (bad magic)");
    }
  }
  const got = cursor.byte();
  if (got !== version) {
    throw new SearchWireError(
      `unsupported search index format version ${got}; this build decodes ${version}. ` +
        "This is the wire spelling, not index_version: the terms have not changed.",
    );
  }
}
