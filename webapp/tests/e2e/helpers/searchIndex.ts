import type { Page } from "@playwright/test";
import { noteTranscript, recognisedPages } from "./docText";

// THE TWO ROUTES THE LIBRARY'S OWN SEARCH IS BUILT ON, as a fixture —
// `golden-search.md` §6.1's positive half.
//
//     GET /api/controlplane/search-index/manifest          → SMAN bytes + ETag
//     GET /api/controlplane/search-index/stream?m=…&want=… → stitched JSONL
//
// Everything above them is real: `indexSync.ts` decodes the manifest, diffs it
// against IndexedDB, encodes a `want` bitmap, streams the answer through
// `termsStream.ts` into `termsStore.ts`, and `indexSearch.ts` builds a real
// FTS5 index in real wasm out of what landed. The only thing standing in for the
// server is the twenty lines below that write the bytes.
//
// ## WHY A REAL ENCODER AND NOT A CANNED BLOB
//
// The manifest is a delta-encoded binary format with a per-tier anchor rule
// (`manifestCodec.ts`), so a fixture that names OUR documents cannot be a
// checked-in blob — the md5s and file ids are `api/fake.ts`'s and change with
// it. It has to be generated, which means an encoder, which means an encoder
// that can be WRONG in the one way that throws nothing: getting the delta rule
// backwards silently shifts every timestamp after the first tier change, and the
// symptom is a plausible, wrongly-ordered result list.
//
// So {@link encodeManifest} is pinned in `tests/unit/searchIndexFixture.test.ts`
// against `backend/services/search/testdata/manifest_golden.bin` — the SAME
// artifact the Zig encoder and `manifestCodec.test.ts` are pinned to. It
// re-encodes that file BYTE FOR BYTE from the rows written out by hand there. An
// encoder that is merely plausible would be worse than none: it would make the
// e2e sweep green over a format neither side speaks.
//
// ## THE STREAM IS SERVED PLAIN, AND IT HAS TO BE — MEASURED, NOT ASSUMED
//
// The real route serves ONE gzip member under `content-encoding: gzip`, which
// the browser inflates before `response.body` yields a byte —
// `indexTransport.ts` says so explicitly, and `termsStream.ts` repeats it:
// nothing on the client decompresses. So a plain body reaches `parseTermsJsonl`
// as the identical text, which is the same call `docText.ts`'s header already
// made for `text/<md5>`.
//
// It is not merely that gzip buys nothing here — **it does not work.** A
// `route.fulfill` body is handed to the page VERBATIM: Playwright fulfils below
// the point where Chromium's content-encoding pipeline runs, so a
// `content-encoding: gzip` header is passed through as a header and the gzip
// bytes arrive as the body. Probed directly, with and without a matching
// `content-length`: a 55-byte record gzipped to 45 bytes came back as 45 bytes
// beginning `1f 8b 08 00`, both times. `TextDecoderStream("utf-8", {fatal:true})`
// then throws on the first chunk, the sync fails, and — because a failed sync is
// silent by design (`searchService.ts`) — the only symptom is a search box that
// answers nothing. Which is precisely why the fact is recorded here instead of
// being rediscovered from a mysteriously empty result list.
//
// So: no gzip option on this mock, deliberately. There is nothing to spell it
// against.

// ---------------------------------------------------------------------------
// THE MANIFEST ENCODER — the inverse of `src/search/manifestCodec.ts`
// ---------------------------------------------------------------------------

/** Mirrors `Tier` in `manifestCodec.ts`, and the numbers are the wire's. */
export type FixtureTier = "note" | "marked" | "other";
/** Mirrors `Derivation` in `manifestCodec.ts`. */
export type FixtureDerivation = "derived" | "pending" | "unknown";

const TIER_BITS: Record<FixtureTier, number> = { note: 1, marked: 2, other: 3 };
const DERIVATION_BITS: Record<FixtureDerivation, number> = { derived: 0, pending: 1, unknown: 2 };

/** One manifest row, in the shape `decodeManifest` hands back. */
export interface FixtureManifestRow {
  /** 32 lowercase hex. */
  readonly md5: string;
  /** `files.id` as a NUMBER — the join `gallerySearch.ts` makes with
   *  `String(doc.fileId)` against a card's `Id`. */
  readonly fileId: number;
  readonly tier: FixtureTier;
  /** Seconds. Must DESCEND within a tier; see {@link encodeManifest}. */
  readonly updatedAt: number;
  /** `null` encodes as the absent marker (0); anything else as `value + 1`. */
  readonly indexVersion: number | null;
  readonly derivation: FixtureDerivation;
}

/** `Coverage` — the two numbers the zero-hit sentence renders. */
export interface FixtureCoverage {
  readonly notes: number;
  readonly unsearchable: number;
}

/** Unsigned LEB128, the spelling `Cursor.varint` reads. */
function varint(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`manifest fixture: ${value} is not a varint-shaped number`);
  }
  let v = value;
  while (v >= 0x80) {
    out.push((v % 128) + 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

/** 32 hex characters as the 16 raw bytes the row carries. */
function md5Bytes(out: number[], md5: string): void {
  if (!/^[0-9a-f]{32}$/.test(md5)) {
    throw new Error(`manifest fixture: ${md5} is not 32 lowercase hex characters`);
  }
  for (let i = 0; i < 32; i += 2) out.push(Number.parseInt(md5.slice(i, i + 2), 16));
}

/**
 * Write a manifest exactly as `index_export.zig`'s `writeManifest` does.
 *
 * **THE ROWS MUST ARRIVE TIER-GROUPED AND DESCENDING BY `updatedAt` INSIDE EACH
 * TIER**, because that is the order the delta encoding assumes and the order the
 * server promises: `updatedAt` travels as `previous - current` within a tier and
 * as a fresh ABSOLUTE anchor on the first row of each tier — the only place the
 * gap could have gone negative. A caller that hands rows in any other order gets
 * an exception here rather than a manifest that decodes without complaint into
 * the wrong timestamps.
 */
export function encodeManifest(
  rows: readonly FixtureManifestRow[],
  coverage: FixtureCoverage,
): Uint8Array {
  const out: number[] = [0x53, 0x4d, 0x41, 0x4e, 1]; // "SMAN", MANIFEST_FORMAT_VERSION
  // rowCount, u32 LE — the field that makes truncation detectable at all.
  const n = rows.length;
  out.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  varint(out, coverage.notes);
  varint(out, coverage.unsearchable);

  let previousTier: FixtureTier | null = null;
  let previousUpdatedAt = 0;
  const seenTiers = new Set<FixtureTier>();
  for (const row of rows) {
    if (previousTier !== row.tier) {
      if (seenTiers.has(row.tier)) {
        throw new Error(`manifest fixture: tier ${row.tier} is not contiguous`);
      }
      seenTiers.add(row.tier);
    }
    md5Bytes(out, row.md5);
    out.push(TIER_BITS[row.tier] | (DERIVATION_BITS[row.derivation] << 4));
    varint(out, row.fileId);
    if (previousTier === row.tier) {
      const gap = previousUpdatedAt - row.updatedAt;
      if (gap < 0) {
        throw new Error(
          `manifest fixture: ${row.md5} is newer than the row before it in tier ${row.tier}; ` +
            "rows must descend by updatedAt inside a tier",
        );
      }
      varint(out, gap);
    } else {
      varint(out, row.updatedAt);
    }
    // 0 is ABSENT and everything else is `value + 1`, so version 0 survives.
    varint(out, row.indexVersion === null ? 0 : row.indexVersion + 1);
    previousTier = row.tier;
    previousUpdatedAt = row.updatedAt;
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// THE `want=` BITMAP, READ BACK
// ---------------------------------------------------------------------------

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Decode the client's `want=` into manifest positions — the mirror of
 * `src/search/wantBitmap.ts`, and the server's half of that contract.
 *
 * The mock serves EXACTLY the positions asked for rather than the whole set,
 * which is what makes "a second sync asks for nothing" observable: a fixture
 * that always streamed everything would report a happy sync over a bitmap it
 * never read, and the LSB-first bit order — the one thing in `encodeWant` that
 * fails silently — would go unchecked in the browser.
 */
export function decodeWant(want: string, rowCount: number): number[] {
  const bits: number[] = [];
  const bytes: number[] = [];
  let acc = 0;
  let held = 0;
  for (const ch of want) {
    const v = B64URL.indexOf(ch);
    if (v < 0) throw new Error(`want bitmap: ${ch} is not a base64url character`);
    acc = acc * 64 + v;
    held += 6;
    if (held >= 8) {
      held -= 8;
      bytes.push(Math.floor(acc / 2 ** held) & 0xff);
      acc %= 2 ** held;
    }
  }
  for (let position = 0; position < rowCount; position += 1) {
    const byte = bytes[position >> 3] ?? 0;
    if ((byte >> (position & 7)) & 1) bits.push(position);
  }
  return bits;
}

// ---------------------------------------------------------------------------
// THE TERMS STREAM
// ---------------------------------------------------------------------------

/** One page's folded terms — a `{"p":…,"t":…}` line. */
export interface FixtureTermsPage {
  readonly p: number;
  readonly t: string;
}

/** One document's record: the header line plus every page line under it. */
export interface FixtureTermsDocument {
  readonly md5: string;
  /** The record's OWN `v`, which is half the store's cache key — NOT the
   *  manifest's `indexVersion`, though a fixture normally makes them agree. */
  readonly indexVersion: number;
  /** `n`: the ADDRESS SPACE, not `pages.length`. */
  readonly pageCount: number;
  readonly pages: readonly FixtureTermsPage[];
}

/**
 * Fold text the way `unicode61 remove_diacritics 2` does, over the subset of
 * Unicode the fixtures actually use.
 *
 * NOT a tokenizer: the real terms come out of FTS5 itself inside SQLite
 * (`derive_search.zig`'s header), and the browser folds only the QUERY, with the
 * same C compiled to wasm. What this has to get right is narrower — produce
 * terms the engine's re-tokenization leaves alone, which for `unicode61` means
 * no separators inside a term and nothing to case-fold. Latin letters, digits,
 * and combining marks stripped via NFD; everything else is a separator.
 */
export function foldTerms(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
    .join(" ");
}

/**
 * A fixture note's terms record, folded from the SAME generator the `text/<md5>`
 * mock serves (`docText.ts`'s `noteTranscript` and `recognisedPages`).
 *
 * Deriving both from one source is the point. The library index says which
 * documents matched and on how many pages; the in-document find says where on
 * the page. If the two were written out separately, the first divergence would
 * be a row claiming three pages and a find bar that circles two — the exact
 * "counter is right and nothing is circled" failure `docText.ts`'s header names.
 */
export function noteTermsDocument(
  md5: string,
  name: string,
  pageCount: number,
  opts: { from?: number; indexVersion?: number } = {},
): FixtureTermsDocument {
  return {
    md5,
    indexVersion: opts.indexVersion ?? 1,
    pageCount,
    pages: recognisedPages(pageCount, opts.from ?? 0).map((p) => ({
      p,
      t: foldTerms(noteTranscript(name, p)),
    })),
  };
}

/** Serialise one record: the header line, then one line per page WITH text. */
export function encodeTermsRecord(doc: FixtureTermsDocument): string {
  const lines = [JSON.stringify({ md5: doc.md5, v: doc.indexVersion, n: doc.pageCount })];
  for (const page of doc.pages) lines.push(JSON.stringify({ p: page.p, t: page.t }));
  return lines.join("\n") + "\n";
}

/** The stitched stream: every requested record, concatenated. The real one is a
 *  gzip member per fragment stitched into one; after the browser inflates it,
 *  this is the text that arrives. */
export function encodeTermsStream(docs: readonly FixtureTermsDocument[]): string {
  return docs.map(encodeTermsRecord).join("");
}

// ---------------------------------------------------------------------------
// THE ROUTES
// ---------------------------------------------------------------------------

/** What {@link mockSearchIndex} counted. */
export interface SearchIndexHits {
  /** Manifest requests, including the conditional ones. */
  manifestHits(): number;
  /** Stream requests. */
  streamHits(): number;
  /** The manifest positions each stream request asked for, in order. */
  wanted(): number[][];
}

export interface SearchIndexFixture {
  readonly rows: readonly FixtureManifestRow[];
  readonly coverage?: FixtureCoverage;
  /** Keyed by md5. A row with no record here is SKIPPED by the stream, which is
   *  normal (`indexSync.ts`: a blob GC'd or a derive outstanding) and is how a
   *  `pending` row is represented honestly. */
  readonly documents: Readonly<Record<string, FixtureTermsDocument>>;
}

/** A stable 32-hex validator for a manifest body — FNV-1a, repeated. Content
 *  addressed, so a changed fixture changes the ETag and `m=` stays truthful. */
function etagOf(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").repeat(4);
}

/**
 * Serve `search-index/manifest` and `search-index/stream`.
 *
 * Register AFTER `signedIn`: Playwright matches routes newest-first, and
 * `mockApi`'s catch-all would otherwise answer `{"success":true}`, which
 * `decodeManifest` refuses as a payload with bad magic — at some distance from
 * the cause.
 *
 * The manifest answers 304 to a matching `if-none-match`, and the stream answers
 * 412 to an `m=` that is not the current ETag, because both are control flow the
 * client has real code for (`indexSync.ts`) and a fixture that always said 200
 * would leave that code unexercised behind a green test.
 */
export async function mockSearchIndex(page: Page, fixture: SearchIndexFixture): Promise<SearchIndexHits> {
  const coverage = fixture.coverage ?? {
    notes: fixture.rows.filter((r) => r.tier === "note").length,
    unsearchable: 0,
  };
  const body = encodeManifest(fixture.rows, coverage);
  const etag = etagOf(body);
  let manifests = 0;
  let streams = 0;
  const wanted: number[][] = [];

  await page.route(
    (url) => url.pathname === "/api/controlplane/search-index/manifest",
    async (route) => {
      manifests += 1;
      const inm = (await route.request().allHeaders())["if-none-match"];
      if (inm === `"${etag}"`) {
        await route.fulfill({ status: 304, headers: { etag: `"${etag}"` } });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { etag: `"${etag}"` },
        body: Buffer.from(body),
      });
    },
  );

  await page.route(
    (url) => url.pathname === "/api/controlplane/search-index/stream",
    async (route) => {
      streams += 1;
      const params = new URL(route.request().url()).searchParams;
      if (params.get("m") !== etag) {
        await route.fulfill({ status: 412, contentType: "text/plain", body: "" });
        return;
      }
      const positions = decodeWant(params.get("want") ?? "", fixture.rows.length);
      wanted.push(positions);
      const docs = positions.flatMap((p) => {
        const row = fixture.rows[p];
        const doc = row ? fixture.documents[row.md5] : undefined;
        return doc ? [doc] : [];
      });
      // PLAIN, never `content-encoding: gzip` — see the header. Playwright
      // fulfils below Chromium's decoding pipeline, so a gzipped body would
      // reach `termsStream.ts` as gzip bytes and fail a fatal UTF-8 decode.
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson; charset=utf-8",
        body: encodeTermsStream(docs),
      });
    },
  );

  return {
    manifestHits: () => manifests,
    streamHits: () => streams,
    wanted: () => wanted.map((w) => [...w]),
  };
}
