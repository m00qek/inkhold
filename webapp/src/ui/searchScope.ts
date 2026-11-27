// The search scope as this browser keeps it: one JSON object in localStorage
// (`sn.search-scope`), each kind a boolean, beside the other preferences of
// the device (theme, sort), so it survives sign-out (`cache/forget.ts` clears
// only the person's keys). Anything missing, malformed or unreadable is the
// default, everything searched. Another tab's change arrives through the
// `storage` event; this tab's own through `set`, which the event never reports.

import { FULL_SCOPE, SCOPE_KINDS, sameScope, type ScopeKind, type SearchScope } from "../search/searchScope";
import { SEARCH_SCOPE_KEY, readLocal, writeLocal } from "./storage";

/** Pure. A stored value, as written by `formatScope`; each unreadable kind takes its default. */
export function parseScope(raw: string | null): SearchScope {
  let stored: unknown = null;
  try {
    stored = raw === null ? null : JSON.parse(raw);
  } catch {
    return FULL_SCOPE;
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return FULL_SCOPE;
  const out = { ...FULL_SCOPE } as Record<ScopeKind, boolean>;
  for (const kind of SCOPE_KINDS) {
    const on = (stored as Record<string, unknown>)[kind];
    if (typeof on === "boolean") out[kind] = on;
  }
  return out;
}

/** Pure. The stored spelling: every kind, so a reader of any version sees them all. */
export function formatScope(scope: SearchScope): string {
  return JSON.stringify(Object.fromEntries(SCOPE_KINDS.map((kind) => [kind, scope[kind]])));
}

export interface SearchScopeSetting {
  /** The scope now. */
  get(): SearchScope;
  /** Turns one kind on or off, here and in every tab. A write storage refuses still holds for this visit. */
  set(kind: ScopeKind, on: boolean): void;
  /** Called with the new scope on each change, from this tab or another. Returns the unsubscribe. */
  subscribe(listener: (scope: SearchScope) => void): () => void;
  /** Stops listening to other tabs: the shell's teardown, or each sign-in cycle adds one. */
  dispose(): void;
}

export interface SearchScopeSeams {
  read(key: string): string | null;
  write(key: string, value: string): void;
  /** Where another tab's `storage` events arrive. */
  events: Pick<EventTarget, "addEventListener" | "removeEventListener">;
}

const browserSeams = (): SearchScopeSeams => ({ read: readLocal, write: writeLocal, events: window });

export function createSearchScopeSetting(seams: SearchScopeSeams = browserSeams()): SearchScopeSetting {
  let scope = parseScope(seams.read(SEARCH_SCOPE_KEY));
  const listeners = new Set<(scope: SearchScope) => void>();

  function changeTo(next: SearchScope): void {
    if (sameScope(next, scope)) return;
    scope = next;
    for (const listener of listeners) listener(scope);
  }

  const onStorage = (e: Event) => {
    const key = (e as StorageEvent).key;
    // A null key is `localStorage.clear()` in another tab: back to the default.
    if (key === SEARCH_SCOPE_KEY || key === null) changeTo(parseScope(seams.read(SEARCH_SCOPE_KEY)));
  };
  seams.events.addEventListener("storage", onStorage);

  return {
    get: () => scope,
    set(kind, on) {
      const next = { ...scope, [kind]: on };
      seams.write(SEARCH_SCOPE_KEY, formatScope(next));
      changeTo(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      seams.events.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}
