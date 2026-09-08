// SYNC — the search removal step 3: fetch the manifest, diff it against what
// is stored, ask for the difference as a bitmap, stream the answer into
// IndexedDB as it arrives.
//
//     manifest ──diff──▶ want bitmap ──▶ stitched gzip ──▶ JSONL ──▶ IndexedDB
//
// What this must not break:
//   * Nothing here may import anything that can reach `sqlite-core.wasm`
//     (§4.2). Instantiating the engine at sync time would pass every test and
//     bill every member who only browses 16 MB; the index is built on first
//     search instead (39 ms at tier 1).
//   * 412 is control flow (§3.3): the library moved between the manifest and
//     the stream. Refetch, re-diff, re-ask — bounded by `MANIFEST_ATTEMPTS`,
//     because a bitmap that does not fit the manifest is a client bug that
//     answers 412 identically for ever.
//   * A skipped document is normal, not an error (§3.3), so what is stored is
//     keyed on what ARRIVED — the record's own `md5` and `v` — never the
//     manifest row that asked for it.
//   * The manifest REPLACES; absence is the only deletion mechanism.

import { decodeManifest, type DocumentManifest, type ManifestRow } from "./manifestCodec";
import { encodeWant } from "./wantBitmap";
import { parseTermsJsonl, type TermsDocument } from "./termsStream";
import { httpTransport, type IndexTransport } from "./indexTransport";
import {
  openTermsStore,
  termsKeyOf,
  type TermsKey,
  type TermsStore,
  type StoredTermsDocument,
} from "../cache/termsStore";

/**
 * A sync that could not complete. Distinct from `SearchWireError` because the
 * reaction differs: this one wants the next trigger to retry, that one wants a
 * reload.
 */
export class IndexSyncError extends Error {
  override readonly name = "IndexSyncError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Three: the legitimate cause (a race the household loses at most once) is
 *  bounded, and the illegitimate one repeats identically for ever. */
const MANIFEST_ATTEMPTS = 3;

/** What one sync did. */
export interface SyncOutcome {
  /** The manifest the diff ran against — the caller's complete live document set. */
  readonly manifest: DocumentManifest;
  /** Its bare ETag, which is what `m=` carried. */
  readonly etag: string;
  /** Documents asked for. */
  readonly requested: number;
  /** Documents that arrived and were stored. */
  readonly received: number;
  /** Asked for and not delivered — expected, see the header. */
  readonly skipped: number;
  /** Local rows this manifest no longer names, deleted after the stream. */
  readonly dropped: number;
  /** False when IndexedDB degraded to a no-op: the work happened, nothing kept it. */
  readonly persisted: boolean;
}

export interface IndexSyncOptions {
  store?: TermsStore;
  transport?: IndexTransport;
}

export interface SyncRequest {
  signal?: AbortSignal;
  /** Called once per document as it is stored, in manifest order (tier order,
   *  priority order) and DURING the stream: the newest handwriting is usable
   *  at 8 ms of a 193 ms stream (§3.2). */
  onDocument?: (doc: TermsDocument) => void;
}

export interface IndexSync {
  /** The seam the engine half consumes. It knows nothing of manifests or streams. */
  readonly store: TermsStore;
  sync(req?: SyncRequest): Promise<SyncOutcome>;
  /** Every document held, for the index build on first search. */
  documents(): Promise<StoredTermsDocument[]>;
}

/** What one manifest, diffed against one local store, asks for. */
export interface IndexDiff {
  /** Manifest positions to set in the `want=` bitmap, ascending — straight
   *  into `encodeWant(diff.want, manifest.rows.length)`. */
  readonly want: readonly number[];
  /** Local rows this manifest does not name. Safe to delete: nothing
   *  downstream depends on it (§2.7 — the index is allowed to be a superset). */
  readonly stale: readonly TermsKey[];
  /** Manifest rows already held at the right version — the steady state. */
  readonly held: number;
  /** Rows with a null `indexVersion`: no `(md5, index_version)` to key on and
   *  no filename for the server to open, so never asked for. */
  readonly uncacheable: number;
}

/**
 * Diff a manifest against what is stored locally. Pure.
 *
 * `derivation` is deliberately NOT consulted: it is a cache of a fact whose
 * truth is the FILE (§2.4), and the two can disagree for a tick. Asking for a
 * document whose file is not there costs one bit and the server skips it;
 * not asking costs a whole manifest cycle. The only exclusion is having no
 * version to name a row by — and a null version also makes a held row STALE,
 * because a manifest that cannot supply one cannot vouch for what we hold.
 */
export function diffManifest(rows: readonly ManifestRow[], local: readonly TermsKey[]): IndexDiff {
  const localKeys = local.map((key) => termsKeyOf(key.md5, key.indexVersion));
  const held = new Set(localKeys);

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

  const stale = local.filter((_, i) => !live.has(localKeys[i]!));
  return { want, stale, held: alreadyHeld, uncacheable };
}

export function createIndexSync(opts: IndexSyncOptions = {}): IndexSync {
  const store = opts.store ?? openTermsStore();
  const transport = opts.transport ?? httpTransport();

  // The last manifest decoded, so the next sync is conditional: 27,663 bytes
  // and ~177 ms on the Pi against a bodiless 304 (§2.3). In memory only —
  // persisting it would be a second opinion about a fact the server
  // regenerates per request.
  let memo: { etag: string; manifest: DocumentManifest } | null = null;

  // ONE sync at a time: a concurrent call joins the one in flight rather than
  // opening a second stream. Debouncing the triggers is the caller's (§3.3).
  let inFlight: Promise<SyncOutcome> | null = null;

  async function loadManifest(
    conditional: boolean,
    signal: AbortSignal | undefined,
  ): Promise<{ etag: string; manifest: DocumentManifest }> {
    const answer = await transport.manifest(conditional ? (memo?.etag ?? null) : null, signal);
    if (answer.status === 304 && memo) return memo;
    if (answer.status !== 200 || !answer.body) {
      throw new IndexSyncError(`search manifest request answered ${answer.status}`, answer.status);
    }
    if (!answer.etag) {
      // Without a validator the stream request is a 400; sending it anyway
      // would surface as a manifest that "moved" on every attempt.
      throw new IndexSyncError("search manifest arrived without an ETag", answer.status);
    }
    memo = { etag: answer.etag, manifest: decodeManifest(answer.body) };
    return memo;
  }

  async function run(req: SyncRequest): Promise<SyncOutcome> {
    for (let attempt = 0; attempt < MANIFEST_ATTEMPTS; attempt += 1) {
      const { etag, manifest } = await loadManifest(attempt === 0, req.signal);
      const diff = diffManifest(manifest.rows, await store.keys());

      let received = 0;
      if (diff.want.length > 0) {
        const answer = await transport.stream(etag, encodeWant(diff.want, manifest.rows.length), req.signal);
        if (answer.status === 412) {
          // Drop the memo so the retry is UNCONDITIONAL: re-sending the stale
          // validator would ask whether the thing we know changed has changed.
          memo = null;
          continue;
        }
        if (answer.status !== 200 || !answer.chunks) {
          throw new IndexSyncError(`search index stream answered ${answer.status}`, answer.status);
        }
        for await (const doc of parseTermsJsonl(answer.chunks)) {
          // Stored before the next line is parsed: the memory cost of a sync
          // is one document, and a stream that dies half way leaves everything
          // before the tear on disk.
          await store.put(doc);
          received += 1;
          req.onDocument?.(doc);
        }
      }

      await store.drop(diff.stale);
      return {
        manifest,
        etag,
        requested: diff.want.length,
        received,
        skipped: diff.want.length - received,
        dropped: diff.stale.length,
        persisted: store.available,
      };
    }
    throw new IndexSyncError(
      `search manifest moved on ${MANIFEST_ATTEMPTS} consecutive attempts`,
      412,
    );
  }

  return {
    store,
    documents: () => store.all(),
    sync(req = {}) {
      if (inFlight) return inFlight;
      const p = run(req).finally(() => {
        inFlight = null;
      });
      inFlight = p;
      return p;
    },
  };
}
