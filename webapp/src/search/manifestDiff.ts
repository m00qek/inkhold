// The DIFF: a decoded manifest on one side, the `(md5, index_version)` pairs the
// browser already holds on the other, and out of it the two things sync needs —
// which manifest POSITIONS to ask for, and which local rows the manifest no
// longer names.
//
// Pure. No network, no IndexedDB, no wasm.
//
// ## The manifest REPLACES; it never merges
//
// `manifestCodec.ts` states the rule and this file is where it is enforced:
// sync is additive on the wire ("here are the positions I am missing"), nothing
// ever removes anything, and there are no tombstones. **Absence is the only
// deletion mechanism this design has.** A trashed, superseded or purged document
// stops matching because it is not in the next complete manifest — which is why
// that decoder checks `rowCount` and its trailing bytes before anything gets
// here: a truncated manifest would arrive as a shorter, well-formed answer, and
// this function would read every missing row as a deletion.
//
// ## A dropped row is a CLEAN-UP, not a protocol step
//
// §2.7 is explicit that purging is not a client protocol step: the local index
// is ALLOWED to be a superset, and correctness comes from intersecting hits with
// the live listing the app already holds. Nothing downstream may depend on
// `stale` having been applied. What it buys is bounded storage — an
// `index_version` bump orphans every row in the store, and without this the
// store would grow by a whole library per parser bump.
//
// ## Positions, not md5s
//
// The want set is manifest POSITIONS, because 200 md5s is a 6.6 KB URL and
// 1,222 positions are 204 base64url characters (`wantBitmap.ts`). A position is
// only meaningful against the exact row order the server emitted, which is what
// the ETag travelling beside it — and the 412 on a mismatch — makes structural.

import type { ManifestRow } from "./manifestCodec";
import { termsKeyOf, type TermsKey } from "../cache/termsStore";

/** What one manifest, diffed against one local store, asks for. */
export interface IndexDiff {
  /**
   * Manifest positions to set in the `want=` bitmap, ascending. Feed straight to
   * `encodeWant(diff.want, manifest.rows.length)`.
   */
  readonly want: readonly number[];
  /** Local rows this manifest does not name. Safe to delete; see the header. */
  readonly stale: readonly TermsKey[];
  /** Manifest rows already held at the right version — the steady state. */
  readonly held: number;
  /**
   * Rows the client CANNOT cache and therefore never asks for: `indexVersion`
   * is null, so there is no `(md5, index_version)` to key on and no filename for
   * the server to open. Counted rather than listed because the only thing worth
   * knowing about them is how much of the library is not yet searchable, which
   * is `Coverage`'s job to phrase.
   */
  readonly uncacheable: number;
}

/**
 * Diff a manifest against what is stored locally.
 *
 * **`derivation` is deliberately NOT consulted.** It is the manifest's cache of
 * a fact whose truth is the FILE (§2.4), and the two are allowed to disagree for
 * a tick — a `.note` writes its terms at ingest, outside the worker, and a crash
 * between the rename and the column update leaves a derived document reporting
 * `pending`. Asking for a document whose file is not there costs ONE BIT in the
 * bitmap and the server skips it (§3.3); not asking costs a whole manifest cycle
 * of a document that was ready. So the only thing that excludes a row is having
 * no version to name it by.
 *
 * A null `indexVersion` also makes a locally-held row STALE, which looks harsh
 * and is the conservative direction: the version is the half of the key that
 * says which parse produced those terms, and a manifest that cannot supply one
 * cannot vouch for the rows we hold. The worst case is one refetch after the
 * derive lands.
 */
export function diffManifest(rows: readonly ManifestRow[], local: readonly TermsKey[]): IndexDiff {
  const held = new Set<string>();
  for (const key of local) held.add(termsKeyOf(key.md5, key.indexVersion));

  const want: number[] = [];
  const live = new Set<string>();
  let alreadyHeld = 0;
  let uncacheable = 0;

  for (let position = 0; position < rows.length; position += 1) {
    const row = rows[position]!;
    if (row.indexVersion === null) {
      uncacheable += 1;
      continue;
    }
    const key = termsKeyOf(row.md5, row.indexVersion);
    live.add(key);
    if (held.has(key)) alreadyHeld += 1;
    else want.push(position);
  }

  const stale: TermsKey[] = [];
  for (const key of local) {
    if (!live.has(termsKeyOf(key.md5, key.indexVersion))) stale.push(key);
  }

  return { want, stale, held: alreadyHeld, uncacheable };
}
