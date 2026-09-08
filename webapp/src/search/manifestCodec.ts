// The DECODER for the server's MANIFEST payload — the caller's complete live
// document set, which is what the browser diffs its local index against
// (`client-side-search-impl.md` §2.2, §3 step 4). The encoder is
// `backend/services/search/index_export.zig`'s `writeManifest`, and the two are
// pinned to each other by ONE checked-in artifact,
// `backend/services/search/testdata/manifest_golden.bin`, which this module's
// test decodes against expectations written out by hand HERE. Regenerating that
// file to make the Zig test pass turns this side red, which is the only
// arrangement that catches a format change made on one side only.
//
// Pure: no wasm, no network, no DOM. It sits beside `termCodec.ts` and shares
// its cursor (`wire.ts`), because the two payloads are spelt the same way by the
// same encoder and must fail the same way too.
//
// ## THE MANIFEST IS COMPLETE OR IT IS BROKEN
//
// This is not a listing the client merges into what it has — it REPLACES it.
// Sync is additive ("here are the md5s I hold, send the ones I am missing") and
// nothing on the wire ever removes anything; there are no tombstones. A trashed
// file stops matching in the browser because it is ABSENT from the next complete
// manifest and the client diffs the whole set. That is the only removal
// mechanism this design has.
//
// Which makes truncation the one corruption that looks like a legitimate answer:
// a body that ran out of rows halfway decodes as a shorter, perfectly
// well-formed manifest, and the client reads every missing row as a DELETION of
// a document that is still there. `rowCount` is in the header precisely so that
// cannot happen silently, and this decoder checks it and the trailing bytes.
//
// ## Bytes rather than JSON, and the client does not get to choose
//
// MEASURED over 1,222 documents: 143,139 bytes of JSON against 27,663 of this,
// because md5s are 72.6% of the payload and a hash does not compress. The server
// sends no `content-encoding` on API responses, so that 5.2x is what travels, on
// a response paid on every visit.
//
// ## Layout (mirrors `index_export.zig`'s `writeManifest`; change both or neither)
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

import { Cursor, SearchWireError, readMagic } from "./wire";

/** The wire spelling this build understands. NOT `index_version`. */
export const MANIFEST_FORMAT_VERSION = 1;

/** magic + version + rowCount. */
export const MANIFEST_HEADER_LEN = 9;

/** "SMAN". */
const MAGIC = [0x53, 0x4d, 0x41, 0x4e];

/**
 * Which pass of the fill a document belongs to (`client-side-search.md` §3), in
 * the order the server sends them: the household's own handwriting, then
 * anything it has written on, then everything else.
 *
 * A PRIORITY, not an exclusion — every live document is in exactly one tier, and
 * `other` is the catch-all that makes that true. Being wrong about a tier costs
 * a wait, never a missing result.
 */
export type Tier = "note" | "marked" | "other";

/**
 * What the client is allowed to conclude from an EMPTY term set for this md5.
 *
 * **This is a CACHE decision, not a status line** (`client-side-search.md` §4).
 * An empty term set is a legitimate, final answer for a document whose text
 * folds to nothing — and a blob whose derive has not run also has no terms. On
 * the wire the two are identical. A client that caches the second one's
 * emptiness never asks again, and that document is unsearchable FOR EVER: no
 * error, no retry, no symptom.
 *
 * So: cache an empty set under `derived`, and never under `pending` or
 * `unknown`.
 */
export type Derivation = "derived" | "pending" | "unknown";

/** One live document of the caller's. */
export interface ManifestRow {
  /** 32 lowercase hex — the term payload's key and the sync diff's identity. */
  readonly md5: string;
  /**
   * `files.id`. What a locally-answered hit has to name in order to be opened,
   * and — because the manifest deliberately carries no names — what the client
   * looks the document's NAME up by in the file listing it already holds.
   */
  readonly fileId: number;
  /** The fill pass this document belongs to. */
  readonly tier: Tier;
  /** `files.updated_at`, seconds. The display order for a set of hits. */
  readonly updatedAt: number;
  /**
   * The other half of the `(md5, indexVersion)` cache key, or null when the blob
   * has no index row at all.
   *
   * **A null here means the entry cannot be cached, not that the version is 0.**
   * Zero is a real version and arrives as `0`. Keying a cache entry on md5 alone
   * is the mistake this field exists to prevent: `derivation` agrees with the
   * deferred worker rather than with the plain-English question, so a blob whose
   * index row is STALE reports `derived` while genuinely underived — and the
   * only thing that makes that window survivable is that its version is not the
   * current one, so a client keyed on both refetches.
   */
  readonly indexVersion: number | null;
  /** See {@link Derivation}. */
  readonly derivation: Derivation;
}

/**
 * How much of the caller's library is searchable at all — the fraction the
 * zero-hit search sentence renders.
 */
export interface Coverage {
  /** Notes, by the indexer's verdict (a blob it really parsed as a `.note`). */
  readonly notes: number;
  /**
   * How many of those carry no recognised text and are therefore invisible to
   * search however it is spelled. PERMANENT, and not to be confused with
   * `derivation === "pending"`, which is transient and resolves itself.
   */
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
  // Checked BEFORE anything is allocated: a corrupt `rowCount` is four bytes
  // that would otherwise ask the browser for an array of four billion rows. The
  // floor is 16 bytes of md5 plus a flags byte plus three varints of at least
  // one byte each.
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

    // UNKNOWN TIERS AND UNKNOWN DERIVATIONS ARE REFUSED, NOT COERCED. Both are
    // small closed sets, and the conservative-looking fallbacks are the
    // dangerous ones: defaulting a tier to `other` reorders a fill the server
    // decided, and defaulting a derivation to `derived` is a licence to cache an
    // empty term set for ever. If this build does not understand the value, the
    // server is speaking a dialect it does not know, and that is the version
    // byte's business rather than something to paper over per row.
    const tier = TIERS[flags & 0x0f];
    if (tier === undefined) throw new SearchWireError(`manifest row carries an unknown tier ${flags & 0x0f}`);
    const derivation = DERIVATIONS[flags >> 4];
    if (derivation === undefined) {
      throw new SearchWireError(`manifest row carries an unknown derivation state ${flags >> 4}`);
    }

    const fileId = cursor.varint();
    // A GAP from the previous row of the SAME tier, or a fresh ABSOLUTE anchor
    // when the tier changed — which is the only place the gap could have gone
    // negative, and therefore the only place an anchor is needed. Getting this
    // wrong does not throw: it silently shifts every timestamp after the first
    // tier change, and the symptom is a result list in a plausible but wrong
    // order. That is why the golden vector spans all three tiers.
    const raw = cursor.varint();
    const updatedAt = previousTier === tier ? previousUpdatedAt - raw : raw;
    const rawVersion = cursor.varint();

    rows[i] = {
      md5,
      fileId,
      tier,
      updatedAt,
      // 0 is ABSENT and everything else is `value - 1`, so a document indexed at
      // version 0 survives the round trip as 0 rather than becoming "no index
      // row" — see `ManifestRow.indexVersion`.
      indexVersion: rawVersion === 0 ? null : rawVersion - 1,
      derivation,
    };
    previousTier = tier;
    previousUpdatedAt = updatedAt;
  }

  // THE TRUNCATION CHECK, and for this payload it is not a nicety. A body that
  // ran out of rows decodes as a shorter, well-formed manifest, and the client
  // reads every absent row as a deletion of a document that is still there. The
  // count is in the header so this can be asked at all.
  if (cursor.offset !== payload.length) {
    throw new SearchWireError("manifest payload has trailing bytes after its last row");
  }
  return { coverage: { notes, unsearchable }, rows };
}
