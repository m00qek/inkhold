// The one find-in-a-document session every viewer runs (a note, a PDF, a
// `.txt`): the query, its count, where the current match is, stepping, the
// typo-tolerant answer held behind an opt-in, and what to say when there is
// nothing to count. Each viewer brings a `FindSurface`: how it draws one
// segment's marks and brings a segment into view. A segment is a page (note,
// PDF) or a paragraph (`.txt`). The count is the index's, never the marks'.

import { dispatchApiFailure, type ApiFailureSink } from "../../api/errors";
import { DocumentTextPending, type DocSearch, type DocSearchResult } from "../../search/docSearch";

/** One matching segment, as the index counted it. */
export interface FindHit {
  readonly segment: number;
  readonly matches: number;
  /** Folded words to mark; a surface marks a word when its own fold is here. */
  readonly terms: readonly string[];
  /** `.txt` byte range in the raw file; null where the ordinal is the address. */
  readonly offset: number | null;
  readonly length: number | null;
}

/**
 * Never a total that revises itself (`counting` carries none), never "No
 * matches" for a search that did not happen (`unrecognised`, `pending`,
 * `textless`, `error`).
 */
export type FindState =
  | { kind: "idle" }
  /** A note the device never recognised: nothing was searched. */
  | { kind: "unrecognised" }
  /** In flight. `onThisPage` is the provisional guess on screen; `scope` the pages searched, when known. */
  | { kind: "counting"; onThisPage: number; scope: number | null }
  /** `at` is 0-based over the exact `total`; `partial` the segments searched when the text stops short. */
  | { kind: "settled"; at: number; total: number; fuzzy: boolean; partial: number | null }
  /** Exact found nothing and the typo ladder found something: offered, not shown. */
  | { kind: "fuzzyPrompt" }
  | { kind: "empty"; partial: number | null }
  /** The server has not extracted this document's text yet; asked again on its own. */
  | { kind: "pending" }
  /** Extracted, and there is no text at all: a scanned PDF, an empty file. */
  | { kind: "textless" }
  | { kind: "error" };

/** What a surface needs to draw the segment on screen. */
export interface PaintAsk {
  readonly query: string;
  /** The index's words for this segment; null before the count lands (a provisional guess, if the surface makes one). */
  readonly terms: readonly string[] | null;
  /** Which mark on this segment is the current match; -1 for none. */
  readonly current: number;
  /** Find moved to this match (a landing, a step): bring it into view if it's off-screen. A plain repaint never scrolls. */
  readonly reveal: boolean;
  /** True once a later query, page or close has superseded this paint. */
  stale(): boolean;
}

export interface FindSurface {
  setOpen(open: boolean): void;
  setState(state: FindState): void;
  /** False until the count lands: stepping an unknown set would step the wrong set. */
  setStepEnabled(enabled: boolean): void;
  focusField(): void;
  /** The hits as they land, `[]` to clear: page badges, or a `.txt`'s marked paragraphs. */
  setHits(hits: readonly FindHit[]): void;
  /** Bring `segment` into view; the viewer calls `setPage` once it is there. */
  showSegment(segment: number): void;
  /** Draw the marks on `segment`, the one on screen. Resolves to how many it drew, null when stale. */
  paint(segment: number, ask: PaintAsk): Promise<number | null>;
  clearMarks(): void;
}

export interface FindSessionOptions {
  docs: DocSearch;
  /** Where UNAUTHORIZED goes; never swallowed here. */
  failures: ApiFailureSink;
  surface: FindSurface;
  /** Before the count is asked for, ms. The first find on a document is a fetch plus an index build. */
  debounceMs?: number;
  /** A state that answers without searching (a note never recognised), or null to search. */
  gate?(): FindState | null;
  /** How many segments the search spans, for "searching 14 pages…"; null when unknown. */
  scope?(): number | null;
  /** Paint the segment on screen before the count lands (a note's substring guess). */
  provisional?: boolean;
  /** Where the server stops extracting (a PDF's first 5,000 pages); null when it never does. */
  extractsUpTo?: number | null;
  /** How often a document still being indexed is asked again while the bar is open, ms. */
  pendingRetryMs?: number;
  /** Hits the surface can place; the rest are neither counted nor stepped to (a `.txt` paragraph with no byte range). */
  placeable?(hit: FindHit): boolean;
}

export interface FindSession {
  isOpen(): boolean;
  /** `focus: false` for a find opened by a link, not by the person (no phone keyboard). */
  open(opts?: { focus?: boolean }): void;
  close(): void;
  toggle(): void;
  /** The trimmed query, for the URL. */
  query(): string;
  /** The document to search, and the segment on screen in it; reruns an open find. Null leaves find inert. */
  setDocument(md5: string | null, segment?: number): void;
  /** The segment on screen. */
  setPage(segment: number): void;
  setQuery(raw: string): void;
  step(dir: 1 | -1): void;
  /** Reveal the held typo-tolerant answer; asks nothing again. */
  searchSimilar(): void;
  /** Redraw the segment on screen (a zoom, a re-render). */
  repaint(): void;
  /** The segment holding the current match, or null. */
  currentSegment(): number | null;
  reset(): void;
}

const PENDING_RETRY_MS = 15_000;

function hitsOf(result: DocSearchResult, keep: (hit: FindHit) => boolean): FindHit[] {
  return result.segments.map((s): FindHit => ({
    segment: s.segment,
    matches: s.matches,
    terms: s.terms,
    offset: s.offset,
    length: s.length,
  })).filter(keep);
}

export function createFindSession(o: FindSessionOptions): FindSession {
  const { surface: view, failures } = o;
  const debounceMs = o.debounceMs ?? 220;
  const retryMs = o.pendingRetryMs ?? PENDING_RETRY_MS;
  const keep = o.placeable ?? ((): boolean => true);

  let open = false;
  let md5: string | null = null;
  let page = 0;
  /** The trimmed query pending, in flight or painted; makes `setQuery` idempotent. */
  let active: string | null = null;
  let query = "";

  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on every change of intent; an answer paints only if its token is current. */
  let token = 0;
  let runAbort: AbortController | null = null;

  let hits: FindHit[] = [];
  let landed = false;
  let fuzzy = false;
  /** A typo-tolerant answer held until the person opts in. */
  let heldFuzzy: FindHit[] | null = null;
  let optedIn = false;
  /** Segments searched when the text stops short of the document; null when whole. */
  let partial: number | null = null;
  /** 0-based current match over the whole document; -1 for none. */
  let at = -1;
  /** The next paint of the current match follows a move, so it is brought into view. */
  let reveal = false;

  const total = (): number => hits.reduce((n, h) => n + h.matches, 0);

  function locate(index: number): { segment: number; within: number } | null {
    if (index < 0) return null;
    let seen = 0;
    for (const h of hits) {
      if (index < seen + h.matches) return { segment: h.segment, within: index - seen };
      seen += h.matches;
    }
    return null;
  }

  function firstOn(segment: number): number {
    let seen = 0;
    for (const h of hits) {
      if (h.segment === segment) return seen;
      seen += h.matches;
    }
    return -1;
  }

  function clearPainted(): void {
    view.clearMarks();
    view.setHits([]);
    view.setStepEnabled(false);
  }

  /** Draws the segment on screen; before the count lands, also reports the provisional guess. */
  async function paintPage(): Promise<void> {
    if (!open || md5 === null || query === "" || (!landed && !o.provisional)) {
      view.clearMarks();
      return;
    }
    const mine = token;
    const here = page;
    const terms = landed ? (hits.find((h) => h.segment === here)?.terms ?? []) : null;
    let current = -1;
    if (!landed) current = 0;
    else {
      const where = locate(at);
      if (where && where.segment === here) current = where.within;
    }
    const revealing = reveal && current >= 0;
    const drawn = await view.paint(here, {
      query,
      terms,
      current,
      reveal: revealing,
      stale: () => mine !== token || !open || page !== here,
    });
    if (drawn !== null && revealing) reveal = false;
    if (drawn === null || mine !== token || landed) return;
    view.setState({ kind: "counting", onThisPage: drawn, scope: o.scope?.() ?? null });
  }

  /** Lands on the first match: one on the segment on screen if there is one. */
  function show(fuzzyAnswer: boolean): void {
    view.setHits(hits);
    const n = total();
    if (n === 0) {
      at = -1;
      view.setStepEnabled(false);
      view.setState({ kind: "empty", partial });
      void paintPage();
      return;
    }
    const here = firstOn(page);
    at = here >= 0 ? here : 0;
    reveal = true;
    view.setStepEnabled(n > 1);
    view.setState({ kind: "settled", at, total: n, fuzzy: fuzzyAnswer, partial });
    const where = locate(at);
    if (where && where.segment !== page) view.showSegment(where.segment);
    else void paintPage();
  }

  function apply(result: DocSearchResult, mine: number): void {
    if (mine !== token || !open) return;
    landed = true;
    partial = o.extractsUpTo != null && result.extent > o.extractsUpTo ? o.extractsUpTo : null;
    if (result.textless) {
      hits = [];
      view.setHits([]);
      view.setStepEnabled(false);
      view.setState({ kind: "textless" });
      void paintPage();
      return;
    }
    if (result.usedFuzzy && !optedIn) {
      hits = [];
      at = -1;
      view.setHits([]);
      view.setStepEnabled(false);
      const held = hitsOf(result, keep);
      heldFuzzy = held.length > 0 ? held : null;
      view.setState(heldFuzzy ? { kind: "fuzzyPrompt" } : { kind: "empty", partial });
      void paintPage();
      return;
    }
    hits = hitsOf(result, keep);
    fuzzy = result.usedFuzzy;
    show(fuzzy);
  }

  /** The abort covers only the text fetch; the index build is what the next keystroke needs anyway. */
  async function runSearch(doc: string, q: string, mine: number): Promise<void> {
    const ac = new AbortController();
    runAbort = ac;
    try {
      apply(await o.docs.search(doc, q, ac.signal), mine);
    } catch (e) {
      if (mine !== token) return;
      if (dispatchApiFailure(failures, e)) return;
      if (e instanceof DocumentTextPending) {
        view.setState({ kind: "pending" });
        // The live channel refreshes the manifest; this asks again on its own.
        timer = setTimeout(() => {
          timer = undefined;
          if (mine === token && open) void runSearch(doc, q, mine);
        }, retryMs);
        return;
      }
      view.setState({ kind: "error" });
    }
  }

  function cancelPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    runAbort?.abort();
    runAbort = null;
    token++;
  }

  /** `now`: not a keystroke (the document arrived, the bar reopened), so no wait for typing to pause. */
  function runQuery(raw: string, now = false): void {
    query = raw.trim();
    cancelPending();
    hits = [];
    landed = false;
    fuzzy = false;
    heldFuzzy = null;
    optedIn = false;
    partial = null;
    at = -1;
    reveal = false;

    const gated = o.gate?.() ?? null;
    if (gated) {
      clearPainted();
      view.setState(gated);
      return;
    }
    if (query === "") {
      clearPainted();
      view.setState({ kind: "idle" });
      return;
    }
    view.setHits([]);
    view.setStepEnabled(false);
    view.setState({ kind: "counting", onThisPage: 0, scope: o.scope?.() ?? null });
    void paintPage();

    const doc = md5;
    if (doc === null) return;
    const mine = token;
    const q = query;
    if (now) {
      void runSearch(doc, q, mine);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void runSearch(doc, q, mine);
    }, debounceMs);
  }

  function openBar(opts?: { focus?: boolean }): void {
    if (!open) {
      open = true;
      view.setOpen(true);
    }
    // Ctrl+F on an open bar re-focuses.
    if (opts?.focus !== false) view.focusField();
    // Fetches nothing for an empty query; re-run so a gate speaks before any keystroke.
    active = null;
    runQuery(query, true);
  }

  function closeBar(): void {
    if (!open) return;
    open = false;
    cancelPending();
    view.setOpen(false);
    clearPainted();
  }

  return {
    isOpen: () => open,
    open: openBar,
    close: closeBar,
    // Not `this.close()`: callers destructure the session.
    toggle: () => (open ? closeBar() : openBar()),
    query: () => query,

    setDocument(next, segment) {
      md5 = next;
      if (segment !== undefined) page = segment;
      if (open) runQuery(query, true);
    },

    setPage(segment) {
      page = segment;
      if (open) void paintPage();
    },

    setQuery(raw) {
      const q = raw.trim();
      if (q === active) return; // the same question: leave the answer in progress alone
      active = q;
      runQuery(raw);
    },

    step(dir) {
      const n = total();
      if (!landed || n === 0) return; // nothing to step, or not knowably so yet
      at = (at + dir + n) % n;
      reveal = true;
      view.setState({ kind: "settled", at, total: n, fuzzy, partial });
      const where = locate(at);
      if (!where) return;
      if (where.segment !== page) view.showSegment(where.segment);
      else void paintPage();
    },

    searchSimilar() {
      if (heldFuzzy === null || !open) return;
      optedIn = true;
      hits = heldFuzzy;
      heldFuzzy = null;
      fuzzy = true;
      show(true);
    },

    repaint() {
      if (open) void paintPage();
    },

    currentSegment: () => (open ? (locate(at)?.segment ?? null) : null),

    reset() {
      open = false;
      md5 = null;
      page = 0;
      active = null;
      query = "";
      hits = [];
      landed = false;
      fuzzy = false;
      heldFuzzy = null;
      optedIn = false;
      partial = null;
      at = -1;
      cancelPending();
      view.setOpen(false);
      clearPainted();
      view.setState({ kind: "idle" });
    },
  };
}

/** What the counter says, for every viewer. `noun` names the document ("note", "file"). */
export function findCountText(state: FindState, noun: string, textless: string): string {
  const pages = (n: number): string => `${n.toLocaleString("en")} ${n === 1 ? "page" : "pages"}`;
  switch (state.kind) {
    case "idle":
      return "";
    case "unrecognised":
      return "Not recognised on the device";
    case "counting": {
      const here = (state.onThisPage ?? 0) > 0 ? `${state.onThisPage} on this page · ` : "";
      const searching = state.scope == null ? "searching…" : `searching ${pages(state.scope)}…`;
      const line = `${here}${searching}`;
      return line.charAt(0).toUpperCase() + line.slice(1);
    }
    case "settled":
      return `${state.at + 1} of ${state.total}${state.partial == null ? "" : ` · first ${pages(state.partial)}`}`;
    case "fuzzyPrompt":
      return "No matches";
    case "empty":
      return state.partial == null ? "No matches" : `No matches in the first ${pages(state.partial)}`;
    case "pending":
      return `This ${noun} is still being indexed — matches will appear on their own.`;
    case "textless":
      return textless;
    case "error":
      return `Couldn't search this ${noun}. Keep typing to retry.`;
  }
}

/** The dimmer treatment: every state that is not a live count of matches. */
export function findCountIsNone(state: FindState): boolean {
  return state.kind !== "settled" && state.kind !== "idle";
}
