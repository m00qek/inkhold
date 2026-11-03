// Persistent memo of content hashes with no server thumbnail (a real 404).
// Safe to persist because the endpoint is content-addressed: a new cover
// means new bytes and a new hash. Transient failures are suppressed for the
// session only. Failures degrade silently to session-only.

import { openNoCoverStore } from "./idb";

/** Injectable for tests; production is `openNoCoverStore()`. */
export interface NoCoverBackend {
  has(hash: string): Promise<boolean>;
  put(hash: string): Promise<void>;
}

export interface CoverMemo {
  /** Known coverless: persisted 404 or a transient miss this session. */
  hasNoCover(hash: string): Promise<boolean>;
  /** A definitive 404, persisted. */
  setNoCover(hash: string): Promise<void>;
  /** Transport or server failure: session-only, never persisted. */
  noteTransientMiss(hash: string): void;
}

export function createCoverMemo(backend: NoCoverBackend): CoverMemo {
  const session = new Set<string>();
  /** Backend said "unknown" this session: one IDB read per hash, not per repaint. */
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
        // Advisory: degrade to session-only.
      }
    },

    noteTransientMiss(hash: string): void {
      session.add(hash);
    },
  };
}

// Lazy, so importing this module never touches IndexedDB.
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
