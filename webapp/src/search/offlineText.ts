// WHICH documents' text is promised offline — `golden-search.md` §4.4's tiering,
// and the only place in the client that decides it.
//
//     manifest rows ──order──▶ pinned, then tier 1, then tier 2 by updated_at
//                                  │
//                                  ├─ protected: kept, no budget check
//                                  └─ tier 2: kept until the budget is spent
//
// **In-doc search cannot be more offline than the DOCUMENT is** (§4.4). Offline
// there are no `.note` pages to render and no PDF page ranges to display, so
// there was never a document on screen to search; keeping text for a document
// that cannot be opened would be a promise about a screen nobody can reach. What
// this module keeps is therefore bounded by what the reading cache can plausibly
// show, and the explicit opt-in below is the seam through which a real "keep
// this available offline" — text AND blob, a DOCUMENT feature — would arrive.
//
// ## Tier, not file type, and the manifest is the only thing that knows
//
// The tiering is `.note` (tier 1), then anything with a `.mark` companion
// (tier 2), then everything else. Only the MANIFEST carries it: `manifestCodec`
// decodes `tier` per row, and the server computed it from the pairing it
// resolves. The listing's `fileType` cannot answer the tier-2 half at all — it
// says what a file IS, and "has somebody written on it" is a fact about a
// DIFFERENT file in the same folder (`NoteMeta.markId`, which only the open
// document carries). Deriving tier 2 from `fileType === "mark"` would keep the
// annotation and not the PDF it annotates, which is the file with the text.
//
// So this runs off manifest rows, which means it runs after a sync and not
// before. That is the right dependency anyway: §4.4 says the prefetch is
// opportunistic, runs AFTER the terms stream completes, and is never a gate on
// search being usable.
//
// ## `.mark` measures ENGAGEMENT, and that is why tier 2 is budgeted
//
// §3 tiers the TERMS the same way and says being wrong there costs a wait. Here
// it costs permanent storage and repeated bandwidth on every device: MEASURED,
// one `.mark` on Les Misérables moves 1,355,048 B of stored text into the
// always-offline set from a single gesture — seven times the whole of tier 2 on
// the dev corpus. Hence a budget walked in tier order and a per-document cap
// (`textStore.ts` argues both numbers), so the failure mode is "the two oldest
// annotated books are not offline" and never "the household silently synced
// 40 MB".
//
// ## What is NOT here, deliberately
//
// **On-demand text is not stored by us.** A find on a tier-3 document fetches
// `text/<md5>` and the browser's HTTP cache keeps it — immutable, content
// addressed, no code (§4.4). `docSearch.ts` reads THIS store first and falls
// back to that fetch; it never writes here, because a store that filled itself
// from browsing would be a byte budget over the same bytes the browser is
// already budgeting, with none of the promise that justifies this one.
//
// **A skipped document is not remembered across a reload.** Within a session an
// oversize tier-2 document is fetched once and then skipped by md5, so a burst of
// syncs does not re-fetch a novel; across a reload it is fetched again, and that
// re-fetch is served by the immutable HTTP cache in the ordinary case. Persisting
// the refusal would be a fourth store to invalidate on a version bump, to save a
// cache hit.

import {
  openTextStore,
  perDocumentCap,
  textKeyOf,
  weighText,
  type TextKey,
  type TextStore,
} from "../cache/textStore";
import { httpTextTransport, type TextTransport } from "./docText";
import type { ManifestRow } from "./manifestCodec";

/** One document the prefetch may keep, in the order it should be considered. */
export interface OfflineCandidate {
  readonly md5: string;
  readonly fileId: number;
  /** Never null — a row that cannot be keyed is not a candidate. */
  readonly indexVersion: number;
  /** Exempt from the budget and from eviction: tier 1, or pinned. */
  readonly protect: boolean;
}

/**
 * §4.4's rule as an ordering, which is all it is: pinned first, then tier 1,
 * then tier 2 by `updated_at` descending. Pure.
 *
 * Two whole classes of row are dropped before any of that:
 *
 *   * **no `indexVersion`** — the record cannot be keyed, and `manifestCodec`
 *     spells out that a null is "cannot be cached", never "version 0". Storing
 *     one under a guessed version is how a client comes to answer finds from
 *     text nobody is serving.
 *   * **not `derived`** — a `pending` or `unknown` blob has no file to fetch, so
 *     asking would spend a round trip to be told 404. The next sync retries for
 *     free, which is the same reason `manifestCodec` refuses to cache an empty
 *     term set under those states.
 *
 * Tier 3 is absent unless pinned: that is the on-demand half, and the HTTP cache
 * is its story.
 */
export function orderCandidates(
  rows: readonly ManifestRow[],
  pins: ReadonlySet<number>,
): OfflineCandidate[] {
  const pinned: OfflineCandidate[] = [];
  const notes: OfflineCandidate[] = [];
  const marked: OfflineCandidate[] = [];
  // Newest first within each group. §4.4 asks for it on tier 2; tier 1 gets the
  // same order so that a library too large for the origin's quota degrades by
  // dropping the OLDEST notes rather than by whatever order the server filled.
  const newestFirst = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const row of newestFirst) {
    const indexVersion = row.indexVersion;
    if (indexVersion === null || row.derivation !== "derived") continue;
    const { md5, fileId } = row;
    if (pins.has(fileId)) pinned.push({ md5, fileId, indexVersion, protect: true });
    else if (row.tier === "note") notes.push({ md5, fileId, indexVersion, protect: true });
    else if (row.tier === "marked") marked.push({ md5, fileId, indexVersion, protect: false });
  }
  return [...pinned, ...notes, ...marked];
}

/** What one pass did — for tests, and for anything that ever wants to say it. */
export interface PrefetchOutcome {
  /** Documents whose text is now held (including ones already held). */
  readonly kept: number;
  /** Fetched and refused: over the per-document cap, or past the budget. */
  readonly skipped: number;
  /** Held records the manifest no longer names, or at a version it moved past. */
  readonly dropped: number;
  /** Bytes the kept set weighs, by `weighText`. */
  readonly bytes: number;
}

/** How a document is named to the opt-in — what a UI control has in hand. */
export interface OfflineTarget {
  readonly md5: string;
  readonly fileId: number;
  /** From `searchService.indexVersion(md5)`. Null means "not syncable yet". */
  readonly indexVersion: number | null;
}

export interface OfflineText {
  /** False where IndexedDB is not available: every call below is then a no-op
   *  and in-document search simply fetches, which is §4.2's required path. */
  readonly available: boolean;
  /**
   * Run one pass over the manifest. Opportunistic and never a gate: it is called
   * after a sync completes, it fetches sequentially so it cannot crowd the link,
   * and it swallows a failed document rather than abandoning the pass.
   */
  prefetch(rows: readonly ManifestRow[], signal?: AbortSignal): Promise<PrefetchOutcome>;
  /** The explicit "make available offline": pin, fetch now, keep unconditionally.
   *  Returns false when there is nothing to key the record by. */
  keepOffline(target: OfflineTarget, signal?: AbortSignal): Promise<boolean>;
  /** Release the pin. The text stays until the budget wants the space back —
   *  it is a cache again, which is what un-promising means. */
  forget(target: OfflineTarget): Promise<void>;
  /** Whether this document's text is held AT THIS VERSION — the honest answer to
   *  "is this available offline?", which the HTTP cache cannot give. */
  isKept(md5: string, indexVersion: number | null): Promise<boolean>;
  /** `files.id` of everything explicitly kept. For a control's checked state. */
  pinned(): Promise<ReadonlySet<number>>;
}

export interface OfflineTextOptions {
  /** Defaults to the real IndexedDB store. */
  store?: TextStore;
  /** How a text record is fetched. Injectable so tests need no network. */
  transport?: TextTransport;
}

export function createOfflineText(opts: OfflineTextOptions = {}): OfflineText {
  const store = opts.store ?? openTextStore();
  const transport = opts.transport ?? httpTextTransport();
  /** Session-scoped: md5s fetched once and refused. See the header. */
  const refused = new Set<string>();
  let running: Promise<PrefetchOutcome> | null = null;

  async function fetchInto(candidate: OfflineCandidate, signal?: AbortSignal): Promise<number> {
    const doc = await transport(candidate.md5, candidate.indexVersion, signal);
    // The record's OWN version is what it is stored under, not the manifest's:
    // the same rule §3.3 states for the terms stream — key what ARRIVED. A
    // manifest that has moved since the request would otherwise file this
    // document's text under a version whose text it is not.
    await store.put(doc, { protect: candidate.protect });
    return weighText(doc);
  }

  async function pass(rows: readonly ManifestRow[], signal?: AbortSignal): Promise<PrefetchOutcome> {
    const empty: PrefetchOutcome = { kept: 0, skipped: 0, dropped: 0, bytes: 0 };
    if (!store.available || rows.length === 0) return empty;

    const pins = new Set(await store.pins());
    const candidates = orderCandidates(rows, pins);
    const wanted = new Map(candidates.map((c) => [textKeyOf(c.md5, c.indexVersion), c]));
    const held = await store.keys();

    // Clean-up, not a protocol step (§2.7) — but it runs FIRST, because a
    // superseded generation of a document occupies budget that its replacement
    // is about to need. Only ever under a manifest: an empty one is refused
    // above, since absence of evidence is not a deletion.
    const stale: TextKey[] = held
      .filter((h) => !wanted.has(textKeyOf(h.md5, h.indexVersion)))
      .map((h) => ({ md5: h.md5, indexVersion: h.indexVersion }));
    await store.drop(stale);

    const budget = await store.budget();
    const cap = perDocumentCap(budget);
    const heldNow = new Map(
      held
        .filter((h) => wanted.has(textKeyOf(h.md5, h.indexVersion)))
        .map((h) => [textKeyOf(h.md5, h.indexVersion), h]),
    );

    let kept = 0;
    let skipped = 0;
    let bytes = 0;
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      const key = textKeyOf(candidate.md5, candidate.indexVersion);
      const already = heldNow.get(key);
      if (already) {
        // Re-asserted every pass rather than trusted from when it was written: a
        // pin added or released since is exactly a change of protection on a
        // record already held, and this is the only thing that walks both.
        if (already.protect !== candidate.protect) {
          await store.setProtection(candidate.md5, candidate.indexVersion, candidate.protect);
        }
        kept += 1;
        bytes += already.size;
        continue;
      }
      if (refused.has(key)) continue;
      // The budget stops the WALK, not the store: tier 1 and pins are kept
      // whatever it says (§4.4 keeps tier 1 "with no budget check"), and their
      // bytes are still counted so tier 2 gets only what is left over.
      if (!candidate.protect && bytes >= budget) continue;
      try {
        const size = await fetchInto(candidate, signal);
        if (!candidate.protect && (size > cap || bytes + size > budget)) {
          // Fetched to be weighed, then refused: nothing on the wire says how
          // big a text record is before it arrives, and a HEAD per document
          // would be a round trip each on the link this app is built for. The
          // refusal is remembered for the session so the next sync does not
          // repeat it.
          await store.drop([{ md5: candidate.md5, indexVersion: candidate.indexVersion }]);
          refused.add(key);
          skipped += 1;
          continue;
        }
        kept += 1;
        bytes += size;
      } catch {
        // One document's failure is not the pass's: a 404 is `pending` racing
        // the manifest, and an abort or a dead link is retried by the next sync,
        // which is a device upload or a derive completing — both routine.
        if (signal?.aborted) break;
      }
    }
    return { kept, skipped, dropped: stale.length, bytes };
  }

  return {
    get available() {
      return store.available;
    },

    prefetch(rows, signal) {
      // ONE pass at a time. A second trigger arriving mid-pass would fetch the
      // same documents against the same budget and the two would race each other
      // over the eviction the first is about to cause.
      if (running) return running;
      const p = pass(rows, signal).finally(() => {
        running = null;
      });
      running = p;
      return p;
    },

    async keepOffline(target, signal) {
      // A document with no `indexVersion` cannot be keyed, so the pin would be a
      // promise with nothing behind it. The caller gets `false` and can say so.
      if (!store.available || target.indexVersion === null) return false;
      await store.pin(target.fileId);
      const key = textKeyOf(target.md5, target.indexVersion);
      refused.delete(key);
      try {
        await fetchInto(
          { md5: target.md5, fileId: target.fileId, indexVersion: target.indexVersion, protect: true },
          signal,
        );
        return true;
      } catch {
        // The pin survives a failed fetch on purpose: the intent is recorded, and
        // the next prefetch pass — after the next sync — makes good on it.
        return false;
      }
    },

    async forget(target) {
      if (!store.available) return;
      await store.unpin(target.fileId);
      if (target.indexVersion !== null) {
        await store.setProtection(target.md5, target.indexVersion, false);
      }
    },

    async isKept(md5, indexVersion) {
      if (!store.available || indexVersion === null) return false;
      const held = await store.keys();
      return held.some((h) => h.md5 === md5 && h.indexVersion === indexVersion);
    },

    async pinned() {
      return new Set(await store.pins());
    },
  };
}
