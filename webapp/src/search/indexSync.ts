// Index sync: fetch the manifest, diff it against IndexedDB, request the
// difference as a want bitmap, and store the streamed terms as they arrive.
// Must not import anything that reaches `sqlite-core.wasm`: the index is built
// on first search, not at sync time.

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

/** A sync that could not complete; retry on the next trigger (unlike `SearchWireError`). */
export class IndexSyncError extends Error {
  override readonly name = "IndexSyncError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A 412 race is lost at most once; a bitmap that never fits is a client bug that repeats forever. */
const MANIFEST_ATTEMPTS = 3;

export interface SyncOutcome {
  readonly manifest: DocumentManifest;
  /** The bare ETag `m=` carried. */
  readonly etag: string;
  readonly requested: number;
  readonly received: number;
  /** Asked for and not delivered: normal, the server skips missing files. */
  readonly skipped: number;
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
  /** Called per stored document, in manifest order, during the stream. */
  onDocument?: (doc: TermsDocument) => void;
}

export interface IndexSync {
  readonly store: TermsStore;
  sync(req?: SyncRequest): Promise<SyncOutcome>;
  documents(): Promise<StoredTermsDocument[]>;
}

export interface IndexDiff {
  /** Manifest positions for the `want=` bitmap, ascending. */
  readonly want: readonly number[];
  /** Local rows the manifest does not name; safe to delete, the index may be a superset. */
  readonly stale: readonly TermsKey[];
  readonly held: number;
  /** Rows with a null `indexVersion`: no key to cache under, so never asked for. */
  readonly uncacheable: number;
}

/**
 * Pure. `derivation` is deliberately ignored: it can lag the file by a tick,
 * and asking for a missing document costs one bit while not asking costs a
 * manifest cycle. A null version also makes a held row stale.
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

  // In memory only, for a conditional (304) refetch.
  let memo: { etag: string; manifest: DocumentManifest } | null = null;

  // One sync at a time; a concurrent call joins. Debouncing is the caller's.
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
      // Without a validator the stream request is a 400.
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
          // Drop the memo so the retry is unconditional.
          memo = null;
          continue;
        }
        if (answer.status !== 200 || !answer.chunks) {
          throw new IndexSyncError(`search index stream answered ${answer.status}`, answer.status);
        }
        for await (const doc of parseTermsJsonl(answer.chunks)) {
          // Stored before the next line is parsed: memory stays at one
          // document, and a torn stream keeps what arrived.
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
