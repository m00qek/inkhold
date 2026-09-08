// WHICH documents' text the browser keeps ahead of time — `golden-search.md`
// §4.4's tiering, and the only place in the client that decides it.
//
//     manifest rows ──order──▶ tier 1, then tier 2 by updated_at
//                                  │
//                                  ├─ tier 1: kept, no budget check
//                                  └─ tier 2: kept until the budget is spent
//
// ## It is a CACHE, and the reason is LATENCY — not availability
//
// §4.4 was corrected on this and the file was renamed with it: it used to be
// `offlineText.ts` and it used to talk about a "promise". **Offline is a SIDE
// EFFECT of running the work in the browser, not a goal.** The server is a Pi
// 1 B+ with a ~50 MB budget and a modern client can carry an index it cannot
// (`client-server-balance.md` §0); that the text then happens to answer with the
// network down is the architecture showing through. Nobody promised it and
// nothing depends on it.
//
// What this prefetch actually buys is spelt out in §4.4 and is worth restating,
// because it is the whole justification for spending any bytes at all: **the
// first find in a document costs a fetch plus a build, and the build alone is
// 315 ms on the worst real document (§8.1)**. Prefetching removes the fetch from
// the documents most likely to be searched. That is a latency argument, it is
// bounded, and it is the only one being made.
//
// **The explicit "keep this offline" control is GONE**, and its removal is the
// same correction. Its only power was to override eviction, which is an
// availability guarantee — and one this project would have been lying about,
// since in-doc search cannot be more offline than the DOCUMENT is: with no
// network there are no `.note` pages to render and no PDF page ranges to display,
// so there was never a document on screen to search. A text-only "keep this
// offline" over-promised twice over — once by promising availability, and again
// by delivering only the half you cannot read.
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
// it costs storage and repeated bandwidth on every device: MEASURED, one `.mark`
// on Les Misérables moves 1,355,048 B of stored text into the cache from a single
// gesture — seven times the whole of tier 2 on the dev corpus. Hence a budget
// walked in tier order and a per-document cap (`textStore.ts` argues both
// numbers), so the failure mode is "the two oldest annotated books cost a fetch
// on their first find" and never "the household silently synced 40 MB".
//
// ## What is NOT here, deliberately
//
// **On-demand text is not stored by us.** A find on a tier-3 document fetches
// `text/<md5>` and the browser's HTTP cache keeps it — immutable, content
// addressed, no code (§4.4). `docSearch.ts` reads THIS store first and falls
// back to that fetch; it never writes here, because a store that filled itself
// from browsing would be a byte budget over the same bytes the browser is
// already budgeting, and it would have no ceiling of its own.
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
export interface PrefetchCandidate {
  readonly md5: string;
  readonly fileId: number;
  /** Never null — a row that cannot be keyed is not a candidate. */
  readonly indexVersion: number;
  /** Exempt from the budget and from eviction. Tier 1, and nothing else. */
  readonly protect: boolean;
}

/**
 * §4.4's rule as an ordering, which is all it is: tier 1, then tier 2 by
 * `updated_at` descending. Pure.
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
 * Tier 3 is absent entirely: that is the on-demand half, and the HTTP cache is
 * its story. There used to be a third group ahead of these two, holding whatever
 * had been pinned; the pin is gone (see the header) and so is the group.
 */
export function orderCandidates(rows: readonly ManifestRow[]): PrefetchCandidate[] {
  const notes: PrefetchCandidate[] = [];
  const marked: PrefetchCandidate[] = [];
  // Newest first within each group. §4.4 asks for it on tier 2; tier 1 gets the
  // same order so that a library too large for the origin's quota degrades by
  // dropping the OLDEST notes rather than by whatever order the server filled.
  const newestFirst = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const row of newestFirst) {
    const indexVersion = row.indexVersion;
    if (indexVersion === null || row.derivation !== "derived") continue;
    const { md5, fileId } = row;
    if (row.tier === "note") notes.push({ md5, fileId, indexVersion, protect: true });
    else if (row.tier === "marked") marked.push({ md5, fileId, indexVersion, protect: false });
  }
  return [...notes, ...marked];
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

export interface TextPrefetch {
  /** False where IndexedDB is not available: {@link prefetch} is then a no-op
   *  and in-document search simply fetches, which is §4.2's required path. */
  readonly available: boolean;
  /**
   * Run one pass over the manifest. Opportunistic and never a gate: it is called
   * after a sync completes, it fetches sequentially so it cannot crowd the link,
   * and it swallows a failed document rather than abandoning the pass.
   */
  prefetch(rows: readonly ManifestRow[], signal?: AbortSignal): Promise<PrefetchOutcome>;
}

export interface TextPrefetchOptions {
  /** Defaults to the real IndexedDB store. */
  store?: TextStore;
  /** How a text record is fetched. Injectable so tests need no network. */
  transport?: TextTransport;
}

export function createTextPrefetch(opts: TextPrefetchOptions = {}): TextPrefetch {
  const store = opts.store ?? openTextStore();
  const transport = opts.transport ?? httpTextTransport();
  /** Session-scoped: md5s fetched once and refused. See the header. */
  const refused = new Set<string>();
  let running: Promise<PrefetchOutcome> | null = null;

  async function fetchInto(candidate: PrefetchCandidate, signal?: AbortSignal): Promise<number> {
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

    const candidates = orderCandidates(rows);
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
        // Re-asserted every pass rather than trusted from when it was written.
        // It is also the MIGRATION off the pin: a record a previous build left
        // protected because somebody had pinned it is corrected here, and this
        // is the only thing that walks both the manifest and the held set.
        if (already.protect !== candidate.protect) {
          await store.setProtection(candidate.md5, candidate.indexVersion, candidate.protect);
        }
        kept += 1;
        bytes += already.size;
        continue;
      }
      if (refused.has(key)) continue;
      // The budget stops the WALK, not the store: tier 1 is kept whatever it says
      // (§4.4 keeps tier 1 "with no budget check"), and its bytes are still
      // counted so tier 2 gets only what is left over.
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
  };
}
