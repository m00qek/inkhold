// localStorage that cannot break boot.
//
// `localStorage` can *throw on access*, not merely return null: Safari's private
// mode and Chrome's "block all cookies" both raise a SecurityError when the
// property is read, and a write can raise QuotaExceededError. An unguarded read
// at module scope therefore takes the whole app down before it paints. Every
// preference we keep (`sn.mode`, `sn.theme`) goes through here, and a failure
// degrades to "no stored preference" rather than an exception.

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
    /* private mode, disabled storage, or over quota — nothing we can do or should say */
  }
}

/** The pinned gallery sort order. Read by `library.ts` at construction. */
export const SORT_KEY = "sn.sort";
