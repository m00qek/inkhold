// The last to-dos and digests the server sent, kept so search finds them
// offline (#18), as it finds notes from their stored text. Only search reads
// them: the To-Do and Digest pages still come from the server. One record per
// kind, replaced whole. Removed at sign-out (`forget.ts`). Degrades to a
// silent no-op store, like the others.

import { yieldOnVersionChange } from "./idbLife";

export const ITEMS_DB = "sn-search-items";
const VERSION = 1;
const STORE = "items";

/** What is kept: the pages' own snapshots. */
export type StoredKind = "todo" | "digest";

export interface ItemStore {
  get<T>(kind: StoredKind): Promise<T | null>;
  put(kind: StoredKind, value: unknown): Promise<void>;
}

const nullStore: ItemStore = {
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(),
};

export function openItemStore(dbName: string = ITEMS_DB): ItemStore {
  if (typeof indexedDB === "undefined") return nullStore;
  const db: Promise<IDBDatabase | null> = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(dbName, VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    open.onsuccess = () => resolve(yieldOnVersionChange(open.result));
    open.onerror = () => reject(open.error);
  }).catch(() => null);

  /** One request in its own transaction; any failure (a closed connection too) is the fallback. */
  async function run<T>(mode: IDBTransactionMode, ask: (s: IDBObjectStore) => IDBRequest, fallback: T): Promise<T> {
    const d = await db;
    if (!d) return fallback;
    return new Promise<T>((resolve) => {
      try {
        const req = ask(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve((req.result as T | undefined) ?? fallback);
        req.onerror = () => resolve(fallback);
      } catch {
        resolve(fallback);
      }
    });
  }

  return {
    get: <T>(kind: StoredKind) => run<T | null>("readonly", (s) => s.get(kind), null),
    put: (kind, value) => run<unknown>("readwrite", (s) => s.put(value, kind), null).then(() => undefined),
  };
}
