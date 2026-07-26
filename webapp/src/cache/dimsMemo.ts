// Image-document dimensions memo — the CONTRACT between the gallery layout
// (which needs an image's aspect BEFORE any bytes arrive; docs/scratch/
// masonry.md decision 5) and the thumbnail facade (which learns the true dims
// the first time it decodes the image and records them here).
//
// Two layers, one surface:
//
//   session Map  — the read-through layer; a hash answered once this session
//                  is answered synchronously-cheap forever after (including
//                  negative answers, so a gallery repaint doesn't hammer IDB
//                  for images that were never decoded).
//   IndexedDB    — the persistent layer (`sn-dims`, see cache/idb.ts), which
//                  is what makes an image tile reflow-free on every SESSION
//                  after the first, not just every paint.
//
// Consumers must treat a null as "unknown yet" and fall back to a default
// aspect — the first-ever view of an image is allowed to reflow once. The memo
// is advisory, never a source of truth: any storage failure degrades to
// session-only behaviour (exactly the pre-persistence stub), never to an error.

import { openDimsStore } from "./idb";

export interface ImageDims {
  w: number;
  h: number;
}

/** The persistence seam, injectable so the memo is unit-testable without a
 *  real IndexedDB. The production backend is `openDimsStore()` (cache/idb.ts). */
export interface DimsBackend {
  get(hash: string): Promise<ImageDims | null>;
  put(hash: string, dims: ImageDims): Promise<void>;
}

export interface DimsMemo {
  getDims(hash: string): Promise<ImageDims | null>;
  setDims(hash: string, dims: ImageDims): Promise<void>;
}

/** Build a memo over an explicit backend — the testable factory behind the
 *  module-level `getDims`/`setDims` the layout and the facade import. */
export function createDimsMemo(backend: DimsBackend): DimsMemo {
  const session = new Map<string, ImageDims>();
  /** Hashes the backend answered null for THIS session — so repeated paints of
   *  a not-yet-decoded image cost one IDB read, not one per paint. Safe to hold:
   *  a later `setDims` seeds the session Map, which is checked first. */
  const misses = new Set<string>();

  return {
    async getDims(hash: string): Promise<ImageDims | null> {
      const hit = session.get(hash);
      if (hit) return hit;
      if (misses.has(hash)) return null;
      const stored = await backend.get(hash).catch(() => null);
      if (stored) session.set(hash, stored);
      else misses.add(hash);
      return stored;
    },

    async setDims(hash: string, dims: ImageDims): Promise<void> {
      // Overwrites are harmless (same content hash ⇒ same pixels ⇒ same dims).
      session.set(hash, dims);
      try {
        await backend.put(hash, dims);
      } catch {
        // Advisory memo: a failed persist degrades to session-only, silently.
      }
    },
  };
}

// The shared instance behind the module-level surface. Lazy so importing this
// module (unit tests, the layout's type-only imports) never touches IndexedDB;
// the first real call opens the store — which itself degrades to a no-op
// backend where IndexedDB is missing (Node, private-mode edge cases).
let shared: DimsMemo | null = null;
function memoInstance(): DimsMemo {
  return (shared ??= createDimsMemo(openDimsStore()));
}

/** True dims of an image document's bytes, keyed by its content hash (md5). */
export async function getDims(hash: string): Promise<ImageDims | null> {
  return memoInstance().getDims(hash);
}

/** Record dims after a successful decode. Overwrites are harmless (same content). */
export async function setDims(hash: string, dims: ImageDims): Promise<void> {
  return memoInstance().setDims(hash, dims);
}
