// The negative-thumbnail memo — remembers, PERSISTENTLY, that a content hash
// has no server thumbnail (`GET /thumbnail/{hash}` → 404): a coverless `.note`,
// an `.spd` without an embedded preview.
//
// Why persistence is SAFE here and not a staleness bug: the endpoint is
// content-addressed. Setting a cover (or re-exporting an `.spd` with a
// thumbnail) changes the file's bytes, so the device syncs a NEW blob under a
// NEW hash — which is a natural memo miss that probes fresh. A recorded 404
// for the old hash can never become wrong; at worst it lingers for bytes
// nobody references anymore. This is what turns "one cheap 404 per md5 per
// SESSION" into "one per md5 EVER".
//
// Only DEFINITIVE misses (a real 404) are persisted. A transport failure or
// server error answers nothing about the content — callers record those with
// `noteTransientMiss`, which suppresses retries for THIS session only (the
// pre-persistence behavior) and never touches storage.
//
// Same two-layer shape as cache/dimsMemo.ts: a session Set in front (repaints
// cost zero IDB reads), a tiny IndexedDB store behind (`sn-nocover`, own DB —
// see idb.ts on why not a second store in an existing one). Failures degrade
// to session-only, silently: this memo is an optimization, never a gate the
// fallback path depends on.

import { openNoCoverStore } from "./idb";

/** The persistence seam, injectable so the memo is unit-testable without a
 *  real IndexedDB. The production backend is `openNoCoverStore()` (cache/idb.ts). */
export interface NoCoverBackend {
  has(hash: string): Promise<boolean>;
  put(hash: string): Promise<void>;
}

export interface CoverMemo {
  /** True when this hash is KNOWN to have no server thumbnail (persisted 404
   *  or a transient miss recorded this session). */
  hasNoCover(hash: string): Promise<boolean>;
  /** Record a definitive 404 — persisted across sessions (content-addressed,
   *  see the header for why that can never go stale). */
  setNoCover(hash: string): Promise<void>;
  /** Record a transport/server failure — session-only suppression, never
   *  persisted (it answers nothing about the content). */
  noteTransientMiss(hash: string): void;
}

/** Build a memo over an explicit backend — the testable factory behind the
 *  module-level functions the facade imports. */
export function createCoverMemo(backend: NoCoverBackend): CoverMemo {
  /** Hashes known no-cover this session (persisted hits read through here). */
  const session = new Set<string>();
  /** Hashes the backend answered "unknown" for this session — so a coverless
   *  library that predates persistence costs one IDB read per hash, not one
   *  per repaint. A later setNoCover seeds `session`, checked first. */
  const unknown = new Set<string>();

  return {
    async hasNoCover(hash: string): Promise<boolean> {
      if (session.has(hash)) return true;
      if (unknown.has(hash)) return false;
      const stored = await backend.has(hash).catch(() => false);
      if (stored) session.add(hash);
      else unknown.add(hash);
      return stored;
    },

    async setNoCover(hash: string): Promise<void> {
      session.add(hash);
      try {
        await backend.put(hash);
      } catch {
        // Advisory memo: a failed persist degrades to session-only, silently.
      }
    },

    noteTransientMiss(hash: string): void {
      session.add(hash); // suppresses retries this session; never persisted
    },
  };
}

// The shared instance behind the module-level surface. Lazy so importing this
// module never touches IndexedDB; the first real call opens the store — which
// itself degrades to a no-op backend where IndexedDB is missing.
let shared: CoverMemo | null = null;
function memoInstance(): CoverMemo {
  return (shared ??= createCoverMemo(openNoCoverStore()));
}

export async function hasNoCover(hash: string): Promise<boolean> {
  return memoInstance().hasNoCover(hash);
}

export async function setNoCover(hash: string): Promise<void> {
  return memoInstance().setNoCover(hash);
}

export function noteTransientMiss(hash: string): void {
  memoInstance().noteTransientMiss(hash);
}
