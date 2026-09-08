import { describe, it, expect } from "vitest";
import { diffManifest } from "../../src/search/manifestDiff";
import type { ManifestRow } from "../../src/search/manifestCodec";
import type { TermsKey } from "../../src/cache/termsStore";

// The diff is where `manifestCodec.ts`'s central rule is actually applied — the
// manifest REPLACES the local set, and absence is the only deletion mechanism
// the design has. These tests are written against that sentence rather than
// against the implementation: a row that is gone must produce a drop, a row at a
// new version must produce both a fetch AND a drop, and a row with no version to
// key on must produce neither a fetch nor a cache entry.

const row = (over: Partial<ManifestRow> & Pick<ManifestRow, "md5">): ManifestRow => ({
  fileId: 1,
  tier: "note",
  updatedAt: 1_700_000_000,
  indexVersion: 7,
  derivation: "derived",
  ...over,
});

const key = (md5: string, indexVersion: number): TermsKey => ({ md5, indexVersion });

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";
const C = "00112233445566778899aabbccddeeff";

describe("diffManifest", () => {
  it("asks for every position it does not already hold", () => {
    const diff = diffManifest([row({ md5: A }), row({ md5: B }), row({ md5: C })], []);
    expect(diff.want).toEqual([0, 1, 2]);
    expect(diff.held).toBe(0);
    expect(diff.stale).toEqual([]);
  });

  it("asks for nothing when every row is held at the version the manifest names", () => {
    const rows = [row({ md5: A }), row({ md5: B })];
    const diff = diffManifest(rows, [key(A, 7), key(B, 7)]);
    expect(diff.want).toEqual([]);
    expect(diff.held).toBe(2);
    expect(diff.stale).toEqual([]);
  });

  it("names POSITIONS, not row order among the wanted ones", () => {
    // The bitmap is read against the server's own row order, so position 1 must
    // stay position 1 when 0 and 2 are already held. Getting this wrong produces
    // a perfectly valid bitmap naming the wrong documents and no error anywhere.
    const rows = [row({ md5: A }), row({ md5: B }), row({ md5: C })];
    expect(diffManifest(rows, [key(A, 7), key(C, 7)]).want).toEqual([1]);
  });

  it("drops a local row the manifest no longer names — absence IS the deletion", () => {
    // B was trashed. Nothing on the wire says so; it is simply not in the next
    // complete manifest.
    const diff = diffManifest([row({ md5: A })], [key(A, 7), key(B, 7)]);
    expect(diff.want).toEqual([]);
    expect(diff.stale).toEqual([key(B, 7)]);
  });

  it("treats an index_version bump as a fetch AND a drop of the old version", () => {
    // The md5 is unchanged — the blob is the same bytes — but a new parser
    // produced different terms, which is the whole reason the version is half
    // the key. Keeping the old row would leave the document indexed twice.
    const diff = diffManifest([row({ md5: A, indexVersion: 8 })], [key(A, 7)]);
    expect(diff.want).toEqual([0]);
    expect(diff.stale).toEqual([key(A, 7)]);
  });

  it("never asks for, and never keeps, a row whose indexVersion is null", () => {
    // `manifestCodec.ts`: a null here means the entry CANNOT BE CACHED, not that
    // the version is 0. There is no filename for the server to open either, so
    // `index_stream.zig` would skip it anyway — asking would be a wasted bit and
    // caching it under the md5 alone is the mistake the field exists to prevent.
    const rows = [row({ md5: A }), row({ md5: B, indexVersion: null, derivation: "pending" })];
    const diff = diffManifest(rows, [key(A, 7), key(B, 7)]);
    expect(diff.want).toEqual([]);
    expect(diff.uncacheable).toBe(1);
    expect(diff.stale).toEqual([key(B, 7)]);
  });

  it("keeps zero apart from null — 0 is a real index version", () => {
    const diff = diffManifest([row({ md5: A, indexVersion: 0 })], [key(A, 0)]);
    expect(diff.want).toEqual([]);
    expect(diff.held).toBe(1);
    expect(diff.stale).toEqual([]);
    expect(diff.uncacheable).toBe(0);
  });

  it("asks for a pending row all the same — the FILE is the fact, not the column", () => {
    // §2.4: a `.note` writes its terms at ingest, outside the worker, and the
    // manifest's derivation column is that fact's cache. Asking costs one bit
    // and the server skips it if it really is not there; not asking costs a
    // whole manifest cycle for a document that was ready.
    const rows = [row({ md5: A, derivation: "pending" }), row({ md5: B, derivation: "unknown" })];
    expect(diffManifest(rows, []).want).toEqual([0, 1]);
  });

  it("handles an empty manifest by dropping everything held", () => {
    const diff = diffManifest([], [key(A, 7), key(B, 3)]);
    expect(diff.want).toEqual([]);
    expect(diff.stale).toEqual([key(A, 7), key(B, 3)]);
  });
});
