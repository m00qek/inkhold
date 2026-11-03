// Image dimensions memo: the gallery layout needs an image's aspect before its
// bytes arrive; the thumbnail facade records true dims on first decode. A
// session Map (negatives included) over the `sn-dims` store. Null means
// "unknown yet": the first view may reflow once.

import { openDimsStore } from "./idb";

export interface ImageDims {
  w: number;
  h: number;
}

/** Injectable for tests; production is `openDimsStore()`. */
export interface DimsBackend {
  get(hash: string): Promise<ImageDims | null>;
  put(hash: string, dims: ImageDims): Promise<void>;
}

export interface DimsMemo {
  getDims(hash: string): Promise<ImageDims | null>;
  setDims(hash: string, dims: ImageDims): Promise<void>;
}

export function createDimsMemo(backend: DimsBackend): DimsMemo {
  const session = new Map<string, ImageDims>();
  /** Backend said null this session; a later `setDims` seeds `session`, checked first. */
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
      // Overwrites are harmless: same hash, same pixels.
      session.set(hash, dims);
      try {
        await backend.put(hash, dims);
      } catch {
        // Advisory: degrade to session-only.
      }
    },
  };
}

// Lazy, so importing this module never touches IndexedDB.
let shared: DimsMemo | null = null;
function memoInstance(): DimsMemo {
  return (shared ??= createDimsMemo(openDimsStore()));
}

/** Keyed by content hash (md5). */
export async function getDims(hash: string): Promise<ImageDims | null> {
  return memoInstance().getDims(hash);
}

export async function setDims(hash: string, dims: ImageDims): Promise<void> {
  return memoInstance().setDims(hash, dims);
}
