// SYNC — `golden-search.md` §6 step 3's first half: fetch the manifest, diff it
// against what is stored, ask for the difference as a bitmap, and stream the
// answer into IndexedDB as it arrives.
//
//     manifest ──diff──▶ want bitmap ──▶ stitched gzip ──▶ JSONL ──▶ IndexedDB
//
// **Nothing here touches wasm, and that is a requirement rather than a
// coincidence** (§4.2). Two rules collide: the engine is downloaded on the first
// visit because the download is decided by the first-visit budget, and a user
// who never searches must never pay the 17.4 MB of linear memory
// `WebAssembly.instantiate` allocates. The resolution is this file — rows go to
// disk with no engine in the process, and the FTS index is built on first search
// (39 ms at tier 1, MEASURED). An implementation that instantiated the engine
// here would work, pass every test, and bill every household member who only
// ever browses. So `indexSync.ts` may not import anything that can reach
// `sqlite-core.wasm`.
//
// This module is NOT wired to the search box (§6 step 3 says so): it is additive
// and inert, and the engine half consumes `TermsStore` without knowing any of
// the above happened.
//
// ## 412 is control flow, not an error
//
// A bitmap position means nothing except against the exact row order the server
// emitted, so the ETag travels beside it and a mismatch is refused (§3.3). The
// household edits its library while a sync is in flight and the answer is a 412;
// the client refetches the manifest, re-diffs and re-asks, and that is the
// system working. It is bounded — see `MANIFEST_ATTEMPTS` — because the same
// status also answers a bitmap that does not fit the manifest, which is a client
// bug and would otherwise spin.
//
// ## A skipped document is normal, and is not an error either
//
// Between the manifest query and the walk a blob can be GC'd, or a derive can
// still be outstanding, so the server SKIPS a document rather than erroring —
// an error mid-stream would poison a stitched gzip for every document that had
// nothing wrong with it (§3.3). **So what is stored is keyed on what ARRIVED**:
// the record's own `md5` and `v`, never the manifest row that asked for it. A
// skipped document is simply still missing at the next manifest and is asked for
// again. `SyncOutcome.skipped` is arithmetic for the caller's benefit and
// nothing branches on it.

import { decodeManifest, type DocumentManifest } from "./manifestCodec";
import { diffManifest } from "./manifestDiff";
import { encodeWant } from "./wantBitmap";
import { parseTermsJsonl, type TermsDocument } from "./termsStream";
import { httpTransport, type IndexTransport } from "./indexTransport";
import { openTermsStore, type TermsStore, type StoredTermsDocument } from "../cache/termsStore";

/**
 * A sync that could not complete. Distinct from `SearchWireError` (a payload
 * this build cannot read) because the reaction differs: this one wants the next
 * trigger to try again, that one wants a reload.
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

/**
 * How many times a 412 may send us back for a fresh manifest.
 *
 * Three, because the legitimate cause — the library changing between the
 * manifest query and the stream request — is a race a household loses at most
 * once. The illegitimate cause is a bitmap the server reads as not fitting its
 * manifest, which is a bug on one side or the other and repeats identically for
 * ever; an unbounded retry would turn it into a request loop against a Pi.
 */
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
  /**
   * Called once per document as it is stored, in manifest order — which is tier
   * order, which is priority order (§3.3). It fires DURING the stream, not after
   * it, which is the whole point of the format: the household's newest
   * handwriting is usable at 8 ms of a 193 ms stream.
   */
  onDocument?: (doc: TermsDocument) => void;
}

export interface IndexSync {
  /** The seam the engine half consumes. It knows nothing of manifests or streams. */
  readonly store: TermsStore;
  sync(req?: SyncRequest): Promise<SyncOutcome>;
  /** Every document held, for the index build on first search. */
  documents(): Promise<StoredTermsDocument[]>;
}

export function createIndexSync(opts: IndexSyncOptions = {}): IndexSync {
  const store = opts.store ?? openTermsStore();
  const transport = opts.transport ?? httpTransport();

  // The manifest we last decoded, so the next sync is a conditional request:
  // 27,663 bytes for 1,222 documents and a ~177 ms query on the Pi, against a
  // 304 with no body when the library has not changed (§2.3). Held in memory
  // only — persisting it would be a second opinion about a fact the server
  // regenerates per request.
  let memo: { etag: string; manifest: DocumentManifest } | null = null;

  // ONE sync at a time. §3.3 requires the two refetch triggers — `event: index`
  // and "the file listing changed" — to be coalesced, because a device syncing
  // 100 notes must not become a hundred manifest requests. Debouncing the
  // triggers is the caller's; making a concurrent call join the one in flight
  // rather than open a second stream is ours.
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
      // Without a validator there is nothing to put in `m=`, and a stream
      // request without one is a 400. Refusing here names the cause; sending it
      // anyway would surface as a manifest that "moved" on every attempt.
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
          // The manifest moved under us. Drop the memo so the retry is
          // UNCONDITIONAL: re-sending the stale validator would be asking the
          // server whether the thing we already know changed has changed.
          memo = null;
          continue;
        }
        if (answer.status !== 200 || !answer.chunks) {
          throw new IndexSyncError(`search index stream answered ${answer.status}`, answer.status);
        }
        for await (const doc of parseTermsJsonl(answer.chunks)) {
          // Stored one at a time, before the next line is even parsed: the
          // memory cost of a sync is one document, not one library, and a stream
          // that dies half way leaves everything before the tear on disk.
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
