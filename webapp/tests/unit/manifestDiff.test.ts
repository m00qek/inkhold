import { describe, it, expect } from "vitest";
import { diffManifest } from "../../src/search/indexSync";
import type { ManifestRow } from "../../src/search/manifestCodec";
import type { TermsKey } from "../../src/cache/termsStore";

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
    // The bitmap is read against the server's row order, so positions must not shift.
    const rows = [row({ md5: A }), row({ md5: B }), row({ md5: C })];
    expect(diffManifest(rows, [key(A, 7), key(C, 7)]).want).toEqual([1]);
  });

  it("drops a local row the manifest no longer names — absence IS the deletion", () => {
    const diff = diffManifest([row({ md5: A })], [key(A, 7), key(B, 7)]);
    expect(diff.want).toEqual([]);
    expect(diff.stale).toEqual([key(B, 7)]);
  });

  it("treats an index_version bump as a fetch AND a drop of the old version", () => {
    // Same md5, new parser version: the old row must be dropped.
    const diff = diffManifest([row({ md5: A, indexVersion: 8 })], [key(A, 7)]);
    expect(diff.want).toEqual([0]);
    expect(diff.stale).toEqual([key(A, 7)]);
  });

  it("never asks for, and never keeps, a row whose indexVersion is null", () => {
    // A null version means not cacheable; the server would skip it anyway.
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
    // A `.note` writes its terms at ingest, so ask even before the derivation column says so.
    const rows = [row({ md5: A, derivation: "pending" }), row({ md5: B, derivation: "unknown" })];
    expect(diffManifest(rows, []).want).toEqual([0, 1]);
  });

  it("handles an empty manifest by dropping everything held", () => {
    const diff = diffManifest([], [key(A, 7), key(B, 3)]);
    expect(diff.want).toEqual([]);
    expect(diff.stale).toEqual([key(A, 7), key(B, 3)]);
  });
});
