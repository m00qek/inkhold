// WHICH documents' text the browser keeps ahead of time
// §4.4's tiering, and the only place in the client that decides it.
//
//     manifest rows ──order──▶ tier 1, then tier 2 by updated_at
//                                  ├─ tier 1: kept, no budget check
//                                  └─ tier 2: kept until the budget is spent
//
// What this must not break:
//   * It is a CACHE for LATENCY, not availability: the first find in a document
//     costs a fetch plus a build (315 ms on the worst real document, §8.1), and
//     prefetching removes the fetch. Offline is a side effect nobody promised.
//   * Tier comes from the MANIFEST only. The listing's `fileType` cannot answer
//     tier 2 — "has somebody written on it" is a fact about a DIFFERENT file
//     (`NoteMeta.markId`), and `fileType === "mark"` would keep the annotation
//     instead of the PDF that has the text. So this runs after a sync.
//   * Tier 2 is budgeted because `.mark` measures ENGAGEMENT: one `.mark` on
//     Les Misérables moves 1,355,048 B into the cache from a single gesture —
//     seven times the whole of tier 2 on the dev corpus.
//   * On-demand text is never stored here (the HTTP cache is its story), and a
//     refused document is remembered for the session only.

import {
  openTextStore,
  perDocumentCap,
  textKeyOf,
  weighText,
  type HeldText,
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
 * §4.4's rule as an ordering: tier 1, then tier 2 by `updated_at` descending.
 * Pure. Dropped first: rows with no `indexVersion` (cannot be keyed — storing
 * one under a guessed version answers finds from text nobody is serving) and
 * rows not `derived` (no file to fetch; asking spends a round trip on a 404).
 * Tier 3 is the on-demand half and is absent.
 */
export function orderCandidates(rows: readonly ManifestRow[]): PrefetchCandidate[] {
  const notes: PrefetchCandidate[] = [];
  const marked: PrefetchCandidate[] = [];
  // Newest first in both groups, so a library too large for the origin's
  // quota degrades by dropping the OLDEST notes.
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
   *  and in-document search simply fetches. */
  readonly available: boolean;
  /** Run one pass over the manifest. Opportunistic and never a gate: fetches
   *  sequentially so it cannot crowd the link, and swallows a failed document
   *  rather than abandoning the pass. */
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
  /** Session-scoped: md5s fetched once and refused. */
  const refused = new Set<string>();
  let running: Promise<PrefetchOutcome> | null = null;

  async function fetchInto(candidate: PrefetchCandidate, signal?: AbortSignal): Promise<number> {
    const doc = await transport(candidate.md5, candidate.indexVersion, signal);
    // Stored under the record's OWN version (§3.3: key what ARRIVED), not the
    // manifest's, which may have moved since the request.
    await store.put(doc, { protect: candidate.protect });
    return weighText(doc);
  }

  async function pass(rows: readonly ManifestRow[], signal?: AbortSignal): Promise<PrefetchOutcome> {
    const empty: PrefetchOutcome = { kept: 0, skipped: 0, dropped: 0, bytes: 0 };
    if (!store.available || rows.length === 0) return empty;

    const candidates = orderCandidates(rows);
    const wanted = new Map(candidates.map((c) => [textKeyOf(c.md5, c.indexVersion), c]));
    const heldNow = new Map<string, HeldText>();
    const stale: TextKey[] = [];
    for (const h of await store.keys()) {
      const key = textKeyOf(h.md5, h.indexVersion);
      if (wanted.has(key)) heldNow.set(key, h);
      else stale.push({ md5: h.md5, indexVersion: h.indexVersion });
    }
    // Clean-up runs FIRST: a superseded generation occupies budget its
    // replacement is about to need. Only ever under a manifest (an empty one
    // returned above) — absence of evidence is not a deletion.
    await store.drop(stale);

    const budget = await store.budget();
    const cap = perDocumentCap(budget);

    let kept = 0;
    let skipped = 0;
    let bytes = 0;
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      const key = textKeyOf(candidate.md5, candidate.indexVersion);
      const already = heldNow.get(key);
      if (already) {
        // Re-asserted every pass. This is also the MIGRATION off the old pin
        // store: a record a previous build left protected is corrected here,
        // the only place that walks both the manifest and the held set.
        if (already.protect !== candidate.protect) {
          await store.setProtection(candidate.md5, candidate.indexVersion, candidate.protect);
        }
        kept += 1;
        bytes += already.size;
        continue;
      }
      if (refused.has(key)) continue;
      // The budget stops the WALK, not the store: tier 1 is kept whatever it
      // says, and its bytes still count so tier 2 gets only what is left.
      if (!candidate.protect && bytes >= budget) continue;
      try {
        const size = await fetchInto(candidate, signal);
        if (!candidate.protect && (size > cap || bytes + size > budget)) {
          // Fetched to be weighed, then refused: nothing on the wire says how
          // big a text record is, and a HEAD per document is a round trip
          // each on 3G.
          await store.drop([{ md5: candidate.md5, indexVersion: candidate.indexVersion }]);
          refused.add(key);
          skipped += 1;
          continue;
        }
        kept += 1;
        bytes += size;
      } catch {
        // One document's failure is not the pass's: a 404 is `pending` racing
        // the manifest, and the next sync retries.
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
      // ONE pass at a time: two would race each other over the eviction the
      // first is about to cause.
      if (running) return running;
      const p = pass(rows, signal).finally(() => {
        running = null;
      });
      running = p;
      return p;
    },
  };
}
