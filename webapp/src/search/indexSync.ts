// Index sync: fetch the manifest, diff it against IndexedDB, request the
// difference as a want bitmap, and store the streamed terms as they arrive.
// Must not import anything that reaches `sqlite-core.wasm`: the index is built
// on first search, not at sync time.

import { decodeManifest, type DocumentManifest, type ManifestRow } from "./manifestCodec";
import { encodeWant } from "./wantBitmap";
import { parseTermsJsonl, type TermsDocument } from "./termsStream";
import { httpTransport, type IndexTransport } from "./indexTransport";
import { keepOrder, planKeep, rememberedSizes, rowKeys, type KeepPlan, type RememberedSizes } from "./termsBudget";
import {
  openTermsStore,
  termsKeyOf,
  weigh,
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
  /** Delivered and parsed, kept or not. */
  readonly received: number;
  /** Written to the store: what a rebuild of the index would see anew. */
  readonly stored: number;
  /** Asked for and not delivered: normal, the server skips missing files. */
  readonly skipped: number;
  readonly dropped: number;
  /**
   * The file ids whose terms don't fit this browser's budget (`termsBudget.ts`),
   * in keep order. Each copy of a file is its own id: it has its own name and place.
   */
  readonly leftOut: readonly number[];
  /** Held terms let go this sync to make room for documents kept first. */
  readonly letGo: number;
  /** False when IndexedDB degraded to a no-op: the work happened, nothing kept it. */
  readonly persisted: boolean;
}

export interface IndexSyncOptions {
  store?: TermsStore;
  transport?: IndexTransport;
  /** Sizes of terms weighed and let go; kept across visits by default. */
  sizes?: RememberedSizes;
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

/**
 * One sync's budget bookkeeping (`termsBudget.ts`), over the manifest it
 * planned against. It sees this tab's writes only: two tabs syncing at once
 * can hold more than the budget between them until either plans again.
 */
interface Keeper {
  /** The current plan: what is kept and what is left out. */
  plan(): KeepPlan;
  /**
   * Decides an arriving document before it is stored, so the store stays
   * within the budget even if the stream tears, and its size is known whether
   * or not the write succeeds. True: store it; what it pushes out is gone.
   */
  admit(doc: TermsDocument): Promise<boolean>;
  /** After `admit`: whether the write stuck. A failed one lowers the budget to what is held. */
  stored(doc: TermsDocument, ok: boolean): void;
  /**
   * After a whole stream: drops the old versions nothing replaced, plans
   * again, and lets go of whatever no longer fits (the budget shrank, say).
   */
  settle(): Promise<void>;
  /** Held records let go this sync. */
  letGo(): number;
  /** Writes the sizes weighed and not held, in one write. */
  remember(): void;
}

/**
 * `replaced`: held older versions of documents the manifest still names. Each
 * stays, and holds its room, until its own new version is stored, so a torn
 * stream never leaves a document with neither.
 */
async function keepWithin(
  rows: readonly ManifestRow[],
  store: TermsStore,
  remembered: RememberedSizes,
  replaced: readonly TermsKey[],
): Promise<Keeper> {
  let budget = await store.budget();
  const order = keepOrder(rows);
  const keys = rowKeys(rows);
  const planned = new Set(keys.filter((key): key is string => key !== null));
  /** What each held record weighs; kept current as records come and go. */
  const held = new Map(await store.sizes());
  /** Weighed this sync and not held: remembered at the end, known at once. */
  const weighed = new Map<string, number>();
  const sizeOf = (key: string) => held.get(key) ?? weighed.get(key) ?? remembered.get(key);
  /** Old versions still held, by md5: the plan counts their room until they go. */
  const old = new Map<string, TermsKey[]>();
  for (const key of replaced) {
    if (!held.has(termsKeyOf(key.md5, key.indexVersion))) continue;
    old.set(key.md5, [...(old.get(key.md5) ?? []), key]);
  }
  const oldBytes = (md5: string) =>
    (old.get(md5) ?? []).reduce((n, k) => n + (held.get(termsKeyOf(k.md5, k.indexVersion)) ?? 0), 0);
  let pendingOld = 0;
  for (const md5 of old.keys()) pendingOld += oldBytes(md5);
  const replan = () => (plan = planKeep(rows, sizeOf, budget - pendingOld, order, keys));
  const letGo = new Set<string>();
  let plan = planKeep(rows, sizeOf, budget - pendingOld, order, keys);

  /** Drops a document's old versions: its new one replaces them. */
  async function dropOld(md5: string): Promise<void> {
    const versions = old.get(md5);
    if (!versions) return;
    pendingOld -= oldBytes(md5);
    old.delete(md5);
    await store.drop(versions);
    for (const k of versions) held.delete(termsKeyOf(k.md5, k.indexVersion));
  }

  /** Lets go of every held record the plan no longer keeps, remembering its size. */
  async function release(): Promise<void> {
    for (const position of plan.leftOut) {
      const key = keys[position]!;
      const size = held.get(key);
      if (size === undefined || plan.keptKeys.has(key)) continue;
      await store.drop([{ md5: rows[position]!.md5, indexVersion: rows[position]!.indexVersion! }]);
      held.delete(key);
      letGo.add(key);
      weighed.set(key, size);
    }
  }

  return {
    plan: () => plan,

    async admit(doc) {
      const key = termsKeyOf(doc.md5, doc.indexVersion);
      const size = weigh(doc);
      // A key the manifest doesn't name (it moved on mid-stream) is stored
      // unbudgeted, as it arrived: the next sync's diff drops it as stale.
      if (planned.has(key)) {
        // Planned as if its old version were gone already: the new one takes its room.
        const freed = oldBytes(doc.md5);
        pendingOld -= freed;
        held.set(key, size);
        replan();
        if (!plan.keptKeys.has(key)) {
          held.delete(key);
          weighed.set(key, size);
          pendingOld += freed;
          replan();
          return false;
        }
        // What it pushes out goes first, its own old version included, so the
        // store never holds more than the budget.
        pendingOld += freed;
        await dropOld(doc.md5);
        await release();
      }
      return true;
    },

    stored(doc, ok) {
      const key = termsKeyOf(doc.md5, doc.indexVersion);
      if (ok) {
        held.set(key, weigh(doc));
        return;
      }
      // The quota ran out: plan the rest of this sync, as the store will the
      // next, with what it really holds.
      held.delete(key);
      if (planned.has(key)) weighed.set(key, weigh(doc));
      let total = 0;
      for (const size of held.values()) total += size;
      budget = Math.min(budget, total);
      replan();
    },

    async settle() {
      for (const md5 of [...old.keys()]) await dropOld(md5);
      replan();
      await release();
    },

    letGo: () => letGo.size,

    remember() {
      if (weighed.size > 0) remembered.set(weighed);
    },
  };
}

export function createIndexSync(opts: IndexSyncOptions = {}): IndexSync {
  const store = opts.store ?? openTermsStore();
  const transport = opts.transport ?? httpTransport();
  const remembered = opts.sizes ?? rememberedSizes();

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
      // Deleted files' records go first. Older versions of documents still
      // live stay until their new version replaces them (`keepWithin`).
      const live = new Set(manifest.rows.map((row) => row.md5));
      const gone = diff.stale.filter((key) => !live.has(key.md5));
      const replaced = diff.stale.filter((key) => live.has(key.md5));
      await store.drop(gone);
      const keeper = await keepWithin(manifest.rows, store, remembered, replaced);
      const want = diff.want.filter((position) => keeper.plan().keep.has(position));

      let received = 0;
      let stored = 0;
      try {
        if (want.length > 0) {
          const answer = await transport.stream(etag, encodeWant(want, manifest.rows.length), req.signal);
          if (answer.status === 412) {
            // Drop the memo so the retry is unconditional.
            memo = null;
            continue;
          }
          if (answer.status !== 200 || !answer.chunks) {
            throw new IndexSyncError(`search index stream answered ${answer.status}`, answer.status);
          }
          for await (const doc of parseTermsJsonl(answer.chunks)) {
            received += 1;
            if (!(await keeper.admit(doc))) continue;
            // Stored before the next line is parsed: memory stays at one
            // document, and a torn stream keeps what arrived.
            const ok = await store.put(doc);
            keeper.stored(doc, ok);
            if (!ok) continue;
            stored += 1;
            req.onDocument?.(doc);
          }
        }

        // Held records the plan never kept (the budget shrank, say) go too.
        await keeper.settle();
      } finally {
        keeper.remember();
      }

      return {
        manifest,
        etag,
        requested: want.length,
        received,
        stored,
        skipped: want.length - received,
        dropped: diff.stale.length,
        leftOut: keeper.plan().leftOut.map((position) => manifest.rows[position]!.fileId),
        letGo: keeper.letGo(),
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
