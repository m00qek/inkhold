// What a signed-in person leaves in this browser, and its removal at sign-out
// or when the session expires (#17): every IndexedDB database built from
// their library, and the one localStorage entry about their files. The
// device's own preferences (theme, sort, a `.txt`'s font and zoom) stay.
// Beside it: the service worker's stored listings (`forgetListings`), the
// browser's HTTP cache (the server's `Clear-Site-Data` at sign-out), and what
// is in memory (the app reloads into the sign-in page).
//
// A database is deleted only once every open connection to it closes; the
// stores close theirs when asked (`idbLife.ts`). One that does not, in a tab
// still running an older build, holds the delete back: it then stays queued,
// and the browser completes it when that tab goes.

import { DIMS_DB, NOCOVER_DB, THUMBS_DB } from "./idb";
import { TERMS_DB } from "./termsStore";
import { TEXT_DB } from "./textStore";
import { REFUSALS_KEY } from "../search/textPrefetch";

/** Every database that holds something of the person's library. */
export const PERSON_DATABASES: readonly string[] = [TERMS_DB, TEXT_DB, THUMBS_DB, DIMS_DB, NOCOVER_DB];

/** localStorage entries about the person's files, not the device's preferences. */
export const PERSON_KEYS: readonly string[] = [REFUSALS_KEY];

export interface ForgetSeams {
  /** Null where IndexedDB is unavailable (a private window may refuse it). */
  idb: Pick<IDBFactory, "deleteDatabase"> | null;
  storage: Pick<Storage, "removeItem"> | null;
  /** How long a delete held back by an open connection is waited for. */
  blockedMs: number;
}

/** `read`, or null where it is missing or its access throws (storage blocked by the browser). */
function guarded<T>(read: () => T | undefined): T | null {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

function browserSeams(): ForgetSeams {
  return {
    idb: guarded(() => (typeof indexedDB === "undefined" ? undefined : indexedDB)),
    storage: guarded(() => (typeof localStorage === "undefined" ? undefined : localStorage)),
    blockedMs: 2000,
  };
}

/** Resolves once the delete finished or failed, or after `blockedMs` held back; never rejects. */
function deleteDatabase(idb: Pick<IDBFactory, "deleteDatabase">, name: string, blockedMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    try {
      const req = idb.deleteDatabase(name);
      req.onsuccess = done;
      req.onerror = done;
      // Still queued: sign-out goes on, and the browser finishes it later.
      req.onblocked = () => {
        timer ??= setTimeout(done, blockedMs);
      };
    } catch {
      done();
    }
  });
}

/** Removes everything of the signed-in person's from this browser's storage. Never rejects. */
export async function forgetPerson(seams: ForgetSeams = browserSeams()): Promise<void> {
  for (const key of PERSON_KEYS) {
    try {
      seams.storage?.removeItem(key);
    } catch {
      // A storage that throws holds nothing to remove.
    }
  }
  const idb = seams.idb;
  if (idb) await Promise.all(PERSON_DATABASES.map((name) => deleteDatabase(idb, name, seams.blockedMs)));
}
