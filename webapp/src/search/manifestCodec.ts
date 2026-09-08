// The DECODER for the server's MANIFEST payload — the caller's complete live
// document set. The encoder is
// `backend/services/search/index_export.zig`'s `writeManifest`; the two are
// pinned by ONE checked-in artifact, `testdata/manifest_golden.bin`, whose
// expectations are written out by hand on both sides. Pure: no wasm, no
// network, no DOM. The cursor and the one error class it reads through are at
// the bottom of this file.
//
// What this must not break:
//   * THE MANIFEST REPLACES, NEVER MERGES. Nothing on the wire removes anything
//     and there are no tombstones; absence from the next complete manifest is
//     the ONLY deletion mechanism. So truncation is the one corruption that
//     looks like a legitimate answer — a body that ran out of rows decodes as a
//     shorter, well-formed manifest and every missing row reads as a deletion.
//     `rowCount` is in the header so the trailing-bytes check can catch it.
//   * Bytes, not JSON: 27,663 bytes against 143,139 for 1,222 documents (md5s
//     are 72.6% of the payload and do not compress), on a response paid every
//     visit with no `content-encoding`.
//
// Layout (mirrors `writeManifest`; change both or neither):
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

/** magic + version + rowCount. */
export const MANIFEST_HEADER_LEN = 9;

/** "SMAN". */
const MAGIC = [0x53, 0x4d, 0x41, 0x4e];

/**
 * Which pass of the fill a document belongs to (§3), in the order the server
 * sends them. A PRIORITY, not an exclusion: every live document is in exactly
 * one tier, so being wrong about a tier costs a wait, never a missing result.
 */
export type Tier = "note" | "marked" | "other";

/**
 * What the client may conclude from an EMPTY term set for this md5. A CACHE
 * decision: a document whose text folds to nothing and a blob whose derive has
 * not run are identical on the wire, and a client that caches the second one's
 * emptiness never asks again — that document is unsearchable FOR EVER with no
 * symptom. Cache an empty set under `derived`, never under `pending`/`unknown`.
 */
export type Derivation = "derived" | "pending" | "unknown";

/** One live document of the caller's. */
export interface ManifestRow {
  /** 32 lowercase hex — the term payload's key and the sync diff's identity. */
  readonly md5: string;
  /** `files.id`. The manifest carries no names; the client looks the name up
   *  by this in the listing it already holds. */
  readonly fileId: number;
  /** The fill pass this document belongs to. */
  readonly tier: Tier;
  /** `files.updated_at`, seconds. The display order for a set of hits. */
  readonly updatedAt: number;
  /**
   * The other half of the `(md5, indexVersion)` cache key, or null when the
   * blob has no index row. **Null means "cannot be cached", not version 0** —
   * zero is a real version and arrives as `0`. A blob whose index row is STALE
   * reports `derived` while genuinely underived; the only thing that makes
   * that window survivable is a client keyed on both halves refetching.
   */
  readonly indexVersion: number | null;
  /** See {@link Derivation}. */
  readonly derivation: Derivation;
}

/** How much of the caller's library is searchable at all — the fraction the
 *  zero-hit search sentence renders. */
export interface Coverage {
  /** Notes, by the indexer's verdict (a blob it really parsed as a `.note`). */
  readonly notes: number;
  /** Notes with no recognised text — invisible to search however it is
   *  spelled. PERMANENT, unlike `derivation === "pending"`. */
  readonly unsearchable: number;
}

/** One decoded manifest: the caller's COMPLETE live document set. */
export interface DocumentManifest {
  readonly coverage: Coverage;
  /** Every live document, in the server's fill order. */
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
  // Checked BEFORE anything is allocated: a corrupt `rowCount` would otherwise
  // ask for an array of four billion rows. Floor: 16 md5 + 1 flags + 3 varints.
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

    // REFUSED, NOT COERCED: defaulting a tier to `other` reorders a fill the
    // server decided, and defaulting a derivation to `derived` is a licence to
    // cache an empty term set for ever.
    const tier = TIERS[flags & 0x0f];
    if (tier === undefined) throw new SearchWireError(`manifest row carries an unknown tier ${flags & 0x0f}`);
    const derivation = DERIVATIONS[flags >> 4];
    if (derivation === undefined) {
      throw new SearchWireError(`manifest row carries an unknown derivation state ${flags >> 4}`);
    }

    const fileId = cursor.varint();
    // A GAP from the previous row of the SAME tier, or an ABSOLUTE anchor when
    // the tier changed. Getting this wrong does not throw: it silently shifts
    // every timestamp after the first tier change, and the symptom is a result
    // list in a plausible but wrong order — hence a golden vector spanning all
    // three tiers.
    const raw = cursor.varint();
    const updatedAt = previousTier === tier ? previousUpdatedAt - raw : raw;
    const rawVersion = cursor.varint();

    rows[i] = {
      md5,
      fileId,
      tier,
      updatedAt,
      // 0 is ABSENT and everything else is `value - 1`, so version 0 survives.
      indexVersion: rawVersion === 0 ? null : rawVersion - 1,
      derivation,
    };
    previousTier = tier;
    previousUpdatedAt = updatedAt;
  }

  // THE TRUNCATION CHECK — see the header: a short body is otherwise read as
  // deletions of documents that are still there.
  if (cursor.offset !== payload.length) {
    throw new SearchWireError("manifest payload has trailing bytes after its last row");
  }
  return { coverage: { notes, unsearchable }, rows };
}

// -----------------------------------------------------------------------------
// The wire primitives: cursor, varint, bounds checks and the one error class.
// Shared by every reader of a `search-index` payload (`termsStream.ts`,
// `docText.ts`, `wantBitmap.ts` throw the same error).

/**
 * A payload this build refuses to read — "the server speaks a format I do
 * not", which wants a reload, not a retry. ONE class across every payload, so
 * a `catch` cannot handle one and let another escape.
 */
export class SearchWireError extends Error {
  override readonly name = "SearchWireError";
}

/** A varint wider than this cannot be a length, a count, an id or an ordinal. */
const MAX_VARINT_BYTES = 5;

// `fatal`: terms were folded by SQLite's tokenizer and are valid UTF-8 by
// construction, so a replacement character means the stream came apart — and
// an index quietly full of U+FFFD matches nothing a user can type.

/** A bounds-checked forward reader over one payload. */
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

  /** u32 little-endian. */
  u32(): number {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const value = view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** 16 raw bytes as 32 lowercase hex characters. */
  md5(): string {
    let hex = "";
    for (const byte of this.slice(16)) hex += byte.toString(16).padStart(2, "0");
    return hex;
  }
}

/**
 * Check the magic and the version byte, or throw. The message spells out that
 * this is the WIRE SPELLING, not `index_version`: the obvious fix — bump
 * `index_version` and re-derive — throws away a household's whole index to
 * pick up a codec change.
 */
export function readMagic(cursor: Cursor, magic: readonly number[], version: number): void {
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
