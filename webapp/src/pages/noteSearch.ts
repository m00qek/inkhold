// The transcript half of the library search box: debounce, staleness and
// failure logic, with the DOM injected as a `SearchView`. Every run carries a
// token; a response whose token has moved on is dropped, not painted.

import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import { NO_ITEM_HITS, type Expansion, type ItemHits, type LocalHit, type LocalSearch } from "../search/localSearch";

/**
* One or two characters match nearly the whole index (the expensive case).
* Library-wide only; in-document find accepts one character.
*/
export const MIN_GLOBAL_QUERY_LEN = 3;

/**
* Debounce, ms. A query costs a frame (a `con*` expansion measured 37.9 ms), so
* this sits under the ~150 ms "immediate" line while swallowing a typed burst.
*/
export const DEFAULT_DEBOUNCE_MS = 120;

/** "Asking", "none" and "failed" stay distinct from an empty list. */
export type SearchState =
  | { kind: "idle" }
  | { kind: "searching"; query: string }
  | {
      kind: "results";
      query: string;
      /** One row per document, ranked by `rankDocuments`; no `totalPages` (see `searchCountLabel`). */
      documents: readonly LocalHit[];
      /** What the typo ladder substituted, per token rather than per document. */
      expansions: readonly Expansion[];
      /** The matching names, to-dos and digests, by kind. */
      items: ItemHits;
      /** Kept for a quoted phrase without being checked (`LocalResults.unchecked`). */
      unchecked?: number;
    }
  | { kind: "error"; query: string };

export interface SearchView {
  setState(state: SearchState): void;
}

export interface NoteSearchDeps {
  view: SearchView;
  search?: LocalSearch;
  /** Where UNAUTHORIZED goes; an expired session must not read as "no results". */
  failures: ApiFailureSink;
  debounceMs?: number;
}

export interface NoteSearchController {
  setQuery(raw: string): void;
  /** Asks the query on screen again (what it searches changed), leaving its answer up until the new one. */
  again(): void;
  reset(): void;
}

export const noLocalSearch: LocalSearch = {
  ready: false,
  search: (query) => Promise.resolve({ query, totalPages: 0, documents: [], expansions: [], items: NO_ITEM_HITS }),
};

export function createNoteSearch(deps: NoteSearchDeps): NoteSearchController {
  const { view, failures } = deps;
  const engine = deps.search ?? noLocalSearch;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;

  let token = 0;

  /** The trimmed query pending, running or painted; makes `setQuery` idempotent. */
  let active: string | null = null;

  /** Aborted when superseded, so an engine honouring the signal stops the work. */
  let inflight: AbortController | null = null;

  function cancelPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    token++;
    inflight?.abort();
    inflight = null;
  }

  async function run(query: string, mine: number): Promise<void> {
    const ac = new AbortController();
    inflight = ac;
    try {
      const results = await engine.search(query, ac.signal);
      if (mine !== token) return; // a later keystroke superseded us — drop it
      view.setState({
        kind: "results",
        query,
        documents: results.documents,
        expansions: results.expansions,
        items: results.items,
        // Only a phrase search that couldn't check everything says so.
        ...(results.unchecked ? { unchecked: results.unchecked } : {}),
      });
    } catch (e) {
      if (mine !== token) return;
      if (dispatchApiFailure(failures, e)) return;
      view.setState({ kind: "error", query });
    }
  }

  return {
    setQuery(raw: string): void {
      const query = raw.trim();
      if (query === active) return; // same question; leave the answer in progress alone
      active = query;
      cancelPending();

      if (query.length < MIN_GLOBAL_QUERY_LEN) {
        view.setState({ kind: "idle" });
        return;
      }

      // Announced on the keystroke, run after the pause.
      view.setState({ kind: "searching", query });
      const mine = token;
      timer = setTimeout(() => {
        timer = undefined;
        void run(query, mine);
      }, debounceMs);
    },

    again(): void {
      if (active === null || active.length < MIN_GLOBAL_QUERY_LEN) return;
      const query = active;
      cancelPending();
      void run(query, token);
    },

    reset(): void {
      active = null;
      cancelPending();
      view.setState({ kind: "idle" });
    },
  };
}

// ---- what the ladder substituted ----

/**
* Groups expansions per typed token. A two-word group is a distance tie
* (alternatives, joined with "or"). Shared by the notice and the deep link.
*/
function groupExpansions(expansions: readonly Expansion[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const e of expansions) {
    const held = groups.get(e.typed);
    if (held) {
      if (!held.includes(e.matched)) held.push(e.matched);
    } else groups.set(e.typed, [e.matched]);
  }
  return groups;
}

/** Parts, not markup: both halves are device-authored text, so no `innerHTML`. */
export interface ExpansionPart {
  readonly text: string;
  readonly matched?: boolean;
}

/**
* "Matched **valen** or **valjean** instead of “valjen”." Says only what was
* substituted, never "no matches for", since name matches may sit below.
* `null` when nothing was.
*/
export function expansionNotice(expansions: readonly Expansion[]): ExpansionPart[] | null {
  const groups = groupExpansions(expansions);
  if (groups.size === 0) return null;

  const parts: ExpansionPart[] = [{ text: "Matched " }];
  const entries = [...groups];
  for (const [i, [typed, terms]] of entries.entries()) {
    for (const [j, term] of terms.entries()) {
      if (j > 0) parts.push({ text: j === terms.length - 1 ? " or " : ", " });
      parts.push({ text: term, matched: true });
    }
    parts.push({ text: ` instead of “${typed}”` });
    if (i < entries.length - 1) parts.push({ text: i === entries.length - 2 ? ", and " : ", " });
  }
  parts.push({ text: "." });
  return parts;
}

// ---- the query a deep link carries ----

/**
* The typed query with each unambiguously corrected token replaced, so the
* viewer's find matches what the row claimed. A tie travels as typed (picking
* one would invent a fact); name-only rows get no expansions from the caller.
* `Expansion.typed` is the raw token, so in-place substitution keeps spacing
* and case.
*/
export function deepLinkQuery(typed: string, expansions: readonly Expansion[] = []): string {
  if (expansions.length === 0) return typed;
  const groups = groupExpansions(expansions);
  return typed
    .split(/(\s+)/)
    .map((token) => {
      const terms = groups.get(token);
      return terms && terms.length === 1 ? terms[0]! : token;
    })
    .join("");
}

/**
* Counts pages (or `.txt` paragraphs, per `kind`), never matches: the
* per-document match tally is find's to give. `null` for a name-only match.
*/
export function pageSummary(pages: number, kind = 0): string | null {
  if (pages < 1) return null;
  if (kind === 1) return `Matches in ${pages} ${pages === 1 ? "paragraph" : "paragraphs"}`;
  return `Matches on ${pages} ${pages === 1 ? "page" : "pages"}`;
}

/** Unquantified: nothing counts the unsearchable at query time. */
export function coverageLine(): string {
  return "Only notes recognised on the device are searchable.";
}

function documents(n: number): string {
  return `${n} ${n === 1 ? "document is" : "documents are"} still being indexed`;
}

/** Kept apart from `coverageLine` (text that will never exist). */
export function pendingLine(pending: number): string | null {
  if (pending <= 0) return null;
  return `${documents(pending)} — matches in them will appear on their own.`;
}

/**
* Over a non-empty list: a document still being derived isn't in the index
* yet, so the list is not yet everything. Count from `event: index`.
*/
export function resultsMayGrowLine(pending: number): string | null {
  if (pending <= 0) return null;
  return `More may appear — ${documents(pending)}.`;
}
