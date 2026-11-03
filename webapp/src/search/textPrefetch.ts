// Which documents' text the browser keeps ahead of time, so the first find
// skips the fetch. Tier 1 (notes) is always kept; tier 2 (marked documents)
// until the byte budget is spent. Tier comes from the manifest only.

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

export interface PrefetchCandidate {
  readonly md5: string;
  readonly fileId: number;
  readonly indexVersion: number;
  /** Tier 1: exempt from the budget and from eviction. */
  readonly protect: boolean;
}

/**
 * Tier 1, then tier 2, newest first. Drops rows with no `indexVersion` (no key)
 * and rows not `derived` (no file yet). Tier 3 is on-demand only.
 */
export function orderCandidates(rows: readonly ManifestRow[]): PrefetchCandidate[] {
  const notes: PrefetchCandidate[] = [];
  const marked: PrefetchCandidate[] = [];
  // Newest first, so a library over quota loses its oldest notes.
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

export interface PrefetchOutcome {
  readonly kept: number;
  /** Fetched and refused: over the per-document cap or the budget. */
  readonly skipped: number;
  readonly dropped: number;
  readonly bytes: number;
}

export interface TextPrefetch {
  /** False without IndexedDB; in-document search then simply fetches. */
  readonly available: boolean;
  /** Opportunistic: sequential fetches, and a failed document does not abandon the pass. */
  prefetch(rows: readonly ManifestRow[], signal?: AbortSignal): Promise<PrefetchOutcome>;
}

export interface TextPrefetchOptions {
  store?: TextStore;
  transport?: TextTransport;
}

export function createTextPrefetch(opts: TextPrefetchOptions = {}): TextPrefetch {
  const store = opts.store ?? openTextStore();
  const transport = opts.transport ?? httpTextTransport();
  /** Fetched once and refused, for this session. */
  const refused = new Set<string>();
  let running: Promise<PrefetchOutcome> | null = null;

  async function fetchInto(candidate: PrefetchCandidate, signal?: AbortSignal): Promise<number> {
    const doc = await transport(candidate.md5, candidate.indexVersion, signal);
    // Stored under the record's own version, not the manifest's.
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
    // Clean-up first: a superseded generation holds budget its replacement needs.
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
        // Re-asserted every pass, correcting records an older build left protected.
        if (already.protect !== candidate.protect) {
          await store.setProtection(candidate.md5, candidate.indexVersion, candidate.protect);
        }
        kept += 1;
        bytes += already.size;
        continue;
      }
      if (refused.has(key)) continue;
      // Tier 1 is kept regardless, but its bytes count against tier 2's budget.
      if (!candidate.protect && bytes >= budget) continue;
      try {
        const size = await fetchInto(candidate, signal);
        if (!candidate.protect && (size > cap || bytes + size > budget)) {
          // Fetched to be weighed: nothing says a record's size up front.
          await store.drop([{ md5: candidate.md5, indexVersion: candidate.indexVersion }]);
          refused.add(key);
          skipped += 1;
          continue;
        }
        kept += 1;
        bytes += size;
      } catch {
        // A 404 is `pending` racing the manifest; the next sync retries.
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
      // One pass at a time; two would race over the same eviction.
      if (running) return running;
      const p = pass(rows, signal).finally(() => {
        running = null;
      });
      running = p;
      return p;
    },
  };
}
