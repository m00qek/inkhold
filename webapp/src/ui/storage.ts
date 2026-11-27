// localStorage that cannot break boot: access can throw (Safari private mode,
// blocked cookies raise SecurityError; writes can raise QuotaExceededError), so
// a failure degrades to "no stored preference".

function backing(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The stored string, or null when absent or storage is unavailable. */
export function readLocal(key: string): string | null {
  try {
    return backing()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Best-effort persist. A failure is silent: the value still applies this session. */
export function writeLocal(key: string, value: string): void {
  try {
    backing()?.setItem(key, value);
  } catch {
    /* private mode, disabled storage, or over quota */
  }
}

export const SORT_KEY = "sn.sort";

/**
 * What this browser's search reads the text of (`ui/searchScope.ts`). The
 * browser's preference, not the person's: it stays at sign-out, like the sort.
 */
export const SEARCH_SCOPE_KEY = "sn.search-scope";
