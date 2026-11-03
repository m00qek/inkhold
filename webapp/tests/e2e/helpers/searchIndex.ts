import type { Page } from "@playwright/test";
import { noteTranscript, recognisedPages } from "./docText";

// Generates the search-index manifest and terms-stream routes from `api/fake.ts`'s
// documents. `encodeManifest` is pinned byte-for-byte to
// `backend/services/search/testdata/manifest_golden.bin` in
// `tests/unit/searchIndexFixture.test.ts`. The stream is served uncompressed:
// Playwright fulfils below Chromium's content-encoding, so a gzip body arrives as gzip.

// ---- manifest encoder (inverse of `src/search/manifestCodec.ts`) ----

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
  /** `files.id` as a number; `gallerySearch.ts` joins it as `String(doc.fileId)`. */
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
 * Write a manifest as `index_export.zig`'s `writeManifest` does. Rows must be
 * tier-grouped and descending by `updatedAt` within a tier: it travels as
 * `previous - current`, with an absolute anchor on each tier's first row.
 */
export function encodeManifest(
  rows: readonly FixtureManifestRow[],
  coverage: FixtureCoverage,
): Uint8Array {
  const out: number[] = [0x53, 0x4d, 0x41, 0x4e, 1]; // "SMAN", MANIFEST_FORMAT_VERSION
  // rowCount, u32 LE.
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

// ---- `want=` bitmap ----

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Decode `want=` into manifest positions (mirror of `src/search/wantBitmap.ts`; LSB-first).
 * Serves only the positions asked for, so "a second sync asks for nothing" is observable.
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

// ---- terms stream ----

/** One page's folded terms — a `{"p":…,"t":…}` line. */
export interface FixtureTermsPage {
  readonly p: number;
  readonly t: string;
}

/** One document's record: the header line plus every page line under it. */
export interface FixtureTermsDocument {
  readonly md5: string;
  /** The record's own `v`, half the store's cache key; not the manifest's `indexVersion`. */
  readonly indexVersion: number;
  /** `n`: the ADDRESS SPACE, not `pages.length`. */
  readonly pageCount: number;
  readonly pages: readonly FixtureTermsPage[];
}

/**
 * Fold text as `unicode61 remove_diacritics 2` does, for the fixtures' subset only:
 * Latin letters and digits, marks stripped via NFD, everything else a separator.
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

/** Derived from the same generator as the `text/<md5>` mock, so index and find agree. */
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

/** The stitched stream, as it reads after the browser inflates the real gzip members. */
export function encodeTermsStream(docs: readonly FixtureTermsDocument[]): string {
  return docs.map(encodeTermsRecord).join("");
}

// ---- routes ----

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
  /** Keyed by md5. A row with no record is skipped by the stream, as for a `pending` row. */
  readonly documents: Readonly<Record<string, FixtureTermsDocument>>;
}

/** A stable 32-hex ETag (FNV-1a, repeated), so a changed fixture changes `m=`. */
function etagOf(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").repeat(4);
}

/**
 * Register after `signedIn` (newest-first matching). Answers 304 to a matching
 * `if-none-match` and 412 to a stale `m=`, so the client's handling is exercised.
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
      // Plain, never `content-encoding: gzip`; see the header.
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
